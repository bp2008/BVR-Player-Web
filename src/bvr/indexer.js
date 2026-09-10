import { Growable } from './growable.js'
import { ScanReader } from './scanReader.js'
import { walkFrames } from './frameWalk.js'
import { FLAG_ISKEY, FLAG_MARK } from './constants.js'

const SCAN_CHUNK = 16 << 20
const SCAN_DEPTH = 3
const PROGRESS_STEP = 16 << 20

/**
 * Hands the event loop a turn so the progress bar can actually paint.
 *
 * With reads running ahead, most chunk boundaries resolve from an
 * already-settled promise, and awaiting one of those only drains the microtask
 * queue -- rendering never gets a look in, and the scan would appear to hang.
 * A message-channel task is the cheapest real turn on offer; setTimeout would
 * charge the 4 ms clamp every time.
 */
function makeYield () {
  if (typeof MessageChannel !== 'function') {
    return () => new Promise((resolve) => setTimeout(resolve, 0))
  }
  const ch = new MessageChannel()
  return () => new Promise((resolve) => {
    ch.port1.onmessage = () => resolve()
    ch.port2.postMessage(0)
  })
}

function newStreamAccumulator () {
  return {
    offset: new Growable(Float64Array),
    size: new Growable(Uint32Array),
    ts: new Growable(Float64Array),
    utc: new Growable(Float64Array),
    flags: new Growable(Uint16Array),
    // Two more typed arrays per stream, four bytes each per frame. They are what
    // lets an overlay object's draw conditions (spec 7.1 `stateflags` / `dio`)
    // be evaluated against any frame without going back to the file.
    dio: new Growable(Uint32Array),
    state: new Growable(Uint32Array)
  }
}

function finishStream (acc) {
  const count = acc.offset.length
  const s = {
    count,
    offset: acc.offset.toTyped(),
    size: acc.size.toTyped(),
    ts: acc.ts.toTyped(),
    utc: acc.utc.toTyped(),
    flags: acc.flags.toTyped(),
    dio: acc.dio.toTyped(),
    state: acc.state.toTyped(),
    keyIdx: new Int32Array(count),
    keys: null
  }
  const keys = new Growable(Int32Array)
  let last = -1
  for (let i = 0; i < count; i++) {
    if (s.flags[i] & FLAG_ISKEY) {
      last = i
      keys.push(i)
    }
    s.keyIdx[i] = last
  }
  s.keys = keys.toTyped()
  return s
}

/**
 * Scans the whole file once and builds a complete frame table (spec section 9.5
 * describes this as the alternative to interpolate-and-search; for a file the
 * platform hands over at disk speed it is both simpler and strictly better,
 * because every seek becomes exact).
 *
 * A recording reached over the network is the case this is wrong for, and
 * `src/bvr/streamingIndex.js` is what covers it: there the whole file is what
 * cannot be afforded, so a stretch at a time is indexed instead. Both walk the
 * chain through `frameWalk.js`; only what they keep, and how far they go,
 * differs.
 */
