/**
 * "Export metadata": everything the player knows about a recording, written out
 * as a plain-text report.
 *
 * Two situations want the same thing. A viewer holding a file that will not
 * play needs to know what it *does* contain -- the player refusing it is not an
 * answer -- and anyone reporting an odd recording to whoever wrote the recorder
 * needs something to attach. Plain text rather than JSON because both of those
 * end in a message to a person.
 *
 * The report is built from the same `header` / `index` / `probe` triple every
 * other consumer works from (see mediaInfo.js), so a file that is already open
 * is described from what is in memory, and one that never opened is read here.
 * That second path is the reason this module opens the container itself rather
 * than borrowing the player's: analysis must never refuse a file. It is asked
 * for precisely when something is wrong, so every stage below is allowed to
 * fail and still produce a report of what was learned before it did.
 *
 * What is *not* here: a line per frame. A recording is hundreds of thousands of
 * frames, and a report nobody can read is not a diagnostic. Frames are
 * described in aggregate, and the structures that exist once -- the header, the
 * overlay object definitions, the marks -- are given in full.
 */

import { BlobReader } from '../bvr/blobReader.js'
import { openContainer, sniffContainer, UnknownContainerError } from './open.js'
import { containerLabel, describeNoVideo, hasBlueIrisExtras, streamLabelFor } from './mediaInfo.js'
import { readFrameHeader, writerVersionText } from '../bvr/parseFileHeader.js'
import {
  FLAG_ISKEY, FLAG_ISAUDIO, FLAG_ISMETADATA, FLAG_ISDISCONTINUITY, FLAG_SUBSTREAM,
  FLAG_ISHEADER, FLAG_MARK, FLAG_MAINAVAILABLE,
  MASK_FLAG_NAMES, STATE_BIT_NAMES, WAVE_FORMAT_PCM
} from '../bvr/constants.js'
import {
  parseObjectDefinitions, parseObjectUpdates, colorRefToCss,
  placeRect, rectScaleFor, OBJ_GRAPHIC, OBJ_TEXT, OVERLAY_UNITS
} from '../bvr/metadata.js'
import { audioCodecLabel } from '../player/audioCodecs.js'
import { formatBytes, formatTime } from '../util/format.js'

// Wide enough for the widest row below, narrow enough to survive being pasted
// into a forum post or an email without reflowing.
const WRAP = 84
const LABEL = 22

// Overlay updates are scattered the length of the file, so reading them all
// would mean reading the file again. The first record holds every object's
// initial content by the format's own placement guarantee (spec 7), and the
// last is where a recording that went wrong went wrong, so those two are read
// and the rest are counted.
const META_WINDOW = 256 << 10

// Enough of an unrecognised file to see what it actually is.
const SNIFF_BYTES = 64

// How many marks or segment starts are listed before the report starts counting
// instead. Both are ordinarily a handful; a file with thousands is describing a
// pattern, not a list worth reading.
const LIST_LIMIT = 200

const FRAME_FLAG_NAMES = [
  [FLAG_ISKEY, 'ISKEY'],
  [FLAG_ISAUDIO, 'ISAUDIO'],
  [FLAG_ISMETADATA, 'ISMETADATA'],
  [FLAG_ISDISCONTINUITY, 'ISDISCONTINUITY'],
  [FLAG_SUBSTREAM, 'SUBSTREAM'],
  [FLAG_ISHEADER, 'ISHEADER'],
  [FLAG_MARK, 'MARK'],
  [FLAG_MAINAVAILABLE, 'MAINAVAILABLE']
]

const ROTATIONS = {
  0: 'none',
  90: '90 degrees clockwise',
  180: '180 degrees',
  270: '270 degrees clockwise'
}

const num = (v) => Number(v || 0).toLocaleString()
const pad = (v, n = 2) => String(v).padStart(n, '0')
const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`

function hex (v, digits) {
  return `0x${(v >>> 0).toString(16).padStart(digits, '0')}`
}

/** A timestamp as UTC, which is the only reading two people will agree on. */
function utcText (ms) {
  if (!ms) return 'absent'
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)} UTC`
}

function localText (ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Names the bits that are set, and shows the raw value either way. */
function bitsText (value, names, digits = 4) {
  if (!value) return 'none'
  const on = names.filter(([bit]) => value & bit).map(([, name]) => name)
  return on.length ? `${hex(value, digits)}  ${on.join(' | ')}` : hex(value, digits)
}

function wrapText (text, width) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else { out.push(line); line = word }
    }
    out.push(line)
  }
  return out
}

/** Accumulates the report. Every section below writes through this. */
class Report {
  constructor () { this.lines = [] }

  line (text = '') { this.lines.push(text) }

