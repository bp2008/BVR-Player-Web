import { splitAnnexB } from '../bvr/codec.js'

/**
 * Annex-B to length-prefixed conversion, and the MP4 decoder-configuration
 * records that go with it.
 *
 * BVR stores elementary streams exactly as the camera delivered them: start
 * codes, with the parameter sets repeated in-band on every key frame (spec
 * 5.1/5.2). MP4 wants the opposite arrangement -- each NAL unit prefixed with
 * its length, and the parameter sets hoisted out into an `avcC` or `hvcC` box in
 * the sample entry. Both halves of that rearrangement live here.
 *
 * Nothing is re-encoded: the slice data is copied through byte for byte, which
 * is what makes a remux cost one pass over the file and no decoding at all.
 */

// H.264 NAL types (ITU-T H.264 table 7-1).
const H264_SEI = 6
const H264_SPS = 7
const H264_PPS = 8
const H264_AUD = 9

// H.265 NAL types (ITU-T H.265 table 7-1).
const H265_VPS = 32
const H265_SPS = 33
const H265_PPS = 34
const H265_AUD = 35
const H265_SEI_PREFIX = 39
const H265_SEI_SUFFIX = 40

export const h264NalType = (nal) => nal[0] & 0x1f
export const h265NalType = (nal) => (nal[0] >> 1) & 0x3f

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

  /** Exp-Golomb unsigned. Bounded so corrupt input cannot spin here. */
  ue () {
    let zeros = 0
    while (zeros < 32 && this.u(1) === 0 && this.p < this.b.length * 8) zeros++
    if (zeros === 0) return 0
    return (1 << zeros) - 1 + this.u(zeros)
  }
}

/**
 * The parameter sets a stream needs, gathered across however many key frames
 * are visited.
 *
 * Cameras repeat identical parameter sets on every key frame, so this is
 * normally three short byte arrays no matter how long the recording is. Keeping
 * every *distinct* one is what makes the result correct for the rare stream
 * that re-sends a changed SPS mid-file -- and `conflict` records the one case
 * that cannot be expressed out-of-band at all: two different definitions of the
 * same parameter-set id.
 */
export class ParameterSets {
  constructor (isH264) {
    this.isH264 = isH264
    this.vps = []
    this.sps = []
    this.pps = []
    this.conflict = false
    this._seen = new Set()
  }

  get complete () {
    return this.sps.length > 0 && this.pps.length > 0 && (this.isH264 || this.vps.length > 0)
  }

  _add (list, nal) {
    const key = list === this.vps ? 'v' : list === this.sps ? 's' : 'p'
    const digest = key + ':' + nal.length + ':' + fingerprint(nal)
    if (this._seen.has(digest)) return
    this._seen.add(digest)
    // Same id, different bytes: an avc1/hvc1 sample entry can only carry one
    // definition per id, so the caller has to know the export is approximate.
    const id = parameterSetId(nal, this.isH264, key)
    if (id >= 0 && list.some((other) => parameterSetId(other, this.isH264, key) === id)) {
      this.conflict = true
      return
    }
    list.push(nal.slice())
  }

  /** Harvests any parameter sets carried by one access unit. */
  collect (nals) {
    for (const nal of nals) {
      if (nal.length < 2) continue
      if (this.isH264) {
        const t = h264NalType(nal)
        if (t === H264_SPS) this._add(this.sps, nal)
        else if (t === H264_PPS) this._add(this.pps, nal)
      } else {
        const t = h265NalType(nal)
        if (t === H265_VPS) this._add(this.vps, nal)
        else if (t === H265_SPS) this._add(this.sps, nal)
        else if (t === H265_PPS) this._add(this.pps, nal)
      }
    }
  }
}

