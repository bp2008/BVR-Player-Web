/**
 * Codec identification for BVR video payloads.
 *
 * BVR stores raw Annex-B elementary streams with parameter sets in-band on every
 * key frame (spec section 5.2), so a WebCodecs `VideoDecoderConfig` can be built
 * from the first key frame alone. WebCodecs still demands a precise codec string,
 * which means parsing profile/tier/level out of the SPS.
 *
 * The same SPS is read for the picture's real size. Blue Iris writes the
 * resolution it asked the camera for into the file header (spec 4.3), and that
 * is not always the resolution the camera's encoder produced -- a sub stream
 * declared 640x480 and encoded 640x360 is ordinary output. The header says what
 * the recording *claims* the picture is; the bitstream says what it *is*. Both
 * are worth having, so both are reported.
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

/**
 * Bit reader for parameter sets.
 *
 * A read past the end sets `bad` rather than throwing: only the front of a key
 * frame is sampled, so meeting a parameter set that runs off the end of the
 * sample is a normal event, and the caller decides what a partial parse is
 * worth. Nothing read after `bad` is set means anything.
 */
class BitReader {
  constructor (bytes) {
    this.b = bytes
    this.p = 0
    this.n = bytes.length * 8
    this.bad = false
  }

  u (n) {
    let v = 0
    for (let i = 0; i < n; i++) {
      if (this.p >= this.n) { this.bad = true; break }
      v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1)
      this.p++
    }
    return v
  }

  /** Unsigned Exp-Golomb. A prefix this long is malformed, not merely large. */
  ue () {
    let zeros = 0
    while (zeros <= 30) {
      if (this.p >= this.n) { this.bad = true; return 0 }
      if (this.u(1)) break
      zeros++
    }
    if (zeros > 30) { this.bad = true; return 0 }
    if (zeros === 0) return 0
    return (1 << zeros) - 1 + this.u(zeros)
  }

  /** Signed Exp-Golomb. */
  se () {
    const k = this.ue()
    return (k & 1) ? (k + 1) >> 1 : -(k >> 1)
  }
}

const H264_PROFILES = {
  66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High',
  110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4'
}
const HEVC_PROFILES = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions' }

// Profiles whose SPS carries a chroma-format block ahead of the fields that
// lead to the picture size.
const H264_HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]

const hex2 = (v) => v.toString(16).padStart(2, '0')

/** A size is only believable if it describes a plausible picture. */
function sane (w, h) {
  return w > 0 && h > 0 && w <= 16384 && h <= 16384
}

/** Consumes a scaling-list block without keeping any of it. */
function skipScalingLists (br, count) {
  for (let i = 0; i < count && !br.bad; i++) {
    if (!br.u(1)) continue
    const size = i < 6 ? 16 : 64
    let last = 8
    let next = 8
    for (let j = 0; j < size && !br.bad; j++) {
      if (next !== 0) next = (last + br.se() + 256) % 256
      last = next === 0 ? last : next
    }
  }
}

/**
 * Reads an H.264 SPS: the codec string WebCodecs wants, and the cropped picture
 * size the decoder will emit. Width and height come back 0 when the SPS could
 * not be followed all the way to the cropping window.
 */
function avcFromSps (sps) {
  const rbsp = toRbsp(sps, 1)
  if (rbsp.length < 4) return null
  const profile = rbsp[0]
  const constraints = rbsp[1]
  const level = rbsp[2]
  const out = {
    codec: `avc1.${hex2(profile)}${hex2(constraints)}${hex2(level)}`,
    label: `H.264 ${H264_PROFILES[profile] || `profile ${profile}`} @ L${(level / 10).toFixed(1)}`,
    width: 0,
    height: 0
  }

  const br = new BitReader(rbsp)
  br.u(24)                               // profile / constraints / level, read above
  br.ue()                                // seq_parameter_set_id
  let chroma = 1
  let separatePlanes = 0
  if (H264_HIGH_PROFILES.includes(profile)) {
    chroma = br.ue()
    if (chroma === 3) separatePlanes = br.u(1)
    br.ue()                              // bit_depth_luma_minus8
    br.ue()                              // bit_depth_chroma_minus8
    br.u(1)                              // qpprime_y_zero_transform_bypass_flag
    if (br.u(1)) skipScalingLists(br, chroma === 3 ? 12 : 8)
  }
  br.ue()                                // log2_max_frame_num_minus4
  const pocType = br.ue()
  if (pocType === 0) {
    br.ue()                              // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    br.u(1)                              // delta_pic_order_always_zero_flag
    br.se()                              // offset_for_non_ref_pic
    br.se()                              // offset_for_top_to_bottom_field
    const cycle = br.ue()
    for (let i = 0; i < cycle && !br.bad; i++) br.se()
  }
  br.ue()                                // max_num_ref_frames
  br.u(1)                                // gaps_in_frame_num_value_allowed_flag
  const widthMbs = br.ue() + 1
  const heightUnits = br.ue() + 1
  const frameMbsOnly = br.u(1)
  if (!frameMbsOnly) br.u(1)             // mb_adaptive_frame_field_flag
  br.u(1)                                // direct_8x8_inference_flag
  let cl = 0
  let cr = 0
  let ct = 0
  let cb = 0
  if (br.u(1)) { cl = br.ue(); cr = br.ue(); ct = br.ue(); cb = br.ue() }
  if (br.bad) return out

  // Crop offsets are counted in chroma samples, so they scale with the sampling
  // format (SubWidthC / SubHeightC), and a field-coded stream crops in pairs.
  const mono = chroma === 0 || separatePlanes === 1
  const unitX = mono || chroma === 3 ? 1 : 2
  const unitY = (mono || chroma !== 1 ? 1 : 2) * (2 - frameMbsOnly)
  const width = widthMbs * 16 - unitX * (cl + cr)
  const height = (2 - frameMbsOnly) * heightUnits * 16 - unitY * (ct + cb)
  if (sane(width, height)) { out.width = width; out.height = height }
  return out
}

