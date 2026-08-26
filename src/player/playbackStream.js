import {
  FLAG_ISKEY, FLAG_ISDISCONTINUITY, STREAM_MAIN, STREAM_SUB
} from '../bvr/constants.js'
import { planRuns, planSegments } from './coverage.js'

/** Which streams hold frames and can actually be decoded on this device. */
function usableStreams (index, playable) {
  return [
    index.streams[STREAM_MAIN].count > 0 && playable[STREAM_MAIN] !== false,
    index.streams[STREAM_SUB].count > 0 && playable[STREAM_SUB] !== false
  ]
}

/**
 * The mode that will actually be used, which is not always the one asked for:
 * a stored preference for a stream this device cannot decode has to give way to
 * one it can. Returns the requested mode unchanged when nothing is playable, so
 * the caller can report that on its own terms.
 */
export function resolveStreamMode (index, playable, requested) {
  const usable = usableStreams(index, playable)
  if (!usable[STREAM_MAIN] && !usable[STREAM_SUB]) return requested
  if (requested === 'main' && !usable[STREAM_MAIN]) return 'auto'
  if (requested === 'sub' && !usable[STREAM_SUB]) return 'auto'
  return requested
}

/**
 * The playable streams in the order `auto` prefers them: biggest picture first.
 *
 * Resolution rather than "main, then sub", because "main" is a label for where a
 * stream sits in the file and not a promise about what is in it. Nothing stops a
 * recording from carrying the larger picture on the sub stream, and a viewer who
 * asked for automatic wants the better picture wherever it happens to live. Ties
 * go to the main stream, which is what the label means when the two are equal.
 */
function rankStreams (index, header, sizes, usable) {
  const ranked = []
  for (const si of [STREAM_MAIN, STREAM_SUB]) if (usable[si]) ranked.push(si)
  return ranked.sort((a, b) => {
    const A = sizeOf(header, sizes, a)
    const B = sizeOf(header, sizes, b)
    return (B.width * B.height) - (A.width * A.height) || a - b
  })
}

/**
 * What `auto` would play, worked out once: the streams in preference order, the
 * runs of frames the merged sequence is built from, and which streams those runs
 * actually draw on.
 *
 * `used` is often shorter than `ranked`. A file whose two streams cover exactly
 * the same hour has nothing to switch to, so the plan collapses to the better
 * stream alone -- which is not a lesser outcome but a better one, because a
 * single-stream sequence can be copied straight into an MP4 and a merged one
 * cannot.
 */
export function planAuto (index, header, playable = [true, true], sizes = null) {
  const ranked = rankStreams(index, header, sizes, usableStreams(index, playable))
  if (ranked.length < 2) return { ranked, runs: [], used: ranked }

  const fallbackMs = header.frameInterval > 0 ? header.frameInterval / 1000 : 40
  const runs = planRuns(index, planSegments(index, ranked, fallbackMs))
  const used = ranked.filter((si) => runs.some((r) => r.src === si))
  return { ranked, runs, used: used.length ? used : ranked.slice(0, 1) }
}

/** Which streams `auto` will draw on, for the stream menu's labels. */
export function autoStreamSources (index, header, playable, sizes) {
  return planAuto(index, header, playable, sizes).used
}

/**
 * Flattens the file's one or two elementary streams into a single decodable
 * sequence.
 *
 * 'main' / 'sub' pick one stream verbatim. 'auto' plays the best picture
 * available at each moment: see `coverage.js` for how the switching points are
 * chosen, and `planRuns` for why the sequence is built out of contiguous slices
 * of one stream at a time.
 *
 * The two streams need not share a codec. Continuous H.264 sub-stream recording
 * with motion-triggered H.265 main stream is an ordinary Blue Iris
 * configuration, and it is exactly the file that has the most to gain from
 * switching -- so the merged sequence records which stream each frame came from
 * and the pipeline runs a decoder per stream.
 */
