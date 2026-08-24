import { FLAG_ISKEY, FLAG_MAINAVAILABLE, STREAM_MAIN, STREAM_SUB } from '../bvr/constants.js'

/**
 * Flattens the file's one or two elementary streams into a single decodable
 * sequence.
 *
 * 'main' / 'sub' pick one stream verbatim. 'auto' additionally implements the
 * switching-mode rule from spec section 5.3: prefer main frames, and use sub
 * frames only where MAINAVAILABLE is clear.
 */
export function buildPlaybackStream (index, header, mode) {
  const [main, sub] = index.streams
  const wantSwitching = mode === 'auto' && index.switchingMode && main.count > 0 && sub.count > 0

  if (!wantSwitching) {
    let si = mode === 'sub' ? STREAM_SUB : STREAM_MAIN
    if (mode === 'auto') si = main.count > 0 ? STREAM_MAIN : STREAM_SUB
    if (index.streams[si].count === 0) si = si === STREAM_MAIN ? STREAM_SUB : STREAM_MAIN
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
    variableResolution: false
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