/** Cheap content hash; only ever compared against other hashes of NAL bytes. */
function fingerprint (bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/** The id a parameter set declares, so two definitions of one id can be spotted. */
function parameterSetId (nal, isH264, kind) {
  try {
    if (isH264) {
      if (kind === 's') return nal.length > 4 ? new BitReader(toRbsp(nal, 4)).ue() : -1
      return new BitReader(toRbsp(nal, 1)).ue()
    }
    // HEVC puts the id in the first bits after the two-byte NAL header: 4 for
    // VPS, 4 (after the sub-layer fields) for SPS, ue for PPS.
    const br = new BitReader(toRbsp(nal, 2))
    if (kind === 'v') return br.u(4)
    if (kind === 's') return br.u(4)
    return br.ue()
  } catch {
    return -1
  }
}

/** Whether a NAL contributes nothing to a length-prefixed sample. */
function isDroppable (nal, isH264) {
  if (isH264) {
    const t = h264NalType(nal)
    return t === H264_SPS || t === H264_PPS || t === H264_AUD
  }
  const t = h265NalType(nal)
  return t === H265_VPS || t === H265_SPS || t === H265_PPS || t === H265_AUD
}

/**
 * Converts one Annex-B access unit into MP4 sample bytes.
 *
 * Parameter sets and access-unit delimiters come out, because avc1/hvc1 carry
 * the former in the sample entry and have no use for the latter. Everything
 * else -- slices and SEI alike -- is copied verbatim behind a 4-byte length.
 */
export function annexBToLengthPrefixed (payload, isH264, params) {
  const nals = splitAnnexB(payload)
  if (params) params.collect(nals)

  let total = 0
  const keep = []
  for (const nal of nals) {
    if (nal.length === 0) continue
    if (isDroppable(nal, isH264)) continue
    keep.push(nal)
    total += 4 + nal.length
  }
  if (!keep.length) return null

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let o = 0
  for (const nal of keep) {
    view.setUint32(o, nal.length)
    out.set(nal, o + 4)
    o += 4 + nal.length
  }
  return out
}

/** Fields an H.264 `avcC` needs beyond the parameter sets themselves. */
function parseH264Sps (sps) {
  const out = { profile: sps[1] || 0, compat: sps[2] || 0, level: sps[3] || 0, chroma: 1, lumaDepth: 0, chromaDepth: 0 }
  // Only the High-family profiles carry chroma and bit-depth in the SPS; for the
  // rest 4:2:0 8-bit is the only thing the syntax allows.
  if (![100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(out.profile)) return out
  try {
    const br = new BitReader(toRbsp(sps, 4))
    br.ue()                                  // seq_parameter_set_id
    out.chroma = br.ue()
    if (out.chroma === 3) br.u(1)            // separate_colour_plane_flag
    out.lumaDepth = br.ue()
    out.chromaDepth = br.ue()
  } catch { /* leave the 4:2:0 8-bit defaults */ }
  return out
}

/**
 * `avcC` -- AVCDecoderConfigurationRecord, ISO/IEC 14496-15 section 5.3.3.1.
 */
export function buildAvcC (params) {
  const sps = params.sps
  const pps = params.pps
  if (!sps.length || !pps.length) return null
  const info = parseH264Sps(sps[0])

  const parts = []
  const head = [1, info.profile, info.compat, info.level, 0xff, 0xe0 | Math.min(31, sps.length)]
  parts.push(Uint8Array.from(head))
  for (const s of sps) parts.push(withLength16(s))
  parts.push(Uint8Array.from([Math.min(255, pps.length)]))
  for (const p of pps) parts.push(withLength16(p))

  // The trailing block is defined only for the High-family profiles.
  if (info.profile === 100 || info.profile === 110 || info.profile === 122 || info.profile === 144) {
    parts.push(Uint8Array.from([
      0xfc | (info.chroma & 3),
      0xf8 | (info.lumaDepth & 7),
      0xf8 | (info.chromaDepth & 7),
      0
    ]))
  }
  return concat(parts)
}

/**
 * The parts of an HEVC SPS an `hvcC` restates: the profile_tier_level block, and
 * the chroma format and bit depths that follow it.
 */
function parseH265Sps (sps) {
  const out = {
    profileSpace: 0,
    tier: 0,
    profileIdc: 1,
    compat: 0,
    constraints: [0, 0, 0, 0, 0, 0],
    level: 0,
    chroma: 1,
    lumaDepth: 0,
    chromaDepth: 0,
    numTemporalLayers: 1,
    temporalIdNested: 0
  }
  try {
    const br = new BitReader(toRbsp(sps, 2))
    br.u(4)                                       // sps_video_parameter_set_id
    const maxSubLayersMinus1 = br.u(3)
    out.numTemporalLayers = maxSubLayersMinus1 + 1
    out.temporalIdNested = br.u(1)

    out.profileSpace = br.u(2)
    out.tier = br.u(1)
    out.profileIdc = br.u(5)
    out.compat = br.u(32) >>> 0
    for (let i = 0; i < 6; i++) out.constraints[i] = br.u(8)
    out.level = br.u(8)

    // Sub-layer profile/level presence, then the fixed 2-bit padding the syntax
    // inserts when there is more than one sub-layer.
    const profilePresent = []
    const levelPresent = []
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      profilePresent.push(br.u(1))
      levelPresent.push(br.u(1))
    }
    if (maxSubLayersMinus1 > 0) {
      for (let i = maxSubLayersMinus1; i < 8; i++) br.u(2)
    }
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      if (profilePresent[i]) { br.u(32); br.u(32); br.u(24) }   // 88 bits
      if (levelPresent[i]) br.u(8)
    }

    br.ue()                                       // sps_seq_parameter_set_id
    out.chroma = br.ue()
    if (out.chroma === 3) br.u(1)                 // separate_colour_plane_flag
    br.ue()                                       // pic_width_in_luma_samples
    br.ue()                                       // pic_height_in_luma_samples
    if (br.u(1)) { br.ue(); br.ue(); br.ue(); br.ue() }  // conformance window
    out.lumaDepth = br.ue()
    out.chromaDepth = br.ue()
  } catch { /* the profile defaults above still produce a usable record */ }
  return out
}

