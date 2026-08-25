import { frameIndexForTime } from '../bvr/indexer.js'
import { canRemux, sampleEntryFor } from './bitstream.js'
import { WAVE_FORMAT_FLAC, WAVE_FORMAT_PCM } from '../bvr/constants.js'
import { audioCodecLabel, packetStartTimes } from '../player/audioCodecs.js'

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
  { value: 'avc', label: 'H.264', codec: 'avc1.640028', entry: 'avc1' },
  { value: 'hevc', label: 'H.265', codec: 'hev1.1.6.L93.B0', entry: 'hvc1' }
]

export const DEFAULT_OPTIONS = {
  mode: MODE_REMUX,
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

function describeAudio (header, index, audioStarts, options, range) {
  const label = header.hasAudio ? audioCodecLabel(header.wfx) : ''
  if (!header.hasAudio || !index.audio.count) {
    return { include: false, label: '', note: 'This recording has no audio track.' }
  }
  if (options.audio === AUDIO_NONE) {
    return { include: false, label, note: 'Audio will be left out.' }
  }
  if (typeof AudioEncoder === 'undefined') {
    return { include: false, label, note: 'Audio needs the WebCodecs AudioEncoder, which this browser does not have.' }
  }
  const tag = header.wfx.wFormatTag
  const native = tag === WAVE_FORMAT_PCM ? 'PCM' : tag === WAVE_FORMAT_FLAC ? 'FLAC' : 'G.711 mu-law'
  return {
    include: range.count > 0,
    label,
    packets: range.count,
    from: range.from,
    to: range.to,
    // Every codec BVR can carry is one MP4 has no standard mapping for in
    // practice, so audio is always re-encoded rather than copied.
    note: range.count > 0
      ? `${native} is re-encoded to AAC; MP4 has no practical container form for it.`
      : 'No audio packets fall inside the selected range.'
  }
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
export function planExport ({ header, index, pstream, audioStarts, fileName, options }) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const warnings = []
  const errors = []

  const duration = pstream.count ? pstream.ts[pstream.count - 1] : 0
  const startMs = clamp(opts.startMs, 0, duration)
  const endMs = clamp(opts.endMs === Infinity ? duration : opts.endMs, startMs, duration)

  const fourcc = pstream.fourcc || ''
  const copyable = canRemux(fourcc) && !pstream.variableResolution
  let mode = opts.mode

  if (mode === MODE_REMUX && !canRemux(fourcc)) {
    mode = MODE_TRANSCODE
    warnings.push(`${fourcc || 'This codec'} has no usable MP4 form, so the export re-encodes.`)
  } else if (mode === MODE_REMUX && pstream.variableResolution) {
    mode = MODE_TRANSCODE
    warnings.push(
      'This is a switching-mode recording: the picture changes size mid-stream, ' +
      'which MP4 tolerates poorly. Pick the main or sub stream on its own to copy ' +
      'frames without re-encoding.'
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
  const starts = audioStarts || packetStartTimes(header.wfx, index.audio, header.audioExtradata)
  const audio = describeAudio(header, index, starts, opts, audioRange(index, starts, startMs, endMs))
  if (audio.include && audio.note) warnings.push(audio.note)
  else if (!audio.include && audio.note && header.hasAudio && opts.audio !== AUDIO_NONE) warnings.push(audio.note)

  let videoBytes = 0
  for (let i = range.startIdx; i <= range.endIdx && i < pstream.count; i++) videoBytes += pstream.size[i]
  const spanMs = Math.max(1, pstream.ts[Math.min(range.endIdx, pstream.count - 1)] - pstream.ts[range.startIdx])
  const estimatedBytes = mode === MODE_REMUX
    ? videoBytes + Math.round(frames * 8) + (audio.include ? (spanMs / 1000) * (opts.audioBitrate / 8) : 0)
    : Math.round((spanMs / 1000) * ((opts.videoBitrate + (audio.include ? opts.audioBitrate : 0)) / 8))

  const outHeight = opts.maxHeight > 0 ? Math.min(opts.maxHeight, pstream.height) : pstream.height
  const scale = pstream.height > 0 ? outHeight / pstream.height : 1
  // Encoders reject odd dimensions for 4:2:0 chroma.
  const outWidth = Math.max(2, Math.round((pstream.width * scale) / 2) * 2)

  return {
    mode,
    copyable,
    options: opts,
    fileName: suggestName(fileName, startMs, endMs, duration),
    startMs: mode === MODE_REMUX ? pstream.ts[range.decodeFrom] : startMs,
    requestedStartMs: startMs,
    endMs,
    ...range,
    frames,
    fourcc,
    entry: sampleEntryFor(fourcc),
    width: pstream.width,
    height: pstream.height,
    outWidth: mode === MODE_TRANSCODE ? outWidth : pstream.width,
    outHeight: mode === MODE_TRANSCODE ? outHeight : pstream.height,
    audio,
    estimatedBytes,
    warnings,
    errors,
    ok: errors.length === 0 && frames > 0
  }
}

/** A name that says which slice of which recording this is. */
export function suggestName (fileName, startMs, endMs, duration) {
  const base = String(fileName || 'export').replace(/\.[^.]*$/, '')
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
