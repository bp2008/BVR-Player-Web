import { FLAG_ISKEY, FLAG_MAINAVAILABLE, STREAM_MAIN, STREAM_SUB } from '../bvr/constants.js'

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
export function buildPlaybackStream (index, header, mode, playable = [true, true]) {
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
    return decorate(index.streams[si], si, header, index)
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
    out.srcStream[k] = s
  }
  computeKeys(out)
  out.mode = 'auto'
  out.codecSource = STREAM_MAIN
  out.streamLabel = 'Auto (main + sub)'
  out.width = Math.max(header.bmih[0]?.width || 0, header.bmih[1]?.width || 0)
  out.height = Math.max(header.bmih[0]?.height || 0, header.bmih[1]?.height || 0)
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

function decorate (src, si, header, index) {
  const bmih = header.bmih[si] || header.bmih[0]
  return {
    count: src.count,
    offset: src.offset,
    size: src.size,
    ts: src.ts,
    utc: src.utc,
    flags: src.flags,
    srcStream: null,
    keyIdx: src.keyIdx,
    keys: src.keys,
    variableResolution: false,
    codecSource: si,
    mode: si === STREAM_SUB ? 'sub' : 'main',
    streamLabel: si === STREAM_SUB ? 'Sub stream' : 'Main stream',
    width: bmih?.width || 0,
    height: bmih?.height || 0,
    fourcc: bmih?.fourcc || '',
    _srcIndex: si,
    _index: index
  }
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