  head (title) {
    this.line('')
    this.line(title)
    this.line('-'.repeat(title.length))
  }

  /** A `label   value` pair, with continuation lines under the value column. */
  row (label, value) {
    const text = (value === '' || value === null || value === undefined) ? '--' : String(value)
    const parts = wrapText(text, WRAP - LABEL - 2)
    this.line(`  ${label.padEnd(LABEL)}${parts[0]}`)
    for (const rest of parts.slice(1)) this.line(`  ${' '.repeat(LABEL)}${rest}`)
  }

  /** The same, one level deeper -- used inside a per-stream or per-object block. */
  subrow (label, value) {
    const text = (value === '' || value === null || value === undefined) ? '--' : String(value)
    const parts = wrapText(text, WRAP - LABEL - 4)
    this.line(`    ${label.padEnd(LABEL - 2)}${parts[0]}`)
    for (const rest of parts.slice(1)) this.line(`    ${' '.repeat(LABEL - 2)}${rest}`)
  }

  para (text) {
    for (const l of wrapText(text, WRAP - 2)) this.line(`  ${l}`)
  }

  text () { return this.lines.join('\n') + '\n' }
}

// -------------------------------------------------------------------- gather

/**
 * Reads a file as far as it can be read, refusing nothing.
 *
 * `openContainer` in tolerant mode skips the one refusal it normally makes -- a
 * file whose codecs this device cannot decode -- because for a report that
 * verdict is a line to print, not a reason to stop. Anything else that throws
 * is caught and becomes the report's own subject.
 */
async function gather (blob, { header, index, probe, onProgress, shouldStop } = {}) {
  if (header && index) {
    return { header, index, probe: probe || null, failure: null, kind: header.container }
  }

  const reader = new BlobReader(blob)
  let kind = ''
  try {
    kind = await sniffContainer(reader)
  } catch { /* an unreadable first block is reported as an unknown container */ }

  try {
    const opened = await openContainer(reader, { onProgress, shouldStop, tolerant: true })
    return {
      header: opened.header,
      index: opened.index,
      probe: opened.probe,
      failure: null,
      kind: opened.container
    }
  } catch (e) {
    return { header: null, index: null, probe: null, failure: e, kind }
  } finally {
    reader.release()
  }
}

/** The overlay records worth decoding: the definitions, and the ends of the run. */
async function readOverlay (blob, index) {
  const out = { defs: [], defRecord: null, updates: [], first: null, last: null, other: [] }
  if (!index || !index.metadata || !index.metadata.length) return out

  out.defRecord = index.metadata.find((m) => m.subtype === 1) || null
  out.updates = index.metadata.filter((m) => m.subtype === 2)
  out.other = index.metadata.filter((m) => m.subtype !== 1 && m.subtype !== 2)

  const reader = new BlobReader(blob, META_WINDOW)
  try {
    if (out.defRecord) {
      const bytes = await reader.readCopy(out.defRecord.offset, out.defRecord.size)
      out.defs = parseObjectDefinitions(bytes)
    }
    const ends = []
    if (out.updates.length) ends.push(['first', out.updates[0]])
    if (out.updates.length > 1) ends.push(['last', out.updates[out.updates.length - 1]])
    for (const [which, rec] of ends) {
      const bytes = await reader.readCopy(rec.offset, rec.size)
      out[which] = { record: rec, updates: parseObjectUpdates(bytes, out.defs) }
    }
  } catch {
    // A truncated or corrupt record is itself worth reporting, and the counts
    // above survive to say so.
  } finally {
    reader.release()
  }
  return out
}

// --------------------------------------------------------------------- stats

/** Everything the report says about one video stream, in one pass over it. */
function streamStats (s) {
  if (!s || s.count === 0) return null
  let bytes = 0
  let min = Infinity
  let max = 0
  let discontinuities = 0
  let marks = 0
  const state = { triggered: 0, overlay: 0, recording: 0, alerted: 0 }
  let dioFrames = 0
  let dioSeen = 0
  for (let i = 0; i < s.count; i++) {
    const size = s.size[i]
    bytes += size
    if (size < min) min = size
    if (size > max) max = size
    const f = s.flags[i]
    // The first frame of a file always carries it; only later ones are a
    // segment start, which is what the report and the timeline below mean.
    if (i > 0 && (f & FLAG_ISDISCONTINUITY)) discontinuities++
    if (f & FLAG_MARK) marks++
    const st = s.state[i]
    for (const [bit, name] of STATE_BIT_NAMES) if (st & bit) state[name]++
    if (s.dio[i]) { dioFrames++; dioSeen |= s.dio[i] }
  }
  const first = s.ts[0]
  const last = s.ts[s.count - 1]
  const span = last - first
  let firstUtc = 0
  let lastUtc = 0
  for (let i = 0; i < s.count; i++) if (s.utc[i]) { firstUtc = s.utc[i]; break }
  for (let i = s.count - 1; i >= 0; i--) if (s.utc[i]) { lastUtc = s.utc[i]; break }
  return {
    count: s.count,
    keys: s.keys.length,
    bytes,
    min: min === Infinity ? 0 : min,
    max,
    first,
    last,
    span,
    firstUtc,
    lastUtc,
    fps: span > 0 ? (s.count - 1) * 1000 / span : 0,
    bitrate: span > 0 ? bytes * 8000 / span : 0,
    discontinuities,
    marks,
    state,
    dioFrames,
    dioSeen
  }
}