export function buildPlaybackStream (index, header, mode, playable = [true, true], sizes = null) {
  const usable = usableStreams(index, playable)

  if (mode !== 'auto') {
    let si = mode === 'sub' ? STREAM_SUB : STREAM_MAIN
    const other = si === STREAM_MAIN ? STREAM_SUB : STREAM_MAIN
    // Fall back when the chosen stream is absent or cannot be decoded here.
    if (!usable[si] && (usable[other] || index.streams[si].count === 0)) si = other
    return decorate(index.streams[si], si, header, index, sizes)
  }

  const { ranked, runs, used } = planAuto(index, header, playable, sizes)
  if (used.length < 2) {
    // Nothing playable at all still has to return a sequence; the caller reports
    // the codec problem in its own words.
    const si = used.length ? used[0]
      : index.streams[STREAM_MAIN].count > 0 ? STREAM_MAIN : STREAM_SUB
    return decorate(index.streams[si], si, header, index, sizes, autoLabel(si, ranked))
  }
  return merge(index, header, sizes, runs, used)
}

function autoLabel (si, ranked) {
  return ranked.length > 1
    ? `Auto (${si === STREAM_SUB ? 'sub' : 'main'})`
    : (si === STREAM_SUB ? 'Sub stream' : 'Main stream')
}

/** Concatenates the planned runs into one sequence. */
function merge (index, header, sizes, runs, used) {
  let count = 0
  for (const r of runs) count += r.to - r.from + 1

  const out = emptyStream(count)
  let k = 0
  for (const r of runs) {
    const src = index.streams[r.src]
    for (let i = r.from; i <= r.to; i++, k++) {
      out.offset[k] = src.offset[i]
      out.size[k] = src.size[i]
      out.ts[k] = src.ts[i]
      out.utc[k] = src.utc[i]
      out.flags[k] = src.flags[i]
      out.dio[k] = src.dio[i]
      out.state[k] = src.state[i]
      out.srcStream[k] = r.src
      out.srcIndex[k] = i
    }
  }
  computeRunKeys(out, runs)

  const shapes = used.map((si) => sizeOf(header, sizes, si))
  const sourceSizes = []
  used.forEach((si, n) => { sourceSizes[si] = shapes[n] })

  out.mode = 'auto'
  out.sources = used
  out.sourceSizes = sourceSizes
  out.codecSource = used[0]
  out.streamLabel = 'Auto (main + sub)'
  out.width = Math.max(...shapes.map((s) => s.width))
  out.height = Math.max(...shapes.map((s) => s.height))
  out.fourcc = header.bmih[used[0]]?.fourcc || header.bmih[0]?.fourcc || ''
  out.variableResolution = shapes.some((s) => s.width !== shapes[0].width || s.height !== shapes[0].height)
  out.mixedCodecs = new Set(used.map((si) => (header.bmih[si] || header.bmih[0])?.fourcc)).size > 1
  out._index = index
  return out
}

function emptyStream (count) {
  return {
    count,
    offset: new Float64Array(count),
    size: new Uint32Array(count),
    ts: new Float64Array(count),
    utc: new Float64Array(count),
    flags: new Uint16Array(count),
    dio: new Uint32Array(count),
    state: new Uint32Array(count),
    // Which of the file's streams each frame came from, and where in that
    // stream it sits. The pipeline needs the first to route the frame to the
    // right decoder; nothing needs the second yet, but a merged sequence that
    // cannot say where a frame came from is a debugging dead end.
    srcStream: new Uint8Array(count),
    srcIndex: new Int32Array(count),
    keyIdx: new Int32Array(count),
    keys: null,
    variableResolution: false,
    mixedCodecs: false,
    sources: null,
    sourceSizes: null,
    codecSource: STREAM_MAIN
  }
}

/**
 * Key-frame back-references for a merged sequence, computed inside each run.
 *
 * A reference may never cross a run boundary. The frame before a switch belongs
 * to a different decoder than the frame after it, and a seek that restarted from
 * "the last key frame" without regard for which stream it belonged to would feed
 * one decoder the other's pictures.
 */
