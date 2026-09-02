/**
 * The "simple summary": a metadata report as plain text.
 *
 * Plain text because the two things this is for -- showing a viewer what an
 * unplayable file actually contains, and giving someone something to attach to
 * a message about an odd recording -- both end up pasted into a message to a
 * person. It answers the shape of the file; `reportHtml.js` answers the
 * contents of it.
 *
 * What is deliberately not here is a line per frame or per overlay record. A
 * recording is hundreds of thousands of frames and thousands of records, and a
 * report nobody can read is not a diagnostic. Those are described in aggregate,
 * and the structures that exist once -- the header, the object definitions, the
 * marks -- are given in full.
 */

import { containerLabel, describeNoVideo, hasBlueIrisExtras, streamLabelFor } from './mediaInfo.js'
import { writerVersionText } from '../bvr/parseFileHeader.js'
import { MASK_FLAG_NAMES, STATE_BIT_NAMES, WAVE_FORMAT_PCM } from '../bvr/constants.js'
import { colorRefToCss, placeRect, rectScaleFor, OBJ_GRAPHIC, OBJ_TEXT, OVERLAY_UNITS } from '../bvr/metadata.js'
import { audioCodecLabel } from '../player/audioCodecs.js'
import { formatBytes, formatTime } from '../util/format.js'
import { UnknownContainerError } from './open.js'
import {
  FRAME_FLAG_NAMES, LIST_LIMIT, ROTATIONS,
  flagNames, hex, localText, num, plural, utcText
} from './analysis.js'

// Wide enough for the widest row below, narrow enough to survive being pasted
// into a forum post or an email without reflowing.
const WRAP = 84
const LABEL = 22