function sumSizes (arr, count) {
  let bytes = 0
  for (let i = 0; i < count; i++) bytes += arr[i]
  return bytes
}

/** Where the last complete frame ends, so the report can say what follows it. */
function lastFrameEnd (index) {
  let end = 0
  for (const s of index.streams) {
    if (s.count) end = Math.max(end, s.offset[s.count - 1] + s.size[s.count - 1])
  }
  const a = index.audio
  if (a && a.count) end = Math.max(end, a.offset[a.count - 1] + a.size[a.count - 1])
  for (const m of index.metadata) end = Math.max(end, m.offset + m.size)
  return end
}

// ------------------------------------------------------------------ sections

function fileSection (r, { fileName, size, header, kind }) {
  r.line('BVR Player -- file report')
  r.line('=========================')
  r.line('')
  r.row('File', fileName || '(unnamed)')
  r.row('Size', `${num(size)} bytes (${formatBytes(size)})`)
  r.row('Container', header ? containerLabel(header) : (kind ? kind.toUpperCase() : 'not recognised'))
  r.row('Report written', `${localText(Date.now())} local, ${utcText(Date.now())}`)
}

function summarySection (r, { header, index, probe, failure }) {
  r.head('Summary')
  if (failure) {
    r.para(failure instanceof UnknownContainerError
      ? failure.message
      : `The file could not be read far enough to describe it: ${failure.message}`)
    return
  }

  const video = index.streams[0].count + index.streams[1].count
  if (video === 0) {
    r.para(describeNoVideo(header, index, false))
  } else {
    const parts = [`${plural(video, 'video frame')} over ${formatTime(index.durationMs, false)}`]
    if (index.audio.count) parts.push(plural(index.audio.count, 'audio packet'))
    if (index.metadata.length) parts.push(plural(index.metadata.length, 'metadata record'))
    r.para(`This recording holds ${parts.join(', ')}.`)
  }

  if (probe && video > 0 && !probe.anySupported && probe.summary) {
    r.line('')
    r.para(probe.summary)
  } else if (probe && probe.someUnsupported) {
    r.line('')
    r.para('One video stream is in a format this device cannot decode; the other plays.')
  }

  if (index.truncated || index.resyncs) {
    r.line('')
    const notes = []
    if (index.truncated) {
      notes.push('the final frame is incomplete, so writing or copying the file stopped part way through it')
    }
    if (index.resyncs) {
      notes.push(`the frame chain broke ${plural(index.resyncs, 'time')} and had to be picked up again by ` +
        'searching forward for the next "BLUE" signature')
    }
    r.para(`Damage was found: ${notes.join('; ')}.`)
  }
}

/** Frame 0 as it is on disk, read back rather than reconstructed. */
async function bvrHeaderSection (r, blob, header) {
  r.head('File header (frame 0)')

  let raw = null
  const reader = new BlobReader(blob, 4096)
  try {
    const view = await reader.read(0, Math.min(blob.size, 32))
    raw = readFrameHeader(view, 0)
  } catch {
    // The parsed header below carries everything that matters; only the raw
    // flag word and the post-byte count are lost.
  } finally {
    reader.release()
  }

  if (raw) {
    r.row('Frame flags', bitsText(raw.flags, FRAME_FLAG_NAMES))
    r.row('Post bytes', `${raw.postbytes}${raw.postbytes === 16 ? '  (utc, dio inputs, writer version)' : ''}`)
    r.row('Payload', `${num(raw.datasize)} bytes`)
  }
  r.row('Frame 1 begins at', `byte ${num(header.firstFrameOffset)}`)
  r.row('Nominal interval', header.frameInterval
    ? `${num(header.frameInterval)} us  (${header.fps.toFixed(2)} fps)`
    : 'not stated')
  r.row('Header UTC', header.startUtc
    ? `${utcText(header.startUtc)}  (local ${localText(header.startUtc)})`
    : 'absent')
  r.row('Written by', header.writerVersion
    ? `Blue Iris ${writerVersionText(header.writerVersion)}  (${hex(header.writerVersion, 8)})`
    : 'not recorded -- written before Blue Iris 6.1.0.7')
  r.row('Orientation', header.flipH
    ? `${ROTATIONS[header.rotation] || header.rotation + ' degrees'}, mirrored horizontally`
    : (ROTATIONS[header.rotation] || `${header.rotation} degrees`))
  r.row('Recording mode', header.switchingMode
    ? 'dual stream, switching -- the main stream is recorded only while triggered (spec 5.3)'
    : header.hasSubHeader
      ? 'dual stream, both recorded in parallel'
      : 'single stream')
}

