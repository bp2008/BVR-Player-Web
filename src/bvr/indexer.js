import { Growable } from './growable.js'
import { readFrameHeader } from './parseFileHeader.js'
import { ScanReader } from './scanReader.js'
import {
  FLAG_ISAUDIO, FLAG_ISMETADATA, FLAG_ISHEADER, FLAG_ISKEY, FLAG_SUBSTREAM,
  FLAG_STREAMFLAGS, FLAG_MARK, FRAME_HEADER_SIZE, SIGNATURE
} from './constants.js'

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
    flags: new Growable(Uint16Array)
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
 * describes this as the alternative to interpolate-and-search; for local files
 * it is both simpler and strictly better because every seek becomes exact).
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

  const scan = new ScanReader(reader.blob, { chunkSize: SCAN_CHUNK, depth: SCAN_DEPTH })
  const yieldToUi = makeYield()
  let pos = header.firstFrameOffset
  let totalFrames = 0
  let resyncs = 0
  let truncated = false
  let nextProgress = pos + PROGRESS_STEP

  try {
    while (pos + FRAME_HEADER_SIZE <= fileSize) {
      if (shouldStop && shouldStop()) break

      const need = Math.min(32, fileSize - pos)
      let at = scan.offsetOf(pos, need)
      if (at < 0) {
        await scan.seek(pos)
        at = scan.offsetOf(pos, need)
        if (at < 0) break
      }

      // The frame header is read inline rather than through readFrameHeader():
      // this loop runs once per frame, and at a few hundred thousand frames an
      // hour the per-frame record object -- and the BigInt a getBigUint64 would
      // mint for the UTC field -- are worth not allocating.
      const view = scan.view
      if (view.getUint32(at, true) !== SIGNATURE) {
        const found = await resync(reader, fileSize, pos)
        if (found < 0) { truncated = true; break }
        resyncs++
        pos = found
        continue
      }
      const flags = view.getUint16(at + 4, true)
      const postbytes = view.getUint16(at + 6, true)
      const timestamp = view.getUint32(at + 8, true)
      const datasize = view.getUint32(at + 12, true)

      const payloadPos = pos + FRAME_HEADER_SIZE + postbytes
      const next = payloadPos + datasize
      if (next > fileSize) { truncated = true; break }

      let utc = 0
      if (postbytes >= 16 && at + 32 <= view.byteLength) {
        // Split 64-bit read: unix-ms sits far below 2^53, so this stays exact.
        utc = view.getUint32(at + 20, true) * 4294967296 + view.getUint32(at + 16, true)
      }

      if (flags & FLAG_ISHEADER) {
        // Extra header frames are not expected mid-file; skip per spec section 9.4.
      } else if (flags & FLAG_ISMETADATA) {
        metadata.push({ offset: payloadPos, size: datasize, subtype: flags >> 8, ts: timestamp, utc })
      } else if (flags & FLAG_ISAUDIO) {
        audio.offset.push(payloadPos)
        audio.size.push(datasize)
        audio.ts.push(timestamp)
      } else {
        const si = (flags & FLAG_STREAMFLAGS) === FLAG_SUBSTREAM ? 1 : 0
        const acc = streams[si]
        acc.offset.push(payloadPos)
        acc.size.push(datasize)
        acc.ts.push(timestamp)
        acc.utc.push(utc)
        acc.flags.push(flags)
        if (flags & FLAG_MARK) marks.push({ stream: si, idx: acc.offset.length - 1, ts: timestamp, utc })
      }

      totalFrames++
      pos = next

      if (pos >= nextProgress) {
        nextProgress = pos + PROGRESS_STEP
        if (onProgress) onProgress(pos / fileSize)
        await yieldToUi()
      }
    }
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

  const startUtc = firstUtc(main, sub)
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

function firstUtc (main, sub) {
  for (const s of [main, sub]) {
    for (let i = 0; i < s.count; i++) if (s.utc[i] > 0) return s.utc[i]
  }
  return 0
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

/**
 * Corruption recovery (spec section 10): hunt forward for the next "BLUE" whose
 * frame is complete and is itself followed by a plausible frame.
 */
async function resync (reader, fileSize, from) {
  const WINDOW = 1 << 20
  let at = from + 1
  while (at + FRAME_HEADER_SIZE <= fileSize) {
    const len = Math.min(WINDOW, fileSize - at)
    // Own copy: the nested look-ahead read below would invalidate a shared view.
    const bytes = await reader.readCopy(at, len)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i + FRAME_HEADER_SIZE <= len; i++) {
      if (view.getUint32(i, true) !== SIGNATURE) continue
      const hdr = readFrameHeader(view, i)
      const abs = at + i
      const end = abs + FRAME_HEADER_SIZE + hdr.postbytes + hdr.datasize
      if (end > fileSize) continue
      if (end === fileSize) return abs
      const nextView = await reader.read(end, 4)
      if (nextView.getUint32(0, true) === SIGNATURE) return abs
    }
    at += Math.max(1, len - FRAME_HEADER_SIZE)
  }
  return -1
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