function computeRunKeys (s, runs) {
  const keys = []
  let k = 0
  for (const r of runs) {
    let last = -1
    const n = r.to - r.from + 1
    for (let j = 0; j < n; j++, k++) {
      if (s.flags[k] & FLAG_ISKEY) { last = k; keys.push(k) }
      s.keyIdx[k] = last
    }
  }
  s.keys = Int32Array.from(keys)
}

/**
 * A stream's picture size: what the probe read out of the bitstream when it
 * could, and the header's declared size otherwise. The two disagree often
 * enough that everything downstream -- the MP4 track header an export writes,
 * the resolution the panels report -- wants the real one.
 */
function sizeOf (header, sizes, si) {
  const probed = sizes && sizes[si]
  const bmih = header.bmih[si] || header.bmih[0]
  return {
    width: (probed && probed.width) || bmih?.width || 0,
    height: (probed && probed.height) || bmih?.height || 0
  }
}

function decorate (src, si, header, index, sizes, label) {
  const bmih = header.bmih[si] || header.bmih[0]
  const size = sizeOf(header, sizes, si)
  const sourceSizes = []
  sourceSizes[si] = size
  return {
    count: src.count,
    offset: src.offset,
    size: src.size,
    ts: src.ts,
    utc: src.utc,
    flags: src.flags,
    dio: src.dio,
    state: src.state,
    srcStream: null,
    srcIndex: null,
    keyIdx: src.keyIdx,
    keys: src.keys,
    variableResolution: false,
    mixedCodecs: false,
    sources: [si],
    sourceSizes,
    codecSource: si,
    mode: si === STREAM_SUB ? 'sub' : 'main',
    streamLabel: label || (si === STREAM_SUB ? 'Sub stream' : 'Main stream'),
    width: size.width,
    height: size.height,
    fourcc: bmih?.fourcc || '',
    _srcIndex: si,
    _index: index
  }
}

/**
 * Marks and segment starts across the whole recording.
 *
 * Both are read from the file's own streams rather than from the sequence being
 * played: a dual-stream recording routinely puts its mark on one stream only,
 * and a viewer watching the other one should still see that something was
 * bookmarked there. The two streams share a timebase, so the times map onto the
 * scrub bar either way.
 *
 * The first frame of a recording is always a discontinuity (spec 5), which is
 * not worth a tick of its own at time zero. Near-simultaneous discontinuities on
 * the two streams are the same event and are reported once.
 */
const SAME_EVENT_MS = 40

export function collectMarkers (index) {
  const marks = []
  const segments = []
  if (!index) return { marks, segments }

  for (const m of index.marks) {
    marks.push({ index: m.idx, ts: m.ts - index.baseTs, utc: m.utc, stream: m.stream })
  }
  marks.sort((a, b) => a.ts - b.ts)

  for (let si = 0; si < index.streams.length; si++) {
    const s = index.streams[si]
    for (let i = 1; i < s.count; i++) {
      if (s.flags[i] & FLAG_ISDISCONTINUITY) {
        segments.push({ index: i, ts: s.ts[i], utc: s.utc[i], stream: si })
      }
    }
  }
  segments.sort((a, b) => a.ts - b.ts)
  const merged = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (last && seg.ts - last.ts <= SAME_EVENT_MS) continue
    merged.push(seg)
  }
  return { marks, segments: merged }
}

/** Median inter-frame interval in ms; used for frame stepping and EOF slack. */
export function estimateFrameInterval (pstream, fallbackUs) {
  const n = pstream.count
  if (n < 2) return fallbackUs > 0 ? fallbackUs / 1000 : 33.367
  const samples = []
  const step = Math.max(1, Math.floor(n / 400))
  for (let i = step; i < n; i += step) {
    const d = pstream.ts[i] - pstream.ts[i - step]
    if (d > 0) samples.push(d / step)
  }
  if (!samples.length) return fallbackUs > 0 ? fallbackUs / 1000 : 33.367
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]
}