function bvrFormatSection (r, header) {
  r.head('Declared formats (what the header says the file holds)')

  const names = ['Main video', 'Sub video']
  for (let si = 0; si < 2; si++) {
    const b = header.bmih[si]
    if (!b) {
      if (si === 1) r.row(names[si], 'none declared')
      continue
    }
    r.row(names[si], `${b.fourcc.trim() || hex(b.biCompression, 8)}  ${b.width} x ${b.height}` +
      (b.biHeight < 0 ? '  (top-down DIB: biHeight is negative)' : ''))
  }

  const wfx = header.wfx
  if (!header.hasAudio) {
    r.row('Audio', wfx && wfx.wFormatTag
      ? `a format is declared (wFormatTag ${hex(wfx.wFormatTag, 4)}) but with no sample rate or ` +
        'block size, which the format defines as "no audio"'
      : 'none')
  } else {
    const bits = [
      audioCodecLabel(wfx),
      plural(wfx.nChannels, 'channel'),
      `${num(wfx.nSamplesPerSec)} Hz`,
      `${wfx.wBitsPerSample}-bit`,
      `block align ${wfx.nBlockAlign}`,
      `${num(wfx.nAvgBytesPerSec)} bytes/s`,
      `wFormatTag ${hex(wfx.wFormatTag, 4)}`
    ]
    if (wfx.wFormatTag > WAVE_FORMAT_PCM && wfx.cbSize) {
      bits.push(`${num(wfx.cbSize)} bytes of codec extradata` +
        (header.audioExtradata ? '' : ', declared but absent'))
    }
    r.row('Audio', bits.join(', '))
  }

  const aoiNames = ['main', 'sub']
  const aoi = header.aoi.map((a, i) => {
    if (!a) return ''
    const empty = a.right <= a.left || a.bottom <= a.top
    return `${aoiNames[i]}: ${empty ? 'whole frame' : `${a.left},${a.top} to ${a.right},${a.bottom}`}`
  }).filter(Boolean)
  r.row('Area of interest', aoi.length ? aoi.join('; ') : 'not written (Blue Iris before 5.8.5)')

  const mask = header.mask
  if (!mask) {
    r.row('Motion mask', 'none')
  } else {
    let cells = 0
    for (let i = 0; i < mask.bits.length; i++) {
      let b = mask.bits[i]
      while (b) { cells += b & 1; b >>= 1 }
    }
    r.row('Motion mask', `${mask.width} x ${mask.height} cells, ` +
      `${num(Math.min(cells, mask.width * mask.height))} of them masked`)
    r.row('Show motion', bitsText(mask.showMotionFlags, MASK_FLAG_NAMES, 2))
  }
}

function mp4Section (r, header) {
  const m = header.mp4
  if (!m) return
  r.head('MP4 structure')
  if (m.brands && m.brands.major) {
    r.row('Brand', `${m.brands.major.trim()}` +
      (m.brands.compatible.length ? `  (also ${m.brands.compatible.join(' ')})` : ''))
  }
  r.row('Movie timescale', `${num(m.movieTimescale)} / s`)
  r.row('Index', m.fragmented
    ? `${plural(m.fragments, 'fragment')}, ${formatBytes(m.moovBytes)} of moov`
    : `moov sample table, ${formatBytes(m.moovBytes)}`)
  r.row('moov at', `byte ${num(m.moovAt)}`)
  r.row('Media data', formatBytes(m.mdatBytes))
  if (m.layout && m.layout.length) {
    r.row('Top-level boxes', m.layout.map((b) => `${b.type} at ${num(b.start)} (${formatBytes(b.size)})`).join(', '))
  }
  r.row('Tracks', num(m.tracks.length))

  for (const t of m.tracks) {
    r.line('')
    r.line(`  Track ${t.id} -- ${t.kind || t.handler}`)
    r.subrow('Sample entry', `${(t.entry || '').trim() || 'unknown'}${t.label ? `  (${t.label})` : ''}`)
    if (t.width) r.subrow('Picture', `${t.width} x ${t.height}`)
    r.subrow('Samples', num(t.samples))
    r.subrow('Timescale', `${num(t.timescale)} / s`)
    r.subrow('Duration', formatTime(t.durationMs, false))
    r.subrow('Stored order', t.reordered
      ? 'out of display order (B-frames; composition offsets present)'
      : 'display order')
    if (t.editEntries) r.subrow('Edit list', plural(t.editEntries, 'entry', 'entries'))
    if (t.rotation || t.flipH) {
      r.subrow('Orientation', `${ROTATIONS[t.rotation] || t.rotation + ' degrees'}` +
        (t.flipH ? ', mirrored' : ''))
    }
    if (t.pasp) r.subrow('Pixel aspect', `${t.pasp.hSpacing}:${t.pasp.vSpacing}`)
  }
}