export async function buildIndex (reader, header, { onProgress, shouldStop } = {}) {
  const fileSize = reader.size
  const streams = [newStreamAccumulator(), newStreamAccumulator()]
  const audio = {
    offset: new Growable(Float64Array),
    size: new Growable(Uint32Array),
    ts: new Growable(Float64Array)
  }
  const metadata = []
  const marks = []

  const sink = {
    video (si, payloadPos, datasize, timestamp, utc, flags, dio, stateBits) {
      const acc = streams[si]
      acc.offset.push(payloadPos)
      acc.size.push(datasize)
      acc.ts.push(timestamp)
      acc.utc.push(utc)
      acc.flags.push(flags)
      acc.dio.push(dio)
      acc.state.push(stateBits)
      if (flags & FLAG_MARK) marks.push({ stream: si, idx: acc.offset.length - 1, ts: timestamp, utc })
    },
    audio (payloadPos, datasize, timestamp) {
      audio.offset.push(payloadPos)
      audio.size.push(datasize)
      audio.ts.push(timestamp)
    },
    metadata (payloadPos, datasize, subtype, timestamp, utc) {
      metadata.push({ offset: payloadPos, size: datasize, subtype, ts: timestamp, utc })
    }
  }

  const scan = new ScanReader(reader.blob, { chunkSize: SCAN_CHUNK, depth: SCAN_DEPTH })
  let totalFrames = 0
  let resyncs = 0
  let truncated = false

  try {
    const walked = await walkFrames(scan, {
      from: header.firstFrameOffset,
      fileSize,
      reader,
      sink,
      shouldStop,
      onProgress: onProgress ? (pos) => onProgress(pos / fileSize) : null,
      progressStep: PROGRESS_STEP,
      yieldToUi: makeYield()
    })
    totalFrames = walked.frames
    resyncs = walked.resyncs
    truncated = walked.truncated
  } finally {
    scan.release()
  }

  const main = finishStream(streams[0])
  const sub = finishStream(streams[1])

  // Spec 4.3: a file may carry only the sub stream even without the header flag.
  if (main.count === 0 && sub.count > 0 && !header.bmih[1]) {
    header.bmih[1] = header.bmih[0]
    header.hasSubHeader = true
  }

  const baseTs = firstTimestamp(main, sub)
  rebase(main, baseTs)
  rebase(sub, baseTs)

  const audioTs = audio.ts.toTyped()
  for (let i = 0; i < audioTs.length; i++) audioTs[i] -= baseTs

  const lastMain = main.count ? main.ts[main.count - 1] : -Infinity
  const lastSub = sub.count ? sub.ts[sub.count - 1] : -Infinity
  const durationMs = Math.max(0, Math.max(lastMain, lastSub))

  const startUtc = firstUtcOf([main, sub])
  const endUtc = lastUtc(main, sub)

  if (onProgress) onProgress(1)

  return {
    totalFrames,
    streams: [main, sub],
    audio: {
      count: audioTs.length,
      offset: audio.offset.toTyped(),
      size: audio.size.toTyped(),
      ts: audioTs
    },
    metadata,
    marks,
    baseTs,
    durationMs,
    startUtc,
    endUtc,
    truncated,
    resyncs,
    switchingMode: header.switchingMode
  }
}

function rebase (s, baseTs) {
  for (let i = 0; i < s.count; i++) s.ts[i] -= baseTs
}

function firstTimestamp (main, sub) {
  const a = main.count ? main.ts[0] : Infinity
  const b = sub.count ? sub.ts[0] : Infinity
  const v = Math.min(a, b)
  return Number.isFinite(v) ? v : 0
}

/**
 * The wall-clock moment media time zero corresponds to.
 *
 * It has to be the UTC of the *earliest* frame, not of the first stream that
 * happens to have one. The ordinary Blue Iris arrangement -- sub stream running
 * the whole hour, main stream written only while something moves -- puts the
 * main stream's first frame well into the recording, and taking its UTC as the
 * origin made every wall-clock reading that far fast. On one hour-long sample
 * here the two differ by thirty-five minutes.
 *
 * This is the same frame that settles `baseTs`, so the relative clock and the
 * absolute one agree by construction. Exported because the streaming index has
 * to reach the identical answer from a window rather than a whole file, and two
 * copies of this rule would eventually stop matching.
 *
 * Takes any array-likes with `count`, `ts` and `utc`, which is what both index
 * builders have to offer at the point they need it.
 */
export function firstUtcOf (streams) {
  let bestTs = Infinity
  let utc = 0
  for (const s of streams) {
    // Per stream, the first frame that carries a UTC at all: spec 11.3 allows
    // the field to be 0 on frames flushed at close, and a leading run of those
    // says nothing about when the stream started.
    for (let i = 0; i < s.count; i++) {
      if (s.utc[i] <= 0) continue
      if (s.ts[i] < bestTs) { bestTs = s.ts[i]; utc = s.utc[i] }
      break
    }
  }
  return utc
}

function lastUtc (main, sub) {
  let best = 0
  for (const s of [main, sub]) {
    for (let i = s.count - 1; i >= 0; i--) {
      if (s.utc[i] > 0) { best = Math.max(best, s.utc[i]); break }
    }
  }
  return best
}

/** Largest index i with s.ts[i] <= t, or 0 when t precedes the stream. */
export function frameIndexForTime (s, t) {
  if (s.count === 0) return -1
  let lo = 0
  let hi = s.count - 1
  if (t <= s.ts[0]) return 0
  if (t >= s.ts[hi]) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (s.ts[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}
