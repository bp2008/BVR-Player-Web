import {
  FLAG_ISKEY, FLAG_MAINAVAILABLE, FLAG_ISDISCONTINUITY, STREAM_MAIN, STREAM_SUB
} from '../bvr/constants.js'

/** Which streams hold frames and can actually be decoded on this device. */
function usableStreams (index, playable) {
  return [
    index.streams[STREAM_MAIN].count > 0 && playable[STREAM_MAIN] !== false,
    index.streams[STREAM_SUB].count > 0 && playable[STREAM_SUB] !== false
  ]
}

/** One decoder handles one codec, so main and sub can only be merged if they agree. */
function codecsAgree (header) {
  const a = header.bmih[STREAM_MAIN]
  const b = header.bmih[STREAM_SUB]
  return !a || !b || a.fourcc === b.fourcc
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
 * Flattens the file's one or two elementary streams into a single decodable
 * sequence.
 *
 * 'main' / 'sub' pick one stream verbatim. 'auto' additionally implements the
 * switching-mode rule from spec section 5.3: prefer main frames, and use sub
 * frames only where MAINAVAILABLE is clear -- but only when both streams are
 * decodable here and share a codec, since the merged sequence goes through a
 * single decoder.
 */
export function buildPlaybackStream (index, header, mode, playable = [true, true], sizes = null) {
  const [main, sub] = index.streams
  const usable = usableStreams(index, playable)
  const wantSwitching = mode === 'auto' && index.switchingMode &&
    usable[STREAM_MAIN] && usable[STREAM_SUB] && codecsAgree(header)

  if (!wantSwitching) {
    let si = mode === 'sub' ? STREAM_SUB : STREAM_MAIN
    if (mode === 'auto') si = usable[STREAM_MAIN] ? STREAM_MAIN : STREAM_SUB
    const other = si === STREAM_MAIN ? STREAM_SUB : STREAM_MAIN
    // Fall back when the chosen stream is absent or cannot be decoded here.
    if (!usable[si] && (usable[other] || index.streams[si].count === 0)) si = other
    return decorate(index.streams[si], si, header, index, sizes)
  }

  const keep = []
  for (let i = 0; i < main.count; i++) keep.push({ s: STREAM_MAIN, i, ts: main.ts[i] })
  for (let i = 0; i < sub.count; i++) {
    if (sub.flags[i] & FLAG_MAINAVAILABLE) continue
    keep.push({ s: STREAM_SUB, i, ts: sub.ts[i] })
  }
  keep.sort((a, b) => a.ts - b.ts || a.s - b.s)

  const count = keep.length
  const out = emptyStream(count)
  for (let k = 0; k < count; k++) {
    const { s, i } = keep[k]
    const src = index.streams[s]
    out.offset[k] = src.offset[i]
    out.size[k] = src.size[i]
    out.ts[k] = src.ts[i]
    out.utc[k] = src.utc[i]
    out.flags[k] = src.flags[i]
    out.dio[k] = src.dio[i]
    out.state[k] = src.state[i]
    out.srcStream[k] = s
  }
  computeKeys(out)
  out.mode = 'auto'
  out.codecSource = STREAM_MAIN
  out.streamLabel = 'Auto (main + sub)'
  out.width = Math.max(sizeOf(header, sizes, 0).width, sizeOf(header, sizes, 1).width)
  out.height = Math.max(sizeOf(header, sizes, 0).height, sizeOf(header, sizes, 1).height)
  out.fourcc = header.bmih[0]?.fourcc || header.bmih[1]?.fourcc
  out.variableResolution = true
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
    srcStream: new Uint8Array(count),
    keyIdx: new Int32Array(count),
    keys: null,
    variableResolution: false,
    codecSource: STREAM_MAIN
  }
}

function computeKeys (s) {
  const keys = []
  let last = -1
  for (let i = 0; i < s.count; i++) {
    if (s.flags[i] & FLAG_ISKEY) { last = i; keys.push(i) }
    s.keyIdx[i] = last
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

function decorate (src, si, header, index, sizes) {
  const bmih = header.bmih[si] || header.bmih[0]
  const size = sizeOf(header, sizes, si)
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
    keyIdx: src.keyIdx,
    keys: src.keys,
    variableResolution: false,
    codecSource: si,
    mode: si === STREAM_SUB ? 'sub' : 'main',
    streamLabel: si === STREAM_SUB ? 'Sub stream' : 'Main stream',
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