function inventorySection (r, { header, index, size, overlay }) {
  r.head('Frame inventory')

  const bvr = hasBlueIrisExtras(header)
  const both = index.streams[0].count > 0 && index.streams[1].count > 0
  const rows = []
  if (bvr) rows.push(['Header', 1, Math.max(0, header.firstFrameOffset - 32)])
  for (let si = 0; si < 2; si++) {
    const s = index.streams[si]
    // A second stream the file neither describes nor carries is not a row
    // reading zero -- it is a stream that does not exist. A BVR whose header
    // declares one still gets the row, because "declared but empty" is a fact
    // worth seeing.
    if (si === 1 && s.count === 0 && !header.bmih[1]) continue
    rows.push([streamLabelFor(header.container, si, both), s.count, sumSizes(s.size, s.count)])
  }
  rows.push(['Audio', index.audio.count, sumSizes(index.audio.size, index.audio.count)])

  if (bvr) {
    const known = { 1: 'object definitions', 2: 'object updates' }
    const byType = new Map()
    for (const m of index.metadata) {
      const cur = byType.get(m.subtype) || { n: 0, bytes: 0 }
      cur.n++
      cur.bytes += m.size
      byType.set(m.subtype, cur)
    }
    if (!byType.size) rows.push(['Metadata', 0, 0])
    for (const subtype of [...byType.keys()].sort((a, b) => a - b)) {
      const v = byType.get(subtype)
      rows.push([`Metadata, type ${subtype}${known[subtype] ? ` (${known[subtype]})` : ''}`, v.n, v.bytes])
    }
  }

  const w = 44
  r.line(`  ${'Kind'.padEnd(w)}${'Frames'.padStart(12)}${'Payload bytes'.padStart(16)}`)
  let frames = 0
  let bytes = 0
  for (const [name, n, b] of rows) {
    frames += n
    bytes += b
    r.line(`  ${name.padEnd(w)}${num(n).padStart(12)}${num(b).padStart(16)}`)
  }
  r.line(`  ${' '.repeat(w)}${'------'.padStart(12)}${'-------------'.padStart(16)}`)
  r.line(`  ${'Total'.padEnd(w)}${num(frames).padStart(12)}${num(bytes).padStart(16)}`)

  if (bvr) {
    r.line('')
    const end = lastFrameEnd(index)
    r.para(`Frame headers account for the remaining ${num(Math.max(0, end - bytes))} bytes: ` +
      '16 bytes each, plus post bytes.')
    if (end === size) {
      r.para(`The last frame ends at byte ${num(end)}, which is the end of the file -- nothing follows it.`)
    } else if (end < size) {
      r.para(`The last complete frame ends at byte ${num(end)}, leaving ${num(size - end)} bytes ` +
        'after it that do not form a whole frame.')
    }
    if (index.resyncs) {
      r.para(`The scan lost the frame chain ${plural(index.resyncs, 'time')} and resynchronised by ` +
        'searching forward for the next valid frame. Bytes skipped that way are not counted above.')
    }
  }
  if (overlay && overlay.other.length) {
    r.para(`${plural(overlay.other.length, 'metadata record')} carry a subtype this build does not ` +
      `model (${[...new Set(overlay.other.map((m) => m.subtype))].join(', ')}).`)
  }
}

