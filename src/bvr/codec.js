/**
 * Codec identification for BVR video payloads.
 *
 * BVR stores raw Annex-B elementary streams with parameter sets in-band on every
 * key frame (spec section 5.2), so a WebCodecs `VideoDecoderConfig` can be built
 * from the first key frame alone. WebCodecs still demands a precise codec string,
 * which means parsing profile/tier/level out of the SPS.
 */

/** Splits an Annex-B byte stream into NAL units (payloads exclude start codes). */
export function splitAnnexB (buf) {
  const out = []
  const n = buf.length
  let i = 0
  let start = -1
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let scLen = 0
      if (buf[i + 2] === 1) scLen = 3
      else if (buf[i + 2] === 0 && i + 3 < n && buf[i + 3] === 1) scLen = 4
      if (scLen) {
        if (start >= 0) out.push(buf.subarray(start, i))
        start = i + scLen
        i += scLen
        continue
      }
    }
    i++
  }
  if (start >= 0 && start < n) out.push(buf.subarray(start, n))
  return out
}

/** Removes emulation-prevention bytes so fixed-width header fields line up. */
function toRbsp (nal, skipHeaderBytes) {
  const out = new Uint8Array(nal.length)
  let o = 0
  let zeros = 0
  for (let i = skipHeaderBytes; i < nal.length; i++) {
    const b = nal[i]
    if (zeros >= 2 && b === 3) { zeros = 0; continue }
    out[o++] = b
    zeros = b === 0 ? zeros + 1 : 0
  }
  return out.subarray(0, o)
}

class BitReader {
  constructor (bytes) { this.b = bytes; this.p = 0 }
  u (n) {
    let v = 0
    for (let i = 0; i < n; i++) {
      v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1)
      this.p++
    }
    return v
  }
}

const H264_PROFILES = {
  66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High',
  110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4'
}
const HEVC_PROFILES = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions' }

const hex2 = (v) => v.toString(16).padStart(2, '0')

function avcFromSps (sps) {
  if (sps.length < 4) return null
  const profile = sps[1]
  const constraints = sps[2]
  const level = sps[3]
  return {
    codec: `avc1.${hex2(profile)}${hex2(constraints)}${hex2(level)}`,
    label: `H.264 ${H264_PROFILES[profile] || `profile ${profile}`} @ L${(level / 10).toFixed(1)}`
  }
}

function hevcFromSps (sps) {
  // NAL header is 2 bytes; profile_tier_level starts after 8 bits of SPS ids.
  const rbsp = toRbsp(sps, 2)
  if (rbsp.length < 14) return null
  const br = new BitReader(rbsp)
  br.u(4)                       // sps_video_parameter_set_id
  const maxSubLayersMinus1 = br.u(3)
  br.u(1)                       // sps_temporal_id_nesting_flag
  const profileSpace = br.u(2)
  const tier = br.u(1)
  const profileIdc = br.u(5)
  const compat = br.u(32)
  const constraints = []
  for (let i = 0; i < 6; i++) constraints.push(br.u(8))
  const level = br.u(8)
  if (maxSubLayersMinus1 > 7) return null

  // The codec string carries the compatibility flags with bit order reversed.
  let reversed = 0
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) reversed |= 1 << (31 - i)
  reversed >>>= 0

  const spacePrefix = profileSpace === 0 ? '' : String.fromCharCode(64 + profileSpace)
  let codec = `hev1.${spacePrefix}${profileIdc}.${reversed.toString(16)}.${tier ? 'H' : 'L'}${level}`
  const trimmed = constraints.slice()
  while (trimmed.length && trimmed[trimmed.length - 1] === 0) trimmed.pop()
  for (const c of trimmed) codec += `.${c.toString(16).toUpperCase().padStart(2, '0')}`

  return {
    codec,
    label: `H.265 ${HEVC_PROFILES[profileIdc] || `profile ${profileIdc}`} @ ${tier ? 'High' : 'Main'} L${(level / 30).toFixed(1)}`
  }
}

/**
 * Inspects a key-frame payload and returns how it should be decoded.
 *   kind 'video' -> feed to VideoDecoder with `config`
 *   kind 'image' -> each frame is a standalone JPEG (MJPEG)
 *   kind 'unsupported' -> nothing in the browser can decode this
 */
export function describeVideoCodec (fourcc, keyPayload, bmih) {
  const width = bmih ? bmih.width : 0
  const height = bmih ? bmih.height : 0

  if (fourcc === 'MJPG') {
    return { kind: 'image', mime: 'image/jpeg', label: 'Motion JPEG', width, height }
  }

  if (fourcc === 'H264' || fourcc === 'H265') {
    const isH264 = fourcc === 'H264'
    let info = null
    if (keyPayload) {
      for (const nal of splitAnnexB(keyPayload)) {
        if (nal.length < 2) continue
        if (isH264) {
          if ((nal[0] & 0x1f) === 7) { info = avcFromSps(nal); break }
        } else if (((nal[0] >> 1) & 0x3f) === 33) { info = hevcFromSps(nal); break }
      }
    }
    if (!info) {
      // Conservative fall-backs; still worth attempting rather than refusing.
      info = isH264
        ? { codec: 'avc1.640028', label: 'H.264' }
        : { codec: 'hev1.1.6.L93.B0', label: 'H.265' }
    }
    return {
      kind: 'video',
      label: info.label,
      width,
      height,
      config: {
        codec: info.codec,
        codedWidth: width || undefined,
        codedHeight: height || undefined,
        hardwareAcceleration: 'no-preference',
        // Annex-B input: `description` is deliberately omitted (spec section 5.2).
        optimizeForLatency: true
      }
    }
  }

  return {
    kind: 'unsupported',
    label: `MPEG-4 Part 2 / "${fourcc.replace(/[^\x20-\x7e]/g, '?')}"`,
    width,
    height
  }
}
