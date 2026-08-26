import { find, typeAt } from './boxes.js'
import { WAVE_FORMAT_PCM, WAVE_FORMAT_ALAW, WAVE_FORMAT_MULAW } from '../bvr/constants.js'

/**
 * Turns an MP4 sample entry into the decoder configuration WebCodecs wants.
 *
 * The counterpart of `src/bvr/codec.js`, and the contrast between the two is the
 * whole reason MP4 support is cheap here. BVR stores Annex-B elementary streams
 * with the parameter sets repeated in-band, so that module has to parse an SPS
 * out of a key frame to learn what the stream is. MP4 wrote all of that down at
 * authoring time: the sample entry gives the coded size, and the `avcC`/`hvcC`
 * inside it is *already* the byte string WebCodecs takes as `description`. The
 * only real work is turning the first few bytes of that record into the codec
 * string, which the API insists on separately.
 *
 * The shape returned matches `describeVideoCodec` exactly -- kind/label/width/
 * height/declaredWidth/declaredHeight/config -- because everything downstream of
 * the probe reads that shape and must not care which container it came from.
 */

const hex2 = (v) => v.toString(16).padStart(2, '0')

const H264_PROFILES = {
  66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High',
  110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4'
}
const HEVC_PROFILES = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions' }

/** A copy of a box's payload that outlives the buffer it was read from. */
function payloadOf (bytes, box) {
  return bytes.slice(box.body, box.end)
}

/**
 * A visual sample entry's fixed fields, ahead of its child boxes.
 *
 * Six reserved bytes and a data-reference index, then 70 bytes of largely
 * vestigial QuickTime baggage in which only width and height are worth reading.
 */
function visualEntry (bytes, view, entry) {
  const at = entry.body
  return {
    width: view.getUint16(at + 24),
    height: view.getUint16(at + 26),
    childrenFrom: at + 78
  }
}

/**
 * An audio sample entry's fixed fields.
 *
 * Version 1 and 2 entries are a QuickTime extension that inserts extra fields
 * before the child boxes; ignoring the version is how a `.mov` ends up feeding
 * its `esds` bytes to the decoder as if they were an `alac` box.
 */
function audioEntry (bytes, view, entry) {
  const at = entry.body
  const version = view.getUint16(at + 8)
  let childrenFrom = at + 28
  let channels = view.getUint16(at + 16)
  let sampleSize = view.getUint16(at + 18)
  // 16.16 fixed point, and the fractional half is always zero in practice.
  let sampleRate = view.getUint32(at + 24) / 65536

  if (version === 1) {
    childrenFrom = at + 28 + 16
  } else if (version === 2) {
    // A version 2 entry restates everything in a fixed block of its own.
    channels = view.getUint32(at + 40)
    sampleSize = view.getUint32(at + 44)
    const hi = view.getUint32(at + 32)
    const lo = view.getUint32(at + 36)
    // float64 big-endian
    sampleRate = new DataView(Uint32Array.from([hi, lo]).buffer).getFloat64(0) || sampleRate
    childrenFrom = at + 28 + 36
  }
  return { channels: channels || 1, sampleSize, sampleRate: Math.round(sampleRate), childrenFrom, version }
}

/** The codec string for an `avcC`, per ISO/IEC 14496-15. */
function avcCodecString (fourcc, avcC) {
  if (!avcC || avcC.length < 4) return { codec: `${fourcc}.640028`, label: 'H.264' }
  const profile = avcC[1]
  const compat = avcC[2]
  const level = avcC[3]
  return {
    codec: `${fourcc}.${hex2(profile)}${hex2(compat)}${hex2(level)}`,
    label: `H.264 ${H264_PROFILES[profile] || `profile ${profile}`} @ L${(level / 10).toFixed(1)}`
  }
}

/**
 * The codec string for an `hvcC`.
 *
 * Every field the string needs sits in the first thirteen bytes of the record,
 * in the same order and meaning as in the SPS's `profile_tier_level` -- so this
 * says exactly what `hevcFromSps` in the BVR codec module says, but without
 * having to unpick a bitstream to get there. The compatibility flags are
 * bit-reversed in the string, which is a genuine quirk of the specification and
 * not a mistake here.
 */