function streamsSection (r, { header, index, probe }) {
  r.head('Video streams')
  const both = index.streams[0].count > 0 && index.streams[1].count > 0
  let any = false

  for (let si = 0; si < 2; si++) {
    const stats = streamStats(index.streams[si])
    const p = probe ? probe.streams[si] : null
    if (!stats && !p) continue
    any = true
    r.line('')
    r.line(`  ${streamLabelFor(header.container, si, both)}` +
      (stats ? '' : ' -- described by the header, but no frames were found'))

    if (stats) {
      const keyEvery = stats.keys > 1 ? stats.count / stats.keys : 0
      r.subrow('Frames', `${num(stats.count)}, of which ${num(stats.keys)} are key frames` +
        (keyEvery ? `  (one every ~${keyEvery.toFixed(1)} frames)` : ''))
      r.subrow('Media time', `${formatTime(stats.first)} to ${formatTime(stats.last)}  ` +
        `(${formatTime(stats.span, false)})`)
      r.subrow('Wall clock', stats.firstUtc
        ? `${utcText(stats.firstUtc)} to ${utcText(stats.lastUtc)}`
        : 'these frames carry no UTC post-bytes')
      r.subrow('Measured rate', stats.fps ? `${stats.fps.toFixed(2)} fps` : 'a single frame')
      r.subrow('Payload', `${formatBytes(stats.bytes)}  (smallest frame ${formatBytes(stats.min)}, ` +
        `largest ${formatBytes(stats.max)})`)
      r.subrow('Bitrate', stats.bitrate ? `${(stats.bitrate / 1e6).toFixed(2)} Mbit/s` : '--')
      r.subrow('Discontinuities', stats.discontinuities
        ? `${num(stats.discontinuities)} (segment starts; spec flag ISDISCONTINUITY)`
        : 'none after the first frame')
      if (stats.marks) r.subrow('Marks', num(stats.marks))
    }

    if (p) {
      r.subrow('Encoded picture', p.width
        ? `${p.width} x ${p.height}`
        : 'could not be read from the bitstream')
      if (p.declaredWidth && (p.declaredWidth !== p.width || p.declaredHeight !== p.height)) {
        r.subrow('Header declares', `${p.declaredWidth} x ${p.declaredHeight}  ` +
          '(the two disagreeing is ordinary on a Blue Iris sub stream)')
      }
      const codecId = p.codec.config && p.codec.config.codec ? `  (${p.codec.config.codec})` : ''
      r.subrow('Codec', `${p.codec.label}${codecId}` +
        (p.fourcc ? `, FourCC "${p.fourcc.trim()}"` : ''))
      r.subrow('Decodable here', p.supported ? 'yes' : `no -- ${p.reason}`)
      if (!p.hasKeyFrame) r.subrow('Key frame', 'none was found to judge the stream by')
    } else if (stats) {
      r.subrow('Codec', 'the opening probe never reached this stream')
    }

    if (stats && hasBlueIrisExtras(header)) {
      const seen = STATE_BIT_NAMES
        .map(([, name]) => [name, stats.state[name] || 0])
        .filter(([, n]) => n > 0)
      r.subrow('Camera state', seen.length
        ? seen.map(([name, n]) => `${name} on ${num(n)} frames`).join(', ')
        : 'no state bit is set on any frame')
      r.subrow('DIO inputs', stats.dioFrames
        ? `set on ${num(stats.dioFrames)} frames (mask ${hex(stats.dioSeen, 8)})`
        : 'never set')
    }
  }

  if (!any) r.para('None. No frame in the file carries video.')
}

function audioSection (r, { header, index }) {
  r.head('Audio')
  const a = index.audio
  if (!a.count) {
    r.para(header.hasAudio
      ? 'The header declares an audio format, but the file contains no audio packets.'
      : 'The file contains no audio.')
    return
  }
  const bytes = sumSizes(a.size, a.count)
  const span = a.ts[a.count - 1] - a.ts[0]
  r.row('Packets', num(a.count))
  r.row('Media time', `${formatTime(a.ts[0])} to ${formatTime(a.ts[a.count - 1])}  ` +
    `(${formatTime(span, false)})`)
  r.row('Payload', `${formatBytes(bytes)}  (average ${formatBytes(Math.round(bytes / a.count))} per packet)`)
  if (header.wfx) r.row('Format', audioCodecLabel(header.wfx))
  if (span > 0) r.row('Bitrate', `${(bytes * 8000 / span / 1000).toFixed(1)} kbit/s`)
}

