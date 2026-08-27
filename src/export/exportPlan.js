import { frameIndexForTime } from '../bvr/indexer.js'
import { canRemux, sampleEntryFor } from './bitstream.js'
import { WAVE_FORMAT_FLAC, WAVE_FORMAT_PCM } from '../bvr/constants.js'
import { audioCodecLabel, packetStartTimes } from '../player/audioCodecs.js'
import { displaySize, pixelAspect } from '../util/aspect.js'

/**
 * Works out what an export would actually do, before anything is written.
 *
 * Every awkward property of the format shows up here rather than halfway
 * through a gigabyte of output: that a stream copy has to begin on a key frame,
 * that a switching-mode recording changes resolution mid-file, that MJPEG has no
 * useful MP4 form, and that none of the audio codecs BVR carries is one MP4
 * takes. The dialog renders this object, so what the user is told and what the
 * job does come from a single description.
 */

export const MODE_REMUX = 'remux'
export const MODE_TRANSCODE = 'transcode'

export const AUDIO_AAC = 'aac'
export const AUDIO_NONE = 'none'

/** Video ticks per second in the output. Divides 1 ms exactly. */
export const VIDEO_TIMESCALE = 90000

export const TRANSCODE_CODECS = [
  { value: 'avc', label: 'H.264', entry: 'avc1' },
  { value: 'hevc', label: 'H.265', entry: 'hvc1' }
]

/**
 * Levels, and why the codec string cannot be a constant.
 *
 * A codec string names a level, and a level is a promise about how large and
 * how fast the stream will be. Encoders are entitled to hold you to it: ask for
 * High@4.0 -- 8192 macroblocks, about 2048x1024 -- and hand over 2560x1440, and
 * a conforming encoder answers `supported: false`. Hardware encoders are queried
 * against a profile-and-resolution table that never looks at the level and so
 * accept it anyway, which is what makes this fail the way it does: the same
 * clip exports fine until something pushes the browser onto its software
 * encoder, and from then on every export of every file is rejected until the
 * page is reloaded. The level therefore has to be computed from the output.
 *
 * Both tables are ordered, and the entry picked is the first that fits.
 */
const AVC_LEVELS = [
  { idc: 0x1e, maxFS: 1620, maxMBPS: 40500 },       // 3.0
  { idc: 0x1f, maxFS: 3600, maxMBPS: 108000 },      // 3.1
  { idc: 0x20, maxFS: 5120, maxMBPS: 216000 },      // 3.2
  { idc: 0x28, maxFS: 8192, maxMBPS: 245760 },      // 4.0
  { idc: 0x2a, maxFS: 8704, maxMBPS: 522240 },      // 4.2
  { idc: 0x32, maxFS: 22080, maxMBPS: 589824 },     // 5.0
  { idc: 0x33, maxFS: 36864, maxMBPS: 983040 },     // 5.1
  { idc: 0x34, maxFS: 36864, maxMBPS: 2073600 },    // 5.2
  { idc: 0x3c, maxFS: 139264, maxMBPS: 4177920 },   // 6.0
  { idc: 0x3d, maxFS: 139264, maxMBPS: 8355840 },   // 6.1
  { idc: 0x3e, maxFS: 139264, maxMBPS: 16711680 }   // 6.2
]

const HEVC_LEVELS = [
  { idc: 90, maxLumaPs: 552960, maxLumaSr: 16588800 },        // 3.0
  { idc: 93, maxLumaPs: 983040, maxLumaSr: 33177600 },        // 3.1
  { idc: 120, maxLumaPs: 2228224, maxLumaSr: 66846720 },      // 4.0
  { idc: 123, maxLumaPs: 2228224, maxLumaSr: 133693440 },     // 4.1
  { idc: 150, maxLumaPs: 8912896, maxLumaSr: 267386880 },     // 5.0
  { idc: 153, maxLumaPs: 8912896, maxLumaSr: 534773760 },     // 5.1
  { idc: 156, maxLumaPs: 8912896, maxLumaSr: 1069547520 },    // 5.2
  { idc: 180, maxLumaPs: 35651584, maxLumaSr: 1069547520 },   // 6.0
  { idc: 183, maxLumaPs: 35651584, maxLumaSr: 2139095040 },   // 6.1
  { idc: 186, maxLumaPs: 35651584, maxLumaSr: 4278190080 }    // 6.2
]