function hevcCodecString (fourcc, hvcC) {
  if (!hvcC || hvcC.length < 13) return { codec: `${fourcc}.1.6.L93.B0`, label: 'H.265' }
  const profileSpace = (hvcC[1] >> 6) & 3
  const tier = (hvcC[1] >> 5) & 1
  const profileIdc = hvcC[1] & 0x1f
  const compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0
  const constraints = [hvcC[6], hvcC[7], hvcC[8], hvcC[9], hvcC[10], hvcC[11]]
  const level = hvcC[12]

  let reversed = 0
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) reversed |= 1 << (31 - i)
  reversed >>>= 0

  const spacePrefix = profileSpace === 0 ? '' : String.fromCharCode(64 + profileSpace)
  let codec = `${fourcc}.${spacePrefix}${profileIdc}.${reversed.toString(16)}.${tier ? 'H' : 'L'}${level}`
  const trimmed = constraints.slice()
  while (trimmed.length && trimmed[trimmed.length - 1] === 0) trimmed.pop()
  for (const c of trimmed) codec += `.${c.toString(16).toUpperCase().padStart(2, '0')}`

  return {
    codec,
    label: `H.265 ${HEVC_PROFILES[profileIdc] || `profile ${profileIdc}`} @ ${tier ? 'High' : 'Main'} L${(level / 30).toFixed(1)}`
  }
}