/** One overlay object definition, in as much detail as the spec gives it. */
function objectBlock (r, def, scale, frameW, frameH) {
  r.line('')
  r.line(`  Object ${def.index} -- ${def.typeName}`)

  const box = placeRect(def.rect, scale)
  const raw = `(${def.rect.left}, ${def.rect.top}) to (${def.rect.right}, ${def.rect.bottom})`
  const whole = def.rect.left <= 0 && def.rect.top <= 0 &&
    def.rect.right >= OVERLAY_UNITS && def.rect.bottom >= OVERLAY_UNITS
  const px = frameW && frameH
    ? ` = ${Math.round(box.w)}x${Math.round(box.h)} px at ` +
      `(${Math.round(box.x)}, ${Math.round(box.y)}) on ${frameW}x${frameH}`
    : ''
  r.subrow('Placement', `${raw} of ${OVERLAY_UNITS}${whole ? ' -- the whole frame' : ''}${px}`)

  if (def.type === OBJ_TEXT) {
    const align = def.align === 0 ? 'centred' : def.align < 0 ? 'left aligned' : 'right aligned'
    r.subrow('Font', `"${def.font || 'unnamed'}", weight ${def.weight}, ` +
      `${def.nlines ? plural(def.nlines, 'line') : 'no line count'}, ${align}` +
      (def.shadow ? ', shadowed' : ''))
  } else if (def.type === OBJ_GRAPHIC) {
    r.subrow('Bitmap', `${def.transparent ? 'transparent' : 'opaque'}, ` +
      `${def.constrain ? 'aspect kept' : 'stretched to fit'}`)
  }
  if (def.path) r.subrow('Configured as', `"${def.path}"`)
  r.subrow('Colour', `${colorRefToCss(def.color)} on ${colorRefToCss(def.bkcolor)}, ` +
    `alpha ${def.alpha}/100`)

  const conditions = []
  if (def.stateflags) {
    conditions.push(`the camera state must include ${bitsText(def.stateflags, STATE_BIT_NAMES, 2)}`)
  }
  if (def.dio) conditions.push(`a DIO input in ${hex(def.dio, 8)} must be set`)
  r.subrow('Drawn when', conditions.length ? conditions.join('; ') : 'always')
}

/** The decoded content of one type-2 record. */
function updateBlock (r, which, decoded, defs) {
  const rec = decoded.record
  r.line('')
  r.line(`  ${which} update record -- at ${formatTime(rec.ts)}, ${num(rec.size)} bytes, ` +
    `${plural(decoded.updates.length, 'entry', 'entries')}`)
  if (rec.utc) r.subrow('Written at', utcText(rec.utc))
  if (!decoded.updates.length) {
    r.subrow('Content', 'the record is present but carries nothing this build could read')
    return
  }
  for (const u of decoded.updates) {
    if (u.kind === 'gps') {
      r.subrow('GPS', `${u.gps.latitude.toFixed(6)}, ${u.gps.longitude.toFixed(6)} ` +
        `at ${u.gps.altitude.toFixed(1)} m`)
      continue
    }
    const label = `Object ${u.index}`
    if (u.kind === 'text') {
      r.subrow(label, `text: ${u.text ? JSON.stringify(u.text) : '(empty)'}`)
    } else if (u.kind === 'image') {
      r.subrow(label, `image, ${formatBytes(u.image ? u.image.length : 0)}`)
    } else if (u.kind === 'shapes') {
      r.subrow(label, u.shapes.length ? plural(u.shapes.length, 'box', 'boxes') : 'no boxes')
      for (const s of u.shapes) {
        r.subrow('', `${s.label || 'unlabelled'}: ` +
          `(${s.rect.left}, ${s.rect.top}) to (${s.rect.right}, ${s.rect.bottom}), ` +
          `${colorRefToCss(s.color)}${s.triggering ? ', triggering' : ''}`)
      }
    } else {
      r.subrow(label, `${num(u.size)} bytes this build does not interpret` +
        (defs[u.index] ? '' : ' (no definition exists for this index)'))
    }
  }
}

function overlaySection (r, { header, index, overlay }) {
  r.head('Overlay metadata (BVR spec section 7)')

  if (!index.metadata.length) {
    r.para('The file carries no metadata frames, so it has no overlay objects, no bounding boxes ' +
      'and no GPS track.')
    return
  }

  r.row('Definition records', overlay.defRecord
    ? `1, ${num(overlay.defRecord.size)} bytes, ${plural(overlay.defs.length, 'object')}`
    : 'none -- any update records below cannot be interpreted without them')
  r.row('Update records', overlay.updates.length
    ? `${num(overlay.updates.length)}, from ${formatTime(overlay.updates[0].ts)} to ` +
      `${formatTime(overlay.updates[overlay.updates.length - 1].ts)}`
    : 'none')

  if (overlay.defs.length) {
    const frameW = header.bmih[0] ? header.bmih[0].width : 0
    const frameH = header.bmih[0] ? header.bmih[0].height : 0
    const scale = rectScaleFor(overlay.defs.map((d) => d.rect), frameW, frameH)
    for (const def of overlay.defs) objectBlock(r, def, scale, frameW, frameH)
  }

  if (overlay.first) updateBlock(r, 'First', overlay.first, overlay.defs)
  if (overlay.last) updateBlock(r, 'Last', overlay.last, overlay.defs)
  if (overlay.updates.length > 2) {
    r.line('')
    r.para(`The ${num(overlay.updates.length - 2)} records between those two are counted but not ` +
      'listed: they are spread the length of the file, and reading them all would mean reading the ' +
      'file a second time. By the format\'s own placement guarantee the first record holds every ' +
      'object\'s initial content, so no object is missing from the two shown.')
  }
}