/**
 * A rate to size the level against.
 *
 * Rounded rather than rounded up, because a measured rate is never exact: a
 * nominal 30 fps camera measures 30.11 across a range, and rounding that up
 * costs a plain 1080p clip its level 4.0 -- the level every player handles --
 * for a 4.2 nothing else about the file justifies. Unusable timing falls back
 * to 30, which is the busiest thing a surveillance recording is likely to be.
 */
const levelFps = (fps) => (fps > 0 && fps < 1000 ? Math.max(1, Math.round(fps)) : 30)

/**
 * Every codec string for `value` that is at least large enough for the output,
 * smallest first.
 *
 * More than one, because the first is only the smallest level that is *legal*.
 * An encoder may still refuse it -- a hardware encoder that reports a narrow
 * level range, a software one stricter about the bit rate a level allows -- and
 * trying the next one up costs nothing but is the difference between an export
 * that runs and an error message.
 */
export function transcodeCodecStrings (value, width, height, fps) {
  const rate = levelFps(fps)
  if (value === 'hevc') {
    const ps = width * height
    const sr = ps * rate
    return HEVC_LEVELS
      .filter((l) => l.maxLumaPs >= ps && l.maxLumaSr >= sr)
      .map((l) => `hev1.1.6.L${l.idc}.B0`)
  }
  // Macroblocks are 16x16, and a dimension that is not a multiple of 16 still
  // costs a whole row or column of them.
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16)
  const mbps = fs * rate
  return AVC_LEVELS
    .filter((l) => l.maxFS >= fs && l.maxMBPS >= mbps)
    .map((l) => `avc1.6400${l.idc.toString(16).padStart(2, '0')}`)
}

/** The smallest codec string that fits, which is what the plan reports. */
export function transcodeCodecString (value, width, height, fps) {
  const all = transcodeCodecStrings(value, width, height, fps)
  return all[0] || (value === 'hevc' ? 'hev1.1.6.L186.B0' : 'avc1.64003e')
}

/**
 * The samples a re-encode would write, for a display shape and a height cap.
 *
 * Shared rather than inlined because the panel asks the same question the plan
 * does -- "what size would this come out at?" -- when it is working out which
 * smaller size the encoder would accept, and two copies of the rounding would
 * eventually disagree about a pixel.
 */
export function outputSize (displayWidth, displayHeight, maxHeight) {
  // Encoders reject odd dimensions for 4:2:0 chroma, and the corrected size is
  // as likely to be odd as any other.
  const even = (v) => Math.max(2, Math.round(v / 2) * 2)
  const capHeight = maxHeight > 0 ? Math.min(maxHeight, displayHeight) : displayHeight
  const scale = displayHeight > 0 ? capHeight / displayHeight : 1
  return { width: even(displayWidth * scale), height: even(capHeight) }
}

/**
 * The encoder configuration this device will actually accept, or null.
 *
 * Asked twice: by the job, which needs one to run, and by the panel, which asks
 * ahead of time so that "this device cannot encode that" is something the user
 * reads while they can still choose a smaller size, rather than an error after
 * they have picked a filename. One implementation so the two cannot disagree.
 *
 * The candidates differ only in level. The smallest legal one is tried first
 * because it is the most widely supported; the rest are there for encoders that
 * advertise a narrower range than the output needs, and cost one
 * `isConfigSupported` call each.
 */
export async function chooseEncoderConfig ({ codec, width, height, fps, bitrate }) {
  if (typeof VideoEncoder === 'undefined') return null
  const hevc = codec === 'hevc'
  const base = {
    width,
    height,
    bitrate,
    framerate: fps > 0 ? fps : undefined,
    // Encoders may emit B-frames when left to optimise for quality, which would
    // put the samples out of presentation order. The muxer can express that, but
    // a surveillance clip has nothing to gain from it.
    latencyMode: 'realtime'
  }
  base[hevc ? 'hevc' : 'avc'] = { format: hevc ? 'hevc' : 'avc' }

  const tried = []
  for (const codecString of transcodeCodecStrings(codec, width, height, fps)) {
    const config = { ...base, codec: codecString }
    tried.push(codecString)
    let support = null
    try {
      support = await VideoEncoder.isConfigSupported(config)
    } catch { /* an outright rejection of the string; try the next level */ }
    if (support && support.supported) {
      return { config: support.config || config, codecString, tried, fallback: tried.length > 1 }
    }
  }
  return { config: null, codecString: '', tried, fallback: false }
}