/** The H.265 equivalent of avcFromSps. */
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

  const out = {
    codec,
    label: `H.265 ${HEVC_PROFILES[profileIdc] || `profile ${profileIdc}`} @ ${tier ? 'High' : 'Main'} L${(level / 30).toFixed(1)}`,
    width: 0,
    height: 0
  }

  // The tail of profile_tier_level(): per-sub-layer presence flags, the padding
  // that follows them, and then the sub-layer blocks the flags announced.
  const profilePresent = []
  const levelPresent = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(br.u(1))
    levelPresent.push(br.u(1))
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) br.u(2)
  }
  for (let i = 0; i < maxSubLayersMinus1 && !br.bad; i++) {
    if (profilePresent[i]) { br.u(2); br.u(1); br.u(5); br.u(32); br.u(24); br.u(24) }
    if (levelPresent[i]) br.u(8)
  }

  br.ue()                       // sps_seq_parameter_set_id
  const chroma = br.ue()
  if (chroma === 3) br.u(1)     // separate_colour_plane_flag
  const width = br.ue()
  const height = br.ue()
  let cl = 0
  let cr = 0
  let ct = 0
  let cb = 0
  if (br.u(1)) { cl = br.ue(); cr = br.ue(); ct = br.ue(); cb = br.ue() }
  if (br.bad) return out

  const subW = chroma === 1 || chroma === 2 ? 2 : 1
  const subH = chroma === 1 ? 2 : 1
  const w = width - subW * (cl + cr)
  const h = height - subH * (ct + cb)
  if (sane(w, h)) { out.width = w; out.height = h }
  return out
}

/**
 * The picture size of a JPEG, from its first start-of-frame marker.
 *
 * MJPEG carries no parameter sets, so this is the only place a Motion JPEG
 * recording says how big its pictures really are.
 */
function jpegDimensions (bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue }
    const marker = bytes[i + 1]
    // Fill bytes, and the standalone markers, carry no length field.
    if (marker === 0xff) { i++; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
    const len = (bytes[i + 2] << 8) | bytes[i + 3]
    const isSof = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 9 > bytes.length) return null
      const height = (bytes[i + 5] << 8) | bytes[i + 6]
      const width = (bytes[i + 7] << 8) | bytes[i + 8]
      return sane(width, height) ? { width, height } : null
    }
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

/**
 * Inspects a key-frame payload and returns how it should be decoded.
 *   kind 'video' -> feed to VideoDecoder with `config`
 *   kind 'image' -> each frame is a standalone JPEG (MJPEG)
 *   kind 'unsupported' -> nothing in the browser can decode this
 *
 * `width` / `height` are the size the pictures actually are, read from the
 * bitstream where that is possible and falling back to the header's declared
 * size where it is not. `declaredWidth` / `declaredHeight` are always the
 * header's own numbers -- the resolution Blue Iris asked the camera for -- which
 * is what decides the shape the picture is meant to be shown in.
 */
export function describeVideoCodec (fourcc, keyPayload, bmih) {
  const declaredWidth = bmih ? bmih.width : 0
  const declaredHeight = bmih ? bmih.height : 0

  if (fourcc === 'MJPG') {
    const coded = keyPayload ? jpegDimensions(keyPayload) : null
    return {
      kind: 'image',
      mime: 'image/jpeg',
      label: 'Motion JPEG',
      width: coded ? coded.width : declaredWidth,
      height: coded ? coded.height : declaredHeight,
      declaredWidth,
      declaredHeight
    }
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
        ? { codec: 'avc1.640028', label: 'H.264', width: 0, height: 0 }
        : { codec: 'hev1.1.6.L93.B0', label: 'H.265', width: 0, height: 0 }
    }
    const width = info.width || declaredWidth
    const height = info.height || declaredHeight
    return {
      kind: 'video',
      label: info.label,
      width,
      height,
      declaredWidth,
      declaredHeight,
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
    width: declaredWidth,
    height: declaredHeight,
    declaredWidth,
    declaredHeight
  }
}