/**
 * `hvcC` -- HEVCDecoderConfigurationRecord, ISO/IEC 14496-15 section 8.3.3.1.
 */
export function buildHvcC (params) {
  const sps = params.sps
  if (!sps.length || !params.pps.length) return null
  const info = parseH265Sps(sps[0])

  const arrays = [
    [H265_VPS, params.vps],
    [H265_SPS, params.sps],
    [H265_PPS, params.pps]
  ].filter(([, list]) => list.length > 0)

  const head = new Uint8Array(23)
  const view = new DataView(head.buffer)
  head[0] = 1
  head[1] = ((info.profileSpace & 3) << 6) | ((info.tier & 1) << 5) | (info.profileIdc & 31)
  view.setUint32(2, info.compat >>> 0)
  for (let i = 0; i < 6; i++) head[6 + i] = info.constraints[i]
  head[12] = info.level
  view.setUint16(13, 0xf000)                    // reserved | min_spatial_segmentation_idc = 0
  head[15] = 0xfc                               // reserved | parallelismType = 0
  head[16] = 0xfc | (info.chroma & 3)
  head[17] = 0xf8 | (info.lumaDepth & 7)
  head[18] = 0xf8 | (info.chromaDepth & 7)
  view.setUint16(19, 0)                         // avgFrameRate: 0 = unspecified
  // constantFrameRate 0 | numTemporalLayers | temporalIdNested | lengthSizeMinusOne 3
  head[21] = ((info.numTemporalLayers & 7) << 3) | ((info.temporalIdNested & 1) << 2) | 3
  head[22] = arrays.length

  const parts = [head]
  for (const [type, list] of arrays) {
    const hdr = new Uint8Array(3)
    // array_completeness set: every parameter set of this type is in here.
    hdr[0] = 0x80 | (type & 0x3f)
    new DataView(hdr.buffer).setUint16(1, list.length)
    parts.push(hdr)
    for (const nal of list) parts.push(withLength16(nal))
  }
  return concat(parts)
}

function withLength16 (bytes) {
  const out = new Uint8Array(2 + bytes.length)
  new DataView(out.buffer).setUint16(0, bytes.length)
  out.set(bytes, 2)
  return out
}

export function concat (parts) {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/**
 * Sample entry to use for a given source stream tag, or null when MP4 has none.
 *
 * The tag is a BVR FourCC where the source is a BVR recording and an MP4 sample
 * entry type where it is an MP4, because that is what each container calls the
 * same thing. Mapping both here is what lets an MP4 be exported -- trimmed, or
 * with one of two video tracks picked -- by the same copy path a BVR uses.
 *
 * `avc3` and `hev1` differ from `avc1`/`hvc1` only in carrying their parameter
 * sets in the samples as well as in the sample entry. Writing them out as the
 * latter is safe: the parameter sets stay where they are, and a decoder that
 * meets them again in the bitstream ignores them.
 */
const SAMPLE_ENTRIES = {
  H264: 'avc1',
  H265: 'hvc1',
  avc1: 'avc1',
  avc3: 'avc1',
  hvc1: 'hvc1',
  hev1: 'hvc1'
}

export function sampleEntryFor (fourcc) {
  return SAMPLE_ENTRIES[fourcc] || null
}

/** Whether a stream can be copied into MP4 without re-encoding. */
export function canRemux (fourcc) {
  return sampleEntryFor(fourcc) !== null
}

/**
 * Whether a source's samples are already in MP4 form.
 *
 * BVR stores Annex-B access units that have to be rewritten with length prefixes
 * before they can be a sample; an MP4's samples are already exactly that, so
 * copying one into another container is a byte-for-byte move. The parameter sets
 * are likewise already in hand as an `avcC`/`hvcC`, so nothing has to be
 * collected from the bitstream on the way past.
 */
export function isLengthPrefixed (fourcc) {
  return fourcc === 'avc1' || fourcc === 'avc3' || fourcc === 'hvc1' || fourcc === 'hev1'
}

export function buildDecoderConfig (fourcc, params) {
  return fourcc === 'H264' ? buildAvcC(params) : buildHvcC(params)
}