/** The codec string for an AV1 configuration record (`av1C`). */
function av1CodecString (av1C) {
  if (!av1C || av1C.length < 4) return { codec: 'av01.0.08M.08', label: 'AV1' }
  const profile = (av1C[1] >> 5) & 7
  const level = av1C[1] & 0x1f
  const tier = (av1C[2] >> 7) & 1
  const highBitdepth = (av1C[2] >> 6) & 1
  const twelveBit = (av1C[2] >> 5) & 1
  const depth = twelveBit ? 12 : highBitdepth ? 10 : 8
  const codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`
  return { codec, label: `AV1 profile ${profile}` }
}

/** The codec string for a VP9 configuration record (`vpcC`). */
function vp9CodecString (vpcC) {
  if (!vpcC || vpcC.length < 8) return { codec: 'vp09.00.10.08', label: 'VP9' }
  // A FullBox: four bytes of version/flags ahead of the record itself.
  const profile = vpcC[4]
  const level = vpcC[5]
  const depth = (vpcC[6] >> 4) & 0x0f
  const codec = `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`
  return { codec, label: `VP9 profile ${profile}` }
}

/** A `pasp` box: the anamorphic pixel shape the author recorded. */
function readPasp (bytes, view, from, to) {
  const pasp = find(bytes, from, to, 'pasp')
  if (!pasp) return null
  const h = view.getUint32(pasp.body)
  const v = view.getUint32(pasp.body + 4)
  if (!h || !v) return null
  return { hSpacing: h, vSpacing: v }
}

/**
 * Describes a video sample entry.
 *
 * `declaredWidth`/`declaredHeight` mean here what they mean for BVR: the shape
 * the file *claims* the picture should be seen in, as opposed to the coded size
 * the decoder will actually emit. In an MP4 that claim lives in the `tkhd`
 * dimensions and in `pasp`, which is the same anamorphic story Blue Iris tells
 * by declaring one resolution and encoding another -- so the player's existing
 * aspect correction applies unchanged.
 */
export function describeVideoEntry (bytes, entry, track) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fourcc = typeAt(view, entry.start + 4)
  const { width, height, childrenFrom } = visualEntry(bytes, view, entry)
  const pasp = readPasp(bytes, view, childrenFrom, entry.end)

  // The presentation shape, in order of authority: the track header's own
  // dimensions where they are sane, then the pixel aspect applied to the coded
  // size, then the coded size itself.
  let declaredWidth = Math.round(track.trackWidth) || 0
  let declaredHeight = Math.round(track.trackHeight) || 0
  if ((!declaredWidth || !declaredHeight) && pasp) {
    declaredWidth = Math.round((width * pasp.hSpacing) / pasp.vSpacing)
    declaredHeight = height
  }
  if (!declaredWidth || !declaredHeight) {
    declaredWidth = width
    declaredHeight = height
  }
  // A rotated track states its presentation size already rotated; the aspect
  // reference the player works in is the unrotated one.
  if (track.rotation === 90 || track.rotation === 270) {
    const t = declaredWidth
    declaredWidth = declaredHeight
    declaredHeight = t
  }

  const base = {
    width: width || declaredWidth,
    height: height || declaredHeight,
    declaredWidth,
    declaredHeight,
    pasp,
    entryType: fourcc
  }

  const configFor = (info, description) => ({
    ...base,
    kind: 'video',
    label: info.label,
    config: {
      codec: info.codec,
      codedWidth: base.width || undefined,
      codedHeight: base.height || undefined,
      hardwareAcceleration: 'no-preference',
      // The one line that makes all of this work: MP4 samples are
      // length-prefixed and their parameter sets live here rather than in the
      // bitstream, which is exactly what `description` is for. The BVR path
      // omits it and feeds Annex-B; the pipeline never has to know which.
      ...(description && description.length ? { description } : {}),
      optimizeForLatency: true
    }
  })

  if (fourcc === 'avc1' || fourcc === 'avc3') {
    const box = find(bytes, childrenFrom, entry.end, 'avcC')
    const avcC = box ? payloadOf(bytes, box) : null
    // `avc3` carries its parameter sets in the samples themselves, so handing
    // the decoder a description as well is redundant but harmless -- and the
    // record is still where the codec string comes from.
    return configFor(avcCodecString('avc1', avcC), avcC)
  }

  if (fourcc === 'hvc1' || fourcc === 'hev1' || fourcc === 'dvh1' || fourcc === 'dvhe') {
    const box = find(bytes, childrenFrom, entry.end, 'hvcC')
    const hvcC = box ? payloadOf(bytes, box) : null
    // Dolby Vision profiles that are backwards compatible carry a plain `hvcC`
    // alongside; decoding it as HEVC gives the base layer, which is a picture.
    const prefix = fourcc === 'hev1' ? 'hev1' : 'hvc1'
    return configFor(hevcCodecString(prefix, hvcC), hvcC)
  }

  if (fourcc === 'av01') {
    const box = find(bytes, childrenFrom, entry.end, 'av1C')
    const av1C = box ? payloadOf(bytes, box) : null
    return configFor(av1CodecString(av1C), av1C)
  }

  if (fourcc === 'vp09') {
    const box = find(bytes, childrenFrom, entry.end, 'vpcC')
    const vpcC = box ? payloadOf(bytes, box) : null
    return configFor(vp9CodecString(vpcC), vpcC)
  }

  if (fourcc === 'vp08') {
    return configFor({ codec: 'vp8', label: 'VP8' }, null)
  }

  if (fourcc === 'jpeg' || fourcc === 'mjpa' || fourcc === 'mjpb' || fourcc === 'MJPG') {
    // Each sample is a complete JPEG, which is the same thing MJPEG means in a
    // BVR file -- so it takes the same image path through the pipeline.
    return { ...base, kind: 'image', mime: 'image/jpeg', label: 'Motion JPEG' }
  }

  return {
    ...base,
    kind: 'unsupported',
    label: describeUnknown(fourcc)
  }
}

function describeUnknown (fourcc) {
  const clean = fourcc.replace(/[^\x20-\x7e]/g, '?')
  if (clean === 'mp4v') return 'MPEG-4 Part 2 / "mp4v"'
  if (clean === 's263' || clean === 'h263') return 'H.263 / "' + clean + '"'
  return `"${clean}"`
}

/**
 * Walks an MPEG-4 elementary stream descriptor for the two things that matter:
 * what the codec is, and the codec-specific setup bytes.
 *
 * The descriptor format is a nest of tag/length records with a length encoding
 * borrowed from ASN.1 -- seven bits a byte, high bit meaning "another byte
 * follows" -- which is why this is more code than reading a box.
 */
function parseEsds (payload) {
  let p = 4 // FullBox version and flags
  const end = payload.length
  const readLength = () => {
    let len = 0
    for (let i = 0; i < 4 && p < end; i++) {
      const b = payload[p++]
      len = (len << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
    return len
  }

  let objectType = 0
  let specific = null

  const descend = (limit) => {
    while (p + 2 <= limit) {
      const tag = payload[p++]
      const len = readLength()
      const stop = Math.min(limit, p + len)
      if (tag === 0x03) {
        // ES_Descriptor: id, then flags whose bits announce optional fields.
        p += 2
        const flags = payload[p++]
        if (flags & 0x80) p += 2      // dependsOn_ES_ID
        if (flags & 0x40) p += 1 + (payload[p] || 0) // URL
        if (flags & 0x20) p += 2      // OCR_ES_Id
        descend(stop)
      } else if (tag === 0x04) {
        // DecoderConfigDescriptor: the object type, then buffer/bitrate fields.
        objectType = payload[p]
        p += 13
        descend(stop)
      } else if (tag === 0x05) {
        // DecoderSpecificInfo -- for AAC this is the AudioSpecificConfig, which
        // is exactly what WebCodecs wants as `description`.
        specific = payload.slice(p, stop)
        p = stop
      } else {
        p = stop
      }
      if (p < stop) p = stop
    }
  }
  descend(end)
  return { objectType, specific }
}

/** The AAC audio object type, which the codec string names explicitly. */
function aacObjectType (asc) {
  if (!asc || !asc.length) return 2
  let aot = asc[0] >> 3
  if (aot === 31 && asc.length >= 2) {
    aot = 32 + (((asc[0] & 0x07) << 3) | (asc[1] >> 5))
  }
  return aot || 2
}

/**
 * Rebuilds an `OpusHead` from a `dOps` box.
 *
 * The two records hold the same fields in the same order, and differ only in
 * that the box omits the magic and the version and stores its multi-byte fields
 * big-endian while the header they came from is little-endian. WebCodecs asks
 * for the header, so it has to be put back together.
 */
function opusHeadFromDOps (dOps) {
  if (!dOps || dOps.length < 11) return null
  const channels = dOps[1]
  const preSkip = (dOps[2] << 8) | dOps[3]
  const rate = (dOps[4] << 24 | dOps[5] << 16 | dOps[6] << 8 | dOps[7]) >>> 0
  const gain = (dOps[8] << 8) | dOps[9]
  const family = dOps[10]
  const tail = family === 0 ? 0 : dOps.length - 11
  const out = new Uint8Array(19 + tail)
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0) // "OpusHead"
  out[8] = 1
  out[9] = channels
  const dv = new DataView(out.buffer)
  dv.setUint16(10, preSkip, true)
  dv.setUint32(12, rate, true)
  dv.setUint16(16, gain, true)
  out[18] = family
  if (tail > 0) out.set(dOps.subarray(11), 19)
  return out
}

/** A WebCodecs FLAC description: the stream marker plus the metadata blocks. */
function flacDescriptionFromDfLa (dfLa) {
  if (!dfLa || dfLa.length < 4) return null
  const blocks = dfLa.subarray(4) // past the FullBox version and flags
  const out = new Uint8Array(4 + blocks.length)
  out.set([0x66, 0x4c, 0x61, 0x43], 0) // "fLaC"
  out.set(blocks, 4)
  return out
}

/**
 * Describes an audio sample entry.
 *
 * Two outcomes matter to the caller. A `config` means the packets go to a
 * WebCodecs `AudioDecoder`; a `wfx` means they are raw samples the player's own
 * simple decoder can expand, which is the path uncompressed and G.711 audio
 * takes in a BVR file too.
 */
export function describeAudioEntry (bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fourcc = typeAt(view, entry.start + 4)
  const info = audioEntry(bytes, view, entry)
  const base = {
    entryType: fourcc,
    channels: info.channels,
    sampleRate: info.sampleRate,
    sampleSize: info.sampleSize
  }

  if (fourcc === 'mp4a') {
    const box = find(bytes, info.childrenFrom, entry.end, 'esds')
    const esds = box ? payloadOf(bytes, box) : null
    const { objectType, specific } = esds ? parseEsds(esds) : { objectType: 0x40, specific: null }

    if (objectType === 0x69 || objectType === 0x6b) {
      return { ...base, kind: 'codec', label: 'MP3', config: { codec: 'mp3', sampleRate: info.sampleRate, numberOfChannels: info.channels } }
    }
    const aot = aacObjectType(specific)
    return {
      ...base,
      kind: 'codec',
      label: aot === 5 ? 'AAC-HE' : aot === 29 ? 'AAC-HEv2' : 'AAC',
      config: {
        codec: `mp4a.40.${aot}`,
        sampleRate: info.sampleRate,
        numberOfChannels: info.channels,
        ...(specific && specific.length ? { description: specific } : {})
      }
    }
  }

  if (fourcc === 'Opus') {
    const box = find(bytes, info.childrenFrom, entry.end, 'dOps')
    const description = box ? opusHeadFromDOps(payloadOf(bytes, box)) : null
    return {
      ...base,
      kind: 'codec',
      label: 'Opus',
      config: {
        codec: 'opus',
        sampleRate: info.sampleRate || 48000,
        numberOfChannels: info.channels,
        ...(description ? { description } : {})
      }
    }
  }

  if (fourcc === 'fLaC') {
    const box = find(bytes, info.childrenFrom, entry.end, 'dfLa')
    const description = box ? flacDescriptionFromDfLa(payloadOf(bytes, box)) : null
    return {
      ...base,
      kind: 'codec',
      label: 'FLAC',
      config: {
        codec: 'flac',
        sampleRate: info.sampleRate,
        numberOfChannels: info.channels,
        ...(description ? { description } : {})
      }
    }
  }

  // Everything below is expanded by the player's own decoder rather than by
  // WebCodecs, so it is described the way a BVR header would describe it.
  const pcm = (tag, bits, bigEndian) => ({
    ...base,
    kind: 'raw',
    label: tag === WAVE_FORMAT_MULAW
      ? 'G.711 mu-law'
      : tag === WAVE_FORMAT_ALAW ? 'G.711 A-law' : `PCM ${bits}-bit`,
    wfx: {
      wFormatTag: tag,
      nChannels: info.channels,
      nSamplesPerSec: info.sampleRate,
      nAvgBytesPerSec: (info.sampleRate * info.channels * bits) / 8,
      nBlockAlign: (info.channels * bits) / 8,
      wBitsPerSample: bits,
      cbSize: 0,
      bigEndian: !!bigEndian
    }
  })

  if (fourcc === 'ulaw') return pcm(WAVE_FORMAT_MULAW, 8, false)
  if (fourcc === 'alaw') return pcm(WAVE_FORMAT_ALAW, 8, false)
  if (fourcc === 'sowt') return pcm(WAVE_FORMAT_PCM, info.sampleSize || 16, false)
  if (fourcc === 'twos') return pcm(WAVE_FORMAT_PCM, info.sampleSize || 16, true)
  if (fourcc === 'raw ') return pcm(WAVE_FORMAT_PCM, 8, false)
  if (fourcc === 'lpcm') return pcm(WAVE_FORMAT_PCM, info.sampleSize || 16, false)
  if (fourcc === 'in24') return pcm(WAVE_FORMAT_PCM, 24, true)
  if (fourcc === 'in32') return pcm(WAVE_FORMAT_PCM, 32, true)

  return { ...base, kind: 'unsupported', label: `"${fourcc.replace(/[^\x20-\x7e]/g, '?')}"` }
}
