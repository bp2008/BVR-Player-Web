import { WAVE_FORMAT_PCM, WAVE_FORMAT_ALAW, WAVE_FORMAT_MULAW, WAVE_FORMAT_FLAC } from '../bvr/constants.js'

// G.711 mu-law expansion table (ITU-T G.711), built once.
const MULAW_TABLE = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff
    const sign = u & 0x80
    const exponent = (u >> 4) & 0x07
    const mantissa = u & 0x0f
    let sample = ((mantissa << 3) + 0x84) << exponent
    sample -= 0x84
    t[i] = (sign ? -sample : sample) / 32768
  }
  return t
})()

// G.711 A-law expansion table (ITU-T G.711). Never present in a BVR recording;
// an MP4 audio track may carry it, and one table is cheaper than a branch.
const ALAW_TABLE = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const a = i ^ 0x55
    const sign = a & 0x80
    const exponent = (a >> 4) & 0x07
    const mantissa = a & 0x0f
    let sample = exponent === 0
      ? (mantissa << 4) + 8
      : ((mantissa << 4) + 0x108) << (exponent - 1)
    t[i] = (sign ? sample : -sample) / 32768
  }
  return t
})()

/** Decodes raw interleaved PCM of the width described by wfx into planar floats. */
function decodePcm (bytes, wfx) {
  const ch = Math.max(1, wfx.nChannels)
  const bits = wfx.wBitsPerSample || 16
  const bytesPerSample = Math.max(1, bits >> 3)
  const frames = Math.floor(bytes.length / (bytesPerSample * ch))
  const planes = []
  for (let c = 0; c < ch; c++) planes.push(new Float32Array(frames))
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // QuickTime's `twos`, `in24` and `in32` are the same samples the other way
  // round. Reading them little-endian produces full-scale noise rather than a
  // quiet mistake, so the flag is worth carrying through the wfx.
  const le = !wfx.bigEndian

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const at = (f * ch + c) * bytesPerSample
      let v = 0
      switch (bits) {
        case 8: v = (bytes[at] - 128) / 128; break
        case 16: v = dv.getInt16(at, le) / 32768; break
        case 24: {
          const raw = le
            ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
            : bytes[at + 2] | (bytes[at + 1] << 8) | (bytes[at] << 16)
          v = ((raw << 8) >> 8) / 8388608
          break
        }
        case 32: v = dv.getInt32(at, le) / 2147483648; break
        default: v = 0
      }
      planes[c][f] = v
    }
  }
  return { planes, frames }
}

function decodeG711 (bytes, wfx, table) {
  const ch = Math.max(1, wfx.nChannels)
  const frames = Math.floor(bytes.length / ch)
  const planes = []
  for (let c = 0; c < ch; c++) planes.push(new Float32Array(frames))
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) planes[c][f] = table[bytes[f * ch + c]]
  }
  return { planes, frames }
}

/**
 * The WebCodecs FLAC registration wants a full FLAC header (the "fLaC" marker
 * plus a STREAMINFO metadata block). BVR stores only the bare 34-byte
 * STREAMINFO, so wrap it.
 */
export function buildFlacDescription (extradata) {
  if (!extradata || extradata.length < 34) return null
  if (extradata.length >= 4 && extradata[0] === 0x66 && extradata[1] === 0x4c &&
      extradata[2] === 0x61 && extradata[3] === 0x43) {
    return extradata
  }
  const info = extradata.subarray(0, 34)
  const out = new Uint8Array(4 + 4 + 34)
  out.set([0x66, 0x4c, 0x61, 0x43], 0)      // "fLaC"
  out.set([0x80, 0x00, 0x00, 0x22], 4)      // last-block | STREAMINFO, length 34
  out.set(info, 8)
  return out
}

/** min/max block size out of STREAMINFO; equal values mean a constant packet duration. */
export function flacBlockSize (extradata) {
  const d = buildFlacDescription(extradata)
  if (!d) return 0
  const info = d.subarray(8)
  const min = (info[0] << 8) | info[1]
  const max = (info[2] << 8) | info[3]
  return min > 0 && min === max ? min : 0
}

/** Synchronous decoders for the formats that do not need WebCodecs. */
export function makeSimpleDecoder (wfx) {
  if (wfx.wFormatTag === WAVE_FORMAT_PCM) return (bytes) => decodePcm(bytes, wfx)
  if (wfx.wFormatTag === WAVE_FORMAT_ALAW) return (bytes) => decodeG711(bytes, wfx, ALAW_TABLE)
  if (wfx.wFormatTag !== WAVE_FORMAT_FLAC) return (bytes) => decodeG711(bytes, wfx, MULAW_TABLE)
  return null
}

/** Samples carried by one packet, derived from the frame table alone. */
export function packetSampleCount (wfx, byteLength, constantBlockSize) {
  switch (wfx.wFormatTag) {
    case WAVE_FORMAT_PCM:
      return Math.floor(byteLength / Math.max(1, wfx.nBlockAlign))
    case WAVE_FORMAT_FLAC:
      return constantBlockSize || 0
    case WAVE_FORMAT_ALAW:
    case WAVE_FORMAT_MULAW:
    default:
      return Math.floor(byteLength / Math.max(1, wfx.nChannels))
  }
}

/**
 * Start time in ms for every audio packet, rebuilt from cumulative sample
 * counts.
 *
 * Spec 6 warns that the stored per-packet timestamp is not a start time: FLAC
 * packets are stamped near their *end*, and very old files stamp every packet 0.
 * The stream is continuous from the first video frame, though, so counting
 * samples gives exact starts from the frame table alone. When a packet's sample
 * count cannot be derived the stored timestamps are the only thing left, and
 * this falls back to them wholesale rather than mixing the two.
 */
export function packetStartTimes (wfx, audio, extradata) {
  if (!audio || !audio.count || !wfx || !wfx.nSamplesPerSec) return null
  const blockSize = wfx.wFormatTag === WAVE_FORMAT_FLAC ? flacBlockSize(extradata) : 0
  const starts = new Float64Array(audio.count)
  const origin = audio.ts[0]
  let cum = 0
  for (let i = 0; i < audio.count; i++) {
    const n = packetSampleCount(wfx, audio.size[i], blockSize)
    if (n <= 0) return Float64Array.from(audio.ts)
    starts[i] = origin + (cum * 1000) / wfx.nSamplesPerSec
    cum += n
  }
  return starts
}

export function audioCodecLabel (wfx) {
  switch (wfx.wFormatTag) {
    case WAVE_FORMAT_PCM: return `PCM ${wfx.wBitsPerSample}-bit`
    case WAVE_FORMAT_ALAW: return 'G.711 A-law'
    case WAVE_FORMAT_MULAW: return 'G.711 mu-law'
    case WAVE_FORMAT_FLAC: return 'FLAC'
    default: return `G.711 mu-law (tag 0x${wfx.wFormatTag.toString(16)})`
  }
}