/** Names the bits that are set, and shows the raw value either way. */
function bitsText (value, names, digits = 4) {
  if (!value) return 'none'
  const on = flagNames(value, names)
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

// ------------------------------------------------------------------ sections

function fileSection (r, m) {
  r.line('BVR Player -- file report')
  r.line('=========================')
  r.line('')
  r.row('File', m.fileName || '(unnamed)')
  r.row('Size', `${num(m.size)} bytes (${formatBytes(m.size)})`)
  r.row('Container', m.header
    ? containerLabel(m.header)
    : (m.kind ? m.kind.toUpperCase() : 'not recognised'))
  r.row('Report written', `${localText(m.generatedAt)} local, ${utcText(m.generatedAt)}`)
}

function summarySection (r, m) {
  const { header, index, probe, failure } = m
  r.head('Summary')
  if (failure) {
    r.para(failure instanceof UnknownContainerError
      ? failure.message
      : `The file could not be read far enough to describe it: ${failure.message}`)
    return
  }

  if (m.videoFrames === 0) {
    r.para(describeNoVideo(header, index, false))
  } else {
    const parts = [`${plural(m.videoFrames, 'video frame')} over ${formatTime(index.durationMs, false)}`]
    if (index.audio.count) parts.push(plural(index.audio.count, 'audio packet'))
    if (index.metadata.length) parts.push(plural(index.metadata.length, 'metadata record'))
    r.para(`This recording holds ${parts.join(', ')}.`)
  }

  if (probe && m.videoFrames > 0 && !probe.anySupported && probe.summary) {
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

function bvrHeaderSection (r, m) {
  const { header, rawHeaderFrame: raw } = m
  r.head('File header (frame 0)')

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
    r.row('Top-level boxes', m.layout
      .map((b) => `${b.type} at ${num(b.start)} (${formatBytes(b.size)})`).join(', '))
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

function inventorySection (r, m) {
  r.head('Frame inventory')
  const w = 44
  r.line(`  ${'Kind'.padEnd(w)}${'Frames'.padStart(12)}${'Payload bytes'.padStart(16)}`)
  for (const row of m.inventory) {
    r.line(`  ${row.name.padEnd(w)}${num(row.frames).padStart(12)}${num(row.bytes).padStart(16)}`)
  }
  r.line(`  ${' '.repeat(w)}${'------'.padStart(12)}${'-------------'.padStart(16)}`)
  r.line(`  ${'Total'.padEnd(w)}${num(m.inventoryTotals.frames).padStart(12)}` +
    `${num(m.inventoryTotals.bytes).padStart(16)}`)

  if (hasBlueIrisExtras(m.header)) {
    r.line('')
    const end = m.lastFrameEnd
    r.para(`Frame headers account for the remaining ${num(Math.max(0, end - m.inventoryTotals.bytes))} ` +
      'bytes: 16 bytes each, plus post bytes.')
    if (end === m.size) {
      r.para(`The last frame ends at byte ${num(end)}, which is the end of the file -- nothing follows it.`)
    } else if (end < m.size) {
      r.para(`The last complete frame ends at byte ${num(end)}, leaving ${num(m.size - end)} bytes ` +
        'after it that do not form a whole frame.')
    }
    if (m.index.resyncs) {
      r.para(`The scan lost the frame chain ${plural(m.index.resyncs, 'time')} and resynchronised by ` +
        'searching forward for the next valid frame. Bytes skipped that way are not counted above.')
    }
  }
  if (m.overlay && m.overlay.other.length) {
    r.para(`${plural(m.overlay.other.length, 'metadata record')} carry a subtype this build does not ` +
      `model (${[...new Set(m.overlay.other.map((x) => x.subtype))].join(', ')}).`)
  }
}

function streamsSection (r, m) {
  const { header, index, probe } = m
  r.head('Video streams')
  const both = index.streams[0].count > 0 && index.streams[1].count > 0
  let any = false

  for (let si = 0; si < 2; si++) {
    const stats = m.streams[si]
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

function audioSection (r, m) {
  r.head('Audio')
  const a = m.audio
  if (!a) {
    r.para(m.header.hasAudio
      ? 'The header declares an audio format, but the file contains no audio packets.'
      : 'The file contains no audio.')
    return
  }
  r.row('Packets', num(a.count))
  r.row('Media time', `${formatTime(a.first)} to ${formatTime(a.last)}  (${formatTime(a.span, false)})`)
  r.row('Payload', `${formatBytes(a.bytes)}  ` +
    `(average ${formatBytes(Math.round(a.bytes / a.count))} per packet)`)
  if (m.header.wfx) r.row('Format', audioCodecLabel(m.header.wfx))
  if (a.span > 0) r.row('Bitrate', `${(a.bytes * 8000 / a.span / 1000).toFixed(1)} kbit/s`)
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
function updateBlock (r, which, rec, defs, images) {
  r.line('')
  r.line(`  ${which} update record -- at ${formatTime(rec.ts)}, ${num(rec.size)} bytes, ` +
    `${plural(rec.entries.length, 'entry', 'entries')}`)
  if (rec.utc) r.subrow('Written at', utcText(rec.utc))
  if (!rec.entries.length) {
    r.subrow('Content', 'the record is present but carries nothing this build could read')
    return
  }
  for (const u of rec.entries) {
    if (u.kind === 'gps') {
      r.subrow('GPS', `${u.gps.latitude.toFixed(6)}, ${u.gps.longitude.toFixed(6)} ` +
        `at ${u.gps.altitude.toFixed(1)} m`)
      continue
    }
    const label = `Object ${u.index}`
    if (u.kind === 'text') {
      r.subrow(label, `text: ${u.text ? JSON.stringify(u.text) : '(empty)'}`)
    } else if (u.kind === 'image') {
      const img = images[u.imageId]
      r.subrow(label, img ? `image, ${img.mime}, ${formatBytes(img.size)}` : 'image, empty')
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

function overlaySection (r, m) {
  const o = m.overlay
  r.head('Overlay metadata (BVR spec section 7)')

  if (!m.index.metadata.length) {
    r.para('The file carries no metadata frames, so it has no overlay objects, no bounding boxes ' +
      'and no GPS track.')
    return
  }

  r.row('Definition records', o.defRecord
    ? `1, ${num(o.defRecord.size)} bytes, ${plural(o.defs.length, 'object')}`
    : 'none -- any update records below cannot be interpreted without them')
  r.row('Update records', o.updates.length
    ? `${num(o.updates.length)}, from ${formatTime(o.firstTs)} to ${formatTime(o.lastTs)}`
    : 'none')

  if (o.defs.length) {
    const frameW = m.header.bmih[0] ? m.header.bmih[0].width : 0
    const frameH = m.header.bmih[0] ? m.header.bmih[0].height : 0
    const scale = rectScaleFor(o.defs.map((d) => d.rect), frameW, frameH)
    for (const def of o.defs) objectBlock(r, def, scale, frameW, frameH)
  }

  if (o.first) updateBlock(r, 'First', o.first, o.defs, o.images)
  if (o.last) updateBlock(r, 'Last', o.last, o.defs, o.images)
  if (o.updates.length > 2) {
    r.line('')
    r.para(`The ${num(o.updates.length - 2)} records between those two are counted here but not ` +
      'listed. Export the detailed HTML summary instead for every record, filterable, with the ' +
      'text, boxes, images and GPS fixes each one carried.')
  }
}

function timelineSection (r, m) {
  const { index } = m
  r.head('Marks')
  if (!index.marks.length) {
    r.para('None. No frame carries the MARK flag.')
  } else {
    for (const mk of index.marks.slice(0, LIST_LIMIT)) {
      r.line(`  ${formatTime(mk.ts - index.baseTs).padStart(14)}   ` +
        (mk.utc ? utcText(mk.utc) : `stream ${mk.stream}, frame ${mk.idx + 1}`))
    }
    if (index.marks.length > LIST_LIMIT) {
      r.para(`... and ${num(index.marks.length - LIST_LIMIT)} more.`)
    }
  }

  r.head('Segment starts')
  if (!m.segmentCount) {
    r.para('One continuous segment -- no ISDISCONTINUITY frame after the first.')
  } else {
    for (const seg of m.segments) {
      r.line(`  ${formatTime(seg.ts).padStart(14)}   ` +
        (seg.utc ? utcText(seg.utc) : `stream ${seg.si}`))
    }
    if (m.segmentCount > m.segments.length) {
      r.para(`... and ${num(m.segmentCount - m.segments.length)} more.`)
    }
  }
}

function unreadableSection (r, m) {
  r.head('Opening bytes')
  if (!m.head) return
  r.para('Nothing further could be read, so here is the front of the file for whoever has to ' +
    'work out what it is:')
  r.line('')
  for (let off = 0; off < m.head.length; off += 16) {
    const chunk = m.head.subarray(off, off + 16)
    const hexes = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    r.line(`  ${off.toString(16).padStart(8, '0')}  ${hexes.padEnd(47)}  ${ascii}`)
  }
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

/** Renders the model `collectAnalysis` produced as a plain-text report. */
export function renderTextReport (m) {
  const r = new Report()
  fileSection(r, m)
  summarySection(r, m)

  if (m.failure || !m.header || !m.index) {
    unreadableSection(r, m)
    notesSection(r, m.header)
    return r.text()
  }

  const bvr = hasBlueIrisExtras(m.header)
  if (bvr) {
    bvrHeaderSection(r, m)
    bvrFormatSection(r, m.header)
  } else {
    mp4Section(r, m.header)
  }
  inventorySection(r, m)
  streamsSection(r, m)
  audioSection(r, m)
  if (bvr) {
    overlaySection(r, m)
    timelineSection(r, m)
  }
  notesSection(r, m.header)
  return r.text()
}