export const SOURCE_MAIN = 'main'
export const SOURCE_SUB = 'sub'
export const SOURCE_BOTH = 'both'

export const DEFAULT_OPTIONS = {
  mode: MODE_REMUX,
  // Which of the recording's video streams the export is built from. 'both' is
  // the merged single-track sequence -- the main stream wherever it reaches,
  // the sub stream scaled up to fill the gaps -- which is what `auto` plays.
  source: SOURCE_MAIN,
  startMs: 0,
  endMs: Infinity,
  audio: AUDIO_AAC,
  audioBitrate: 128000,
  videoCodec: 'avc',
  videoBitrate: 8000000,
  maxHeight: 0,          // 0 = keep the source resolution
  fps: 0                 // 0 = keep the source frame timing
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Audio packets whose start time falls inside the trim range. */
function audioRange (index, audioStarts, startMs, endMs) {
  if (!audioStarts || !audioStarts.length) return { from: 0, to: -1, count: 0 }
  let from = 0
  while (from < audioStarts.length && audioStarts[from] < startMs) from++
  // One packet earlier so the range does not open with a gap where a packet
  // straddles the start.
  if (from > 0 && audioStarts[from - 1] < startMs) from--
  let to = from - 1
  while (to + 1 < audioStarts.length && audioStarts[to + 1] <= endMs) to++
  return { from, to, count: Math.max(0, to - from + 1) }
}

/**
 * Whether the source's audio can be moved into the output untouched.
 *
 * True only when it is already AAC, which in practice means the source is an
 * MP4. It is worth the test rather than always re-encoding: a copy is lossless,
 * it is far faster, and it is the only audio path at all in a browser with no
 * `AudioEncoder`.
 */
function audioIsCopyable (header) {
  const stated = header.audioConfig
  if (!stated || stated.kind !== 'codec' || !stated.config) return false
  if (!stated.config.description || !stated.config.description.length) return false
  return /^mp4a\.40\./.test(stated.config.codec || '')
}

function describeAudio (header, index, audioStarts, options, range) {
  const stated = header.audioConfig
  const label = header.hasAudio ? (stated && stated.label) || audioCodecLabel(header.wfx) : ''
  if (!header.hasAudio || !index.audio.count) {
    return { include: false, label: '', note: 'This recording has no audio track.' }
  }
  if (options.audio === AUDIO_NONE) {
    return { include: false, label, note: 'Audio will be left out.' }
  }

  const copy = audioIsCopyable(header)
  if (!copy && typeof AudioEncoder === 'undefined') {
    return { include: false, label, note: 'Audio needs the WebCodecs AudioEncoder, which this browser does not have.' }
  }

  const tag = header.wfx.wFormatTag
  const native = stated
    ? label
    : tag === WAVE_FORMAT_PCM ? 'PCM' : tag === WAVE_FORMAT_FLAC ? 'FLAC' : 'G.711 mu-law'
  return {
    include: range.count > 0,
    label,
    copy,
    packets: range.count,
    from: range.from,
    to: range.to,
    // Nothing BVR can carry has a container form MP4 players can be relied on to
    // handle, so a BVR export always re-encodes. An MP4 source that is already
    // AAC is simply moved across.
    note: range.count === 0
      ? 'No audio packets fall inside the selected range.'
      : copy
        ? 'AAC is copied across without re-encoding.'
        : `${native} is re-encoded to AAC; MP4 has no practical container form for it.`
  }
}

/**
 * How a merged sequence's two streams fail to agree, as a clause.
 *
 * Both properties can be true at once, and a message that mentions one of them
 * describes the file wrongly: it says the copy would work if that one were
 * fixed. Empty for a single-stream sequence, which agrees with itself.
 */
function streamMismatch (pstream) {
  if (pstream.mixedCodecs && pstream.variableResolution) {
    return 'the two streams differ in both codec and size'
  }
  if (pstream.mixedCodecs) return 'the two streams use different codecs'
  if (pstream.variableResolution) return 'the two streams are different sizes'
  return ''
}

/**
 * A remux copies compressed frames untouched, so it can only begin where the
 * decoder can: at a key frame at or before the requested start.
 */
function videoRange (pstream, startMs, endMs, mode) {
  const first = frameIndexForTime(pstream, startMs)
  const last = frameIndexForTime(pstream, endMs)
  const keyIdx = Math.max(0, pstream.keyIdx[first] >= 0 ? pstream.keyIdx[first] : 0)
  return {
    // Both modes decode (or copy) from the key frame; only a transcode can then
    // throw the lead-in away and start exactly where it was asked to.
    decodeFrom: keyIdx,
    startIdx: mode === MODE_REMUX ? keyIdx : first,
    endIdx: Math.max(first, last),
    shifted: mode === MODE_REMUX && keyIdx < first
  }
}

/**
 * Describes the export implied by `options`.
 *
 * `pstream` is the sequence currently being played, so the export follows the
 * stream selection the user can already see rather than introducing a second,
 * invisible one.
 */
export function planExport ({ header, index, pstream, audioStarts, fileName, reference, options }) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const warnings = []
  const errors = []

  const duration = pstream.count ? pstream.ts[pstream.count - 1] : 0
  const startMs = clamp(opts.startMs, 0, duration)
  const endMs = clamp(opts.endMs === Infinity ? duration : opts.endMs, startMs, duration)

  const fourcc = pstream.fourcc || ''
  const copyable = canRemux(fourcc) && !pstream.variableResolution && !pstream.mixedCodecs
  // Why not, in the few words the dialog has room for, and every reason at once
  // rather than the first one found: naming only the codec mismatch reads as a
  // promise that matching codecs would copy, when a size mismatch would still
  // refuse. The long-form version is in `warnings`, but that only appears once a
  // copy has actually been asked for and refused -- this is what the disabled
  // radio says about itself.
  const copyBlocker = copyable
    ? ''
    : [
        canRemux(fourcc) ? '' : `${fourcc || 'this codec'} has no MP4 form`,
        streamMismatch(pstream)
      ].filter(Boolean).join(', and ').replace(/^./, (c) => c.toUpperCase())
  let mode = opts.mode

  if (mode === MODE_REMUX && !canRemux(fourcc)) {
    mode = MODE_TRANSCODE
    warnings.push(`${fourcc || 'This codec'} has no usable MP4 form, so the export re-encodes.`)
  } else if (mode === MODE_REMUX && (pstream.mixedCodecs || pstream.variableResolution)) {
    mode = MODE_TRANSCODE
    warnings.push(
      `This is a switching-mode recording: ${streamMismatch(pstream)}. One MP4 ` +
      'track holds one codec at one size, so the export re-encodes. Pick the main ' +
      'or sub stream on its own to copy frames instead.'
    )
  }

  if (mode === MODE_TRANSCODE && typeof VideoEncoder === 'undefined') {
    errors.push('Re-encoding needs the WebCodecs VideoEncoder, which this browser does not have.')
  }

  const range = videoRange(pstream, startMs, endMs, mode)
  const frames = Math.max(0, range.endIdx - range.startIdx + 1)
  if (frames === 0) errors.push('The selected range contains no frames.')
  if (range.shifted) {
    warnings.push(
      `A stream copy has to start on a key frame, so the export begins at ` +
      `${(pstream.ts[range.decodeFrom] / 1000).toFixed(2)}s rather than ` +
      `${(startMs / 1000).toFixed(2)}s. Re-encode to trim exactly.`
    )
  }

  // Playback hands over the table it already built; without it -- audio that
  // never started, or a caller outside the player -- rebuild it here, since the
  // stored per-packet timestamps are not start times (spec 6).
  const starts = audioStarts || index.audio.starts ||
    packetStartTimes(header.wfx, index.audio, header.audioExtradata)
  const audio = describeAudio(header, index, starts, opts, audioRange(index, starts, startMs, endMs))
  // The note only rises to a warning when it is telling the user about something
  // they might not want: a re-encode, or audio being left out. Audio that copies
  // across untouched is the good outcome and says so in the plan, not in a
  // warning list beside the genuine caveats.
  if (audio.include && audio.note && !audio.copy) warnings.push(audio.note)
  else if (!audio.include && audio.note && header.hasAudio && opts.audio !== AUDIO_NONE) warnings.push(audio.note)

  let videoBytes = 0
  for (let i = range.startIdx; i <= range.endIdx && i < pstream.count; i++) videoBytes += pstream.size[i]
  const spanMs = Math.max(1, pstream.ts[Math.min(range.endIdx, pstream.count - 1)] - pstream.ts[range.startIdx])
  const estimatedBytes = mode === MODE_REMUX
    ? videoBytes + Math.round(frames * 8) + (audio.include ? (spanMs / 1000) * (opts.audioBitrate / 8) : 0)
    : Math.round((spanMs / 1000) * ((opts.videoBitrate + (audio.include ? opts.audioBitrate : 0)) / 8))

  // The shape the player is showing this stream in. A remux cannot change the
  // pixels, so it says so in the container instead; a transcode is re-drawing
  // every frame anyway, so it bakes the correction in and comes out square-pixel,
  // which is the simpler and more widely understood file of the two.
  const target = reference ? reference.ratio : 0
  const shown = displaySize(pstream.width, pstream.height, target)
  const pasp = mode === MODE_REMUX ? pixelAspect(pstream.width, pstream.height, reference) : null

  const { width: outWidth, height: outHeight } = outputSize(shown.width, shown.height, opts.maxHeight)

  // The rate the level has to cover. A cap is exact; without one the source's
  // own rate is what the encoder will see, measured across the selected range
  // rather than taken from the header, which a recording with gaps overstates.
  const srcFps = frames > 1 && spanMs > 0 ? ((frames - 1) * 1000) / spanMs : 0
  const outFps = opts.fps > 0 ? opts.fps : srcFps
  const codecString = mode === MODE_TRANSCODE
    ? transcodeCodecString(opts.videoCodec, outWidth, outHeight, outFps)
    : ''

  return {
    mode,
    copyable,
    copyBlocker,
    options: opts,
    outFps,
    // The full codec string the encoder will be asked for. It carries a level,
    // and a level that does not cover the output size is refused outright by any
    // encoder that checks -- see the tables above.
    codecString,
    // The sub stream is named apart from the main one so that exporting both of
    // them from the same recording does not offer the same filename twice.
    fileName: suggestName(fileName, startMs, endMs, duration,
      opts.source === SOURCE_SUB ? 'sub' : ''),
    startMs: mode === MODE_REMUX ? pstream.ts[range.decodeFrom] : startMs,
    requestedStartMs: startMs,
    endMs,
    ...range,
    frames,
    fourcc,
    entry: sampleEntryFor(fourcc),
    // The coded size: what the samples in the file are, whichever mode runs.
    width: pstream.width,
    height: pstream.height,
    // The shape it should be seen in, before any resolution cap.
    displayWidth: shown.width,
    displayHeight: shown.height,
    // The size of the samples written out.
    outWidth: mode === MODE_TRANSCODE ? outWidth : pstream.width,
    outHeight: mode === MODE_TRANSCODE ? outHeight : pstream.height,
    // The size a player should present them at -- the track header's own
    // dimensions. For a transcode these are the sample dimensions; for a remux
    // they are the corrected ones, and `pasp` carries the same correction for
    // players that read it in preference.
    trackWidth: mode === MODE_TRANSCODE ? outWidth : shown.width,
    trackHeight: mode === MODE_TRANSCODE ? outHeight : shown.height,
    pasp,
    corrected: shown.width !== pstream.width || shown.height !== pstream.height,
    audio,
    estimatedBytes,
    warnings,
    errors,
    ok: errors.length === 0 && frames > 0
  }
}

/** A name that says which slice of which recording this is. */
export function suggestName (fileName, startMs, endMs, duration, suffix = '') {
  const stem = String(fileName || 'export').replace(/\.[^.]*$/, '')
  const base = suffix ? `${stem}.${suffix}` : stem
  const whole = startMs <= 0 && endMs >= duration - 1
  if (whole) return `${base}.mp4`
  const stamp = (ms) => {
    const total = Math.round(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor(total / 60) % 60
    const s = total % 60
    const pad = (v) => String(v).padStart(2, '0')
    return h > 0 ? `${h}h${pad(m)}m${pad(s)}s` : `${m}m${pad(s)}s`
  }
  return `${base}.${stamp(startMs)}-${stamp(endMs)}.mp4`
}