function timelineSection (r, { index }) {
  r.head('Marks')
  if (!index.marks.length) {
    r.para('None. No frame carries the MARK flag.')
  } else {
    for (const m of index.marks.slice(0, LIST_LIMIT)) {
      r.line(`  ${formatTime(m.ts - index.baseTs).padStart(14)}   ` +
        (m.utc ? utcText(m.utc) : `stream ${m.stream}, frame ${m.idx + 1}`))
    }
    if (index.marks.length > LIST_LIMIT) {
      r.para(`... and ${num(index.marks.length - LIST_LIMIT)} more.`)
    }
  }

  r.head('Segment starts')
  const segments = []
  for (let si = 0; si < 2; si++) {
    const s = index.streams[si]
    for (let i = 1; i < s.count; i++) {
      if (s.flags[i] & FLAG_ISDISCONTINUITY) segments.push({ si, ts: s.ts[i], utc: s.utc[i] })
    }
  }
  segments.sort((a, b) => a.ts - b.ts)
  if (!segments.length) {
    r.para('One continuous segment -- no ISDISCONTINUITY frame after the first.')
  } else {
    for (const seg of segments.slice(0, LIST_LIMIT)) {
      r.line(`  ${formatTime(seg.ts).padStart(14)}   ` +
        (seg.utc ? utcText(seg.utc) : `stream ${seg.si}`))
    }
    if (segments.length > LIST_LIMIT) {
      r.para(`... and ${num(segments.length - LIST_LIMIT)} more.`)
    }
  }
}

async function unreadableSection (r, blob) {
  r.head('Opening bytes')
  try {
    const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, SNIFF_BYTES)).arrayBuffer())
    r.para('Nothing further could be read, so here is the front of the file for whoever has to ' +
      'work out what it is:')
    r.line('')
    for (let off = 0; off < bytes.length; off += 16) {
      const chunk = bytes.subarray(off, off + 16)
      const hexes = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
      const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
      r.line(`  ${off.toString(16).padStart(8, '0')}  ${hexes.padEnd(47)}  ${ascii}`)
    }
  } catch { /* nothing more to say about a blob that will not even slice */ }
}

function notesSection (r, header) {
  r.head('About this report')
  r.para('Written by BVR Player, which decodes recordings locally in the browser: nothing in this ' +
    'file left the machine it was made on.')
  r.line('')
  if (hasBlueIrisExtras(header)) {
    r.para('Field names and section numbers refer to the Blue Iris BVR file format specification ' +
      'that ships with the player. "Media time" is measured from the first frame of the recording; ' +
      'wall-clock times are UTC, taken from the per-frame post-bytes the recorder writes.')
  } else {
    r.para('Box and field names are those of the ISO base media file format. "Media time" is ' +
      'measured from the first sample of the recording.')
  }
}

// -------------------------------------------------------------------- public

/** `FE.20260828_180000Z_5.bvr` -> `FE.20260828_180000Z_5.metadata.txt`. */
function metadataReportName (fileName) {
  const base = String(fileName || 'recording').replace(/\.(bvr|mp4|m4v|mov)$/i, '')
  return `${base || 'recording'}.metadata.txt`
}

/**
 * Describes a recording as completely as it can be described.
 *
 * `header`, `index` and `probe` may be passed in when the file is already open,
 * which is the difference between an instant report and reading a gigabyte
 * again. Without them the file is opened here and `onProgress` reports that
 * scan. Nothing about the file itself can make this throw.
 */
export async function analyzeRecording (file, opts = {}) {
  const blob = opts.blob || file
  const fileName = opts.fileName || (file && file.name) || ''
  const { header, index, probe, failure, kind } = await gather(blob, opts)

  const r = new Report()
  fileSection(r, { fileName, size: blob.size, header, kind })
  summarySection(r, { header, index, probe, failure })

  if (failure || !header || !index) {
    await unreadableSection(r, blob)
    notesSection(r, header)
    return { name: metadataReportName(fileName), text: r.text() }
  }

  const bvr = hasBlueIrisExtras(header)
  const overlay = bvr ? await readOverlay(blob, index) : null

  if (bvr) {
    await bvrHeaderSection(r, blob, header)
    bvrFormatSection(r, header)
  } else {
    mp4Section(r, header)
  }
  inventorySection(r, { header, index, size: blob.size, overlay })
  streamsSection(r, { header, index, probe })
  audioSection(r, { header, index })
  if (bvr) {
    overlaySection(r, { header, index, overlay })
    timelineSection(r, { index })
  }
  notesSection(r, header)

  return { name: metadataReportName(fileName), text: r.text() }
}
