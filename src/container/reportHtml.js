/**
 * The "detailed summary": a metadata report as one standalone HTML file.
 *
 * Where the text report says what shape the file is, this one says what was in
 * it. Its reason for existing is the overlay record log: a recording writes an
 * update record after every key frame and again whenever any object's content
 * changes, so an hour is a few thousand of them, and "4,412 records not listed"
 * is not an answer to a question anybody asked. Every record that was read is
 * here, filterable, with the text, boxes, images and GPS fixes each one carried.
 *
 * Standalone means no network at load: no fonts, no scripts, no stylesheets from
 * anywhere. It also has to stay small, which shapes how the log is written:
 *
 *   - The records are data, not markup. They ship as one JSON block and the
 *     rows are built in the page, so nothing per-record is repeated except the
 *     record itself.
 *   - Repeated strings are interned. A clock overlay's text is different every
 *     record, but a bounding box's label is "person" four thousand times.
 *   - Images are pooled upstream (see analysis.js) and embedded once each,
 *     however many records carried them.
 *   - Every rule is in the one stylesheet; nothing is styled inline.
 *
 * The page script is written as an ordinary function here and emitted through
 * `Function.prototype.toString`, so it is real code the editor and the bundler
 * can see rather than a string literal. That only works while it refers to
 * nothing outside itself -- a bundler renaming an outer binding would emit a
 * name the page cannot resolve -- so it takes everything it needs from the JSON.
 */

import { containerLabel, describeNoVideo, hasBlueIrisExtras, streamLabelFor } from './mediaInfo.js'
import { writerVersionText } from '../bvr/parseFileHeader.js'
import { MASK_FLAG_NAMES, STATE_BIT_NAMES, WAVE_FORMAT_PCM } from '../bvr/constants.js'
import {
  colorRefToCss, placeRect, rectScaleFor, OBJ_GRAPHIC, OBJ_TEXT, OVERLAY_UNITS
} from '../bvr/metadata.js'
import { audioCodecLabel } from '../player/audioCodecs.js'
import { formatBytes, formatTime } from '../util/format.js'
import { UnknownContainerError } from './open.js'
import {
  FRAME_FLAG_NAMES, LIST_LIMIT, RECORD_CAP, ROTATIONS,
  flagNames, hex, localText, num, plural, utcText
} from './analysis.js'

const ENTRY_TEXT = 0
const ENTRY_IMAGE = 1
const ENTRY_SHAPES = 2
const ENTRY_GPS = 3
const ENTRY_RAW = 4

// ------------------------------------------------------------------ escaping

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ESCAPES[c])

/**
 * JSON safe to sit inside a `<script>` element.
 *
 * Only `<` has to go: escaping it stops `</script` inside a string -- an overlay
 * text object can hold anything at all -- from ending the element early. U+2028
 * and U+2029 are legal in JSON strings but not in JavaScript source, and this
 * block is parsed as JSON rather than evaluated, so they would be fine; they are
 * escaped anyway because that fact is one refactor away from not being true.
 */
function jsonBlock (value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// ------------------------------------------------------------- small builders

/** A definition list of label/value pairs. Values are HTML the caller escaped. */
function kv (rows) {
  const body = rows
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join('')
  return `<dl class="kv">${body}</dl>`
}

function section (id, title, body, badge = '') {
  return `<section class="sec" id="${id}"><h2>${esc(title)}` +
    `${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</h2>${body}</section>`
}

const note = (html) => `<p class="note">${html}</p>`
const warn = (html) => `<p class="callout callout--warn">${html}</p>`
const mono = (s) => `<code>${esc(s)}</code>`

/** A colour chip next to its own hex value. */
function swatch (colorRef) {
  const css = colorRefToCss(colorRef)
  return `<span class="sw" style="--sw:${css}"></span>${esc(css)}`
}

function bits (value, names, digits = 4) {
  if (!value) return 'none'
  const on = flagNames(value, names)
  return `${mono(hex(value, digits))}${on.length ? ` ${esc(on.join(' | '))}` : ''}`
}

function base64 (bytes) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

// ------------------------------------------------------------------- the data

/**
 * The record log, interned and packed.
 *
 * Records become `[ts, dutc, bytes, entries]` and entries `[object, kind,
 * payload]`. `dutc` is what the record's own UTC differs from the recording's
 * start plus its media time, which for a well-formed file is zero and costs one
 * character; storing the absolute number would cost thirteen per record.
 */
function packRecords (m) {
  const o = m.overlay
  const texts = []
  const labels = []
  const textIds = new Map()
  const labelIds = new Map()
  const intern = (list, ids, value) => {
    const hit = ids.get(value)
    if (hit !== undefined) return hit
    const id = list.length
    list.push(value)
    ids.set(value, id)
    return id
  }

  const base = m.index.startUtc || 0
  const recs = (o.records || []).map((r) => {
    const entries = []
    for (const u of r.entries) {
      if (u.kind === 'gps') {
        entries.push([-1, ENTRY_GPS, [
          Number(u.gps.latitude.toFixed(6)),
          Number(u.gps.longitude.toFixed(6)),
          Number(u.gps.altitude.toFixed(1))
        ]])
      } else if (u.kind === 'text') {
        entries.push([u.index, ENTRY_TEXT, intern(texts, textIds, u.text || '')])
      } else if (u.kind === 'image') {
        entries.push([u.index, ENTRY_IMAGE, u.imageId])
      } else if (u.kind === 'shapes') {
        entries.push([u.index, ENTRY_SHAPES, u.shapes.map((s) => [
          s.rect.left, s.rect.top, s.rect.right, s.rect.bottom,
          s.flags, s.color, intern(labels, labelIds, s.label || '')
        ])])
      } else {
        entries.push([u.index, ENTRY_RAW, u.size])
      }
    }
    return [r.ts, r.utc ? r.utc - (base + r.ts) : null, r.size, entries]
  })

  return { base, texts, labels, recs }
}

/** Everything the page script reads: the log, the object list, the mask. */
function buildPageData (m) {
  const o = m.overlay
  const header = m.header
  const data = {
    frame: [
      header && header.bmih[0] ? header.bmih[0].width : 0,
      header && header.bmih[0] ? header.bmih[0].height : 0
    ],
    units: OVERLAY_UNITS,
    defs: o ? o.defs.map((d) => ({ i: d.index, t: d.type, n: d.typeName })) : [],
    images: o
      ? o.images.map((img) => ({ m: img.mime, n: img.size, d: img.data ? base64(img.data) : null }))
      : [],
    base: 0,
    texts: [],
    labels: [],
    recs: null,
    total: o ? o.updates.length : 0,
    capped: !!(o && o.capped),
    mask: null
  }

  if (header && header.mask) {
    data.mask = { w: header.mask.width, h: header.mask.height, b: base64(header.mask.bits) }
  }
  if (o && o.records) Object.assign(data, packRecords(m))
  return data
}

// ------------------------------------------------------------------ sections

function bannerHtml (m) {
  const container = m.header
    ? containerLabel(m.header)
    : (m.kind ? m.kind.toUpperCase() : 'not recognised')
  return `<header class="top">
    <p class="top__kicker">BVR Player &middot; file report</p>
    <h1 class="top__name">${esc(m.fileName || '(unnamed)')}</h1>
    <p class="top__facts">${esc(container)} &middot; ${esc(formatBytes(m.size))} &middot; ` +
    `${esc(num(m.size))} bytes &middot; written ${esc(localText(m.generatedAt))}</p>
  </header>`
}

function navHtml (links) {
  return `<nav class="nav">${links
    .map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`)
    .join('')}</nav>`
}

function summaryHtml (m) {
  const { header, index, probe, failure } = m
  if (failure) {
    return section('summary', 'Summary', warn(esc(failure instanceof UnknownContainerError
      ? failure.message
      : `The file could not be read far enough to describe it: ${failure.message}`)))
  }

  let body = ''
  if (m.videoFrames === 0) {
    body += warn(esc(describeNoVideo(header, index, false)))
  } else {
    const parts = [`${plural(m.videoFrames, 'video frame')} over ${formatTime(index.durationMs, false)}`]
    if (index.audio.count) parts.push(plural(index.audio.count, 'audio packet'))
    if (index.metadata.length) parts.push(plural(index.metadata.length, 'metadata record'))
    body += `<p class="lede">This recording holds ${esc(parts.join(', '))}.</p>`
  }

  if (probe && m.videoFrames > 0 && !probe.anySupported && probe.summary) {
    body += warn(esc(probe.summary))
  } else if (probe && probe.someUnsupported) {
    body += warn('One video stream is in a format this device cannot decode; the other plays.')
  }

  const damage = []
  if (index.truncated) {
    damage.push('the final frame is incomplete, so writing or copying the file stopped part way through it')
  }
  if (index.resyncs) {
    damage.push(`the frame chain broke ${plural(index.resyncs, 'time')} and had to be picked up ` +
      'again by searching forward for the next "BLUE" signature')
  }
  if (damage.length) body += warn(`Damage was found: ${esc(damage.join('; '))}.`)

  const startUtc = index.startUtc
  body += kv([
    ['Recording starts', startUtc ? esc(utcText(startUtc)) : 'not recorded'],
    ['Recording ends', index.endUtc ? esc(utcText(index.endUtc)) : 'not recorded'],
    ['Duration', esc(formatTime(index.durationMs, false))],
    ['Frames indexed', esc(num(index.totalFrames))]
  ])
  return section('summary', 'Summary', body)
}

function bvrHeaderHtml (m) {
  const { header, rawHeaderFrame: raw } = m
  const rows = []
  if (raw) {
    rows.push(['Frame flags', bits(raw.flags, FRAME_FLAG_NAMES)])
    rows.push(['Post bytes', esc(String(raw.postbytes)) +
      (raw.postbytes === 16 ? ' <em>utc, dio inputs, writer version</em>' : '')])
    rows.push(['Payload', `${esc(num(raw.datasize))} bytes`])
  }
  rows.push(['Frame 1 begins at', `byte ${esc(num(header.firstFrameOffset))}`])
  rows.push(['Nominal interval', header.frameInterval
    ? `${esc(num(header.frameInterval))} &micro;s <em>${esc(header.fps.toFixed(2))} fps</em>`
    : 'not stated'])
  rows.push(['Header UTC', header.startUtc
    ? `${esc(utcText(header.startUtc))} <em>local ${esc(localText(header.startUtc))}</em>`
    : 'absent'])
  rows.push(['Written by', header.writerVersion
    ? `Blue Iris ${esc(writerVersionText(header.writerVersion))} ` +
      `<em>${esc(hex(header.writerVersion, 8))}</em>`
    : 'not recorded <em>written before Blue Iris 6.1.0.7</em>'])
  rows.push(['Orientation', esc(header.flipH
    ? `${ROTATIONS[header.rotation] || header.rotation + ' degrees'}, mirrored horizontally`
    : (ROTATIONS[header.rotation] || `${header.rotation} degrees`))])
  rows.push(['Recording mode', esc(header.switchingMode
    ? 'dual stream, switching — the main stream is recorded only while triggered (spec 5.3)'
    : header.hasSubHeader
      ? 'dual stream, both recorded in parallel'
      : 'single stream')])
  return section('header', 'File header (frame 0)', kv(rows))
}

function bvrFormatsHtml (m) {
  const header = m.header
  const rows = []
  const names = ['Main video', 'Sub video']
  for (let si = 0; si < 2; si++) {
    const b = header.bmih[si]
    if (!b) {
      if (si === 1) rows.push([names[si], 'none declared'])
      continue
    }
    rows.push([names[si], `${esc(b.fourcc.trim() || hex(b.biCompression, 8))} ` +
      `<em>${b.width} &times; ${b.height}` +
      (b.biHeight < 0 ? ', top-down DIB (biHeight is negative)' : '') + '</em>'])
  }

  const wfx = header.wfx
  if (!header.hasAudio) {
    rows.push(['Audio', wfx && wfx.wFormatTag
      ? `a format is declared (wFormatTag ${mono(hex(wfx.wFormatTag, 4))}) but with no sample ` +
        'rate or block size, which the format defines as "no audio"'
      : 'none'])
  } else {
    const parts = [
      audioCodecLabel(wfx),
      plural(wfx.nChannels, 'channel'),
      `${num(wfx.nSamplesPerSec)} Hz`,
      `${wfx.wBitsPerSample}-bit`,
      `block align ${wfx.nBlockAlign}`,
      `${num(wfx.nAvgBytesPerSec)} bytes/s`
    ]
    if (wfx.wFormatTag > WAVE_FORMAT_PCM && wfx.cbSize) {
      parts.push(`${num(wfx.cbSize)} bytes of codec extradata` +
        (header.audioExtradata ? '' : ', declared but absent'))
    }
    rows.push(['Audio', `${esc(parts.join(', '))} <em>wFormatTag ${esc(hex(wfx.wFormatTag, 4))}</em>`])
  }

  const aoiNames = ['main', 'sub']
  const aoi = header.aoi.map((a, i) => {
    if (!a) return ''
    const empty = a.right <= a.left || a.bottom <= a.top
    return `${aoiNames[i]}: ${empty ? 'whole frame' : `${a.left},${a.top} to ${a.right},${a.bottom}`}`
  }).filter(Boolean)
  rows.push(['Area of interest', esc(aoi.length
    ? aoi.join('; ')
    : 'not written (Blue Iris before 5.8.5)')])

  let maskBlock = ''
  const mask = header.mask
  if (!mask) {
    rows.push(['Motion mask', 'none'])
  } else {
    let cells = 0
    for (let i = 0; i < mask.bits.length; i++) {
      let b = mask.bits[i]
      while (b) { cells += b & 1; b >>= 1 }
    }
    rows.push(['Motion mask', `${mask.width} &times; ${mask.height} cells ` +
      `<em>${esc(num(Math.min(cells, mask.width * mask.height)))} masked</em>`])
    rows.push(['Show motion', bits(mask.showMotionFlags, MASK_FLAG_NAMES, 2)])
    maskBlock = '<figure class="mask"><canvas id="mask-canvas"></canvas>' +
      '<figcaption>Masked cells are the ones motion detection ignores.</figcaption></figure>'
  }

  return section('formats', 'Declared formats', kv(rows) + maskBlock)
}

function mp4Html (m) {
  const mp4 = m.header.mp4
  if (!mp4) return ''
  const rows = []
  if (mp4.brands && mp4.brands.major) {
    rows.push(['Brand', esc(mp4.brands.major.trim()) +
      (mp4.brands.compatible.length ? ` <em>also ${esc(mp4.brands.compatible.join(' '))}</em>` : '')])
  }
  rows.push(['Movie timescale', `${esc(num(mp4.movieTimescale))} / s`])
  rows.push(['Index', esc(mp4.fragmented
    ? `${plural(mp4.fragments, 'fragment')}, ${formatBytes(mp4.moovBytes)} of moov`
    : `moov sample table, ${formatBytes(mp4.moovBytes)}`)])
  rows.push(['moov at', `byte ${esc(num(mp4.moovAt))}`])
  rows.push(['Media data', esc(formatBytes(mp4.mdatBytes))])
  if (mp4.layout && mp4.layout.length) {
    rows.push(['Top-level boxes', mp4.layout
      .map((b) => `${mono(b.type)} at ${esc(num(b.start))} <em>${esc(formatBytes(b.size))}</em>`)
      .join(', ')])
  }

  const tracks = mp4.tracks.map((t) => {
    const trows = [
      ['Sample entry', `${mono((t.entry || '').trim() || 'unknown')}` +
        (t.label ? ` <em>${esc(t.label)}</em>` : '')],
      t.width ? ['Picture', `${t.width} &times; ${t.height}`] : null,
      ['Samples', esc(num(t.samples))],
      ['Timescale', `${esc(num(t.timescale))} / s`],
      ['Duration', esc(formatTime(t.durationMs, false))],
      ['Stored order', esc(t.reordered
        ? 'out of display order (B-frames; composition offsets present)'
        : 'display order')],
      t.editEntries ? ['Edit list', esc(plural(t.editEntries, 'entry', 'entries'))] : null,
      (t.rotation || t.flipH)
        ? ['Orientation', esc(`${ROTATIONS[t.rotation] || t.rotation + ' degrees'}` +
            (t.flipH ? ', mirrored' : ''))]
        : null,
      t.pasp ? ['Pixel aspect', `${t.pasp.hSpacing}:${t.pasp.vSpacing}`] : null
    ].filter(Boolean)
    return `<article class="card"><h3>Track ${esc(t.id)} <span class="tag">` +
      `${esc(t.kind || t.handler)}</span></h3>${kv(trows)}</article>`
  }).join('')

  return section('mp4', 'MP4 structure', kv(rows) + `<div class="cards">${tracks}</div>`)
}

function inventoryHtml (m) {
  const rows = m.inventory.map((row) => `<tr><td>${esc(row.name)}</td>` +
    `<td class="n">${esc(num(row.frames))}</td><td class="n">${esc(num(row.bytes))}</td></tr>`).join('')
  let body = `<table class="grid"><thead><tr><th>Kind</th><th class="n">Frames</th>` +
    `<th class="n">Payload bytes</th></tr></thead><tbody>${rows}</tbody>` +
    `<tfoot><tr><th>Total</th><th class="n">${esc(num(m.inventoryTotals.frames))}</th>` +
    `<th class="n">${esc(num(m.inventoryTotals.bytes))}</th></tr></tfoot></table>`

  if (hasBlueIrisExtras(m.header)) {
    const end = m.lastFrameEnd
    const lines = [
      `Frame headers account for the remaining ${esc(num(Math.max(0, end - m.inventoryTotals.bytes)))} ` +
        'bytes: 16 bytes each, plus post bytes.'
    ]
    if (end === m.size) {
      lines.push(`The last frame ends at byte ${esc(num(end))}, which is the end of the file ` +
        '&mdash; nothing follows it.')
    } else if (end < m.size) {
      lines.push(`The last complete frame ends at byte ${esc(num(end))}, leaving ` +
        `${esc(num(m.size - end))} bytes after it that do not form a whole frame.`)
    }
    if (m.index.resyncs) {
      lines.push(`The scan lost the frame chain ${esc(plural(m.index.resyncs, 'time'))} and ` +
        'resynchronised by searching forward for the next valid frame. Bytes skipped that way ' +
        'are not counted above.')
    }
    body += note(lines.join(' '))
  }
  if (m.overlay && m.overlay.other.length) {
    body += note(`${esc(plural(m.overlay.other.length, 'metadata record'))} carry a subtype this ` +
      `build does not model (${esc([...new Set(m.overlay.other.map((x) => x.subtype))].join(', '))}).`)
  }
  return section('inventory', 'Frame inventory', body)
}

function streamsHtml (m) {
  const { header, index, probe } = m
  const both = index.streams[0].count > 0 && index.streams[1].count > 0
  const cards = []

  for (let si = 0; si < 2; si++) {
    const stats = m.streams[si]
    const p = probe ? probe.streams[si] : null
    if (!stats && !p) continue
    const rows = []

    if (stats) {
      const keyEvery = stats.keys > 1 ? stats.count / stats.keys : 0
      rows.push(['Frames', `${esc(num(stats.count))} <em>${esc(num(stats.keys))} key frames` +
        (keyEvery ? `, one every ~${keyEvery.toFixed(1)}` : '') + '</em>'])
      rows.push(['Media time', `${esc(formatTime(stats.first))} to ${esc(formatTime(stats.last))} ` +
        `<em>${esc(formatTime(stats.span, false))}</em>`])
      rows.push(['Wall clock', stats.firstUtc
        ? `${esc(utcText(stats.firstUtc))}<em>to ${esc(utcText(stats.lastUtc))}</em>`
        : 'these frames carry no UTC post-bytes'])
      rows.push(['Measured rate', esc(stats.fps ? `${stats.fps.toFixed(2)} fps` : 'a single frame')])
      rows.push(['Payload', `${esc(formatBytes(stats.bytes))} ` +
        `<em>smallest ${esc(formatBytes(stats.min))}, largest ${esc(formatBytes(stats.max))}</em>`])
      rows.push(['Bitrate', stats.bitrate ? `${esc((stats.bitrate / 1e6).toFixed(2))} Mbit/s` : '&mdash;'])
      rows.push(['Discontinuities', esc(stats.discontinuities
        ? `${num(stats.discontinuities)} segment starts`
        : 'none after the first frame')])
      if (stats.marks) rows.push(['Marks', esc(num(stats.marks))])
    }
    if (p) {
      rows.push(['Encoded picture', p.width
        ? `${p.width} &times; ${p.height}`
        : 'could not be read from the bitstream'])
      if (p.declaredWidth && (p.declaredWidth !== p.width || p.declaredHeight !== p.height)) {
        rows.push(['Header declares', `${p.declaredWidth} &times; ${p.declaredHeight} ` +
          '<em>the two disagreeing is ordinary on a Blue Iris sub stream</em>'])
      }
      rows.push(['Codec', esc(p.codec.label) +
        (p.codec.config && p.codec.config.codec ? ` <em>${esc(p.codec.config.codec)}</em>` : '') +
        (p.fourcc ? ` <em>FourCC ${esc(p.fourcc.trim())}</em>` : '')])
      rows.push(['Decodable here', p.supported
        ? '<span class="ok">yes</span>'
        : `<span class="bad">no</span> <em>${esc(p.reason)}</em>`])
      if (!p.hasKeyFrame) rows.push(['Key frame', 'none was found to judge the stream by'])
    } else if (stats) {
      rows.push(['Codec', 'the opening probe never reached this stream'])
    }
    if (stats && hasBlueIrisExtras(header)) {
      const seen = STATE_BIT_NAMES
        .map(([, name]) => [name, stats.state[name] || 0])
        .filter(([, n]) => n > 0)
      rows.push(['Camera state', seen.length
        ? seen.map(([name, n]) => `${esc(name)} <em>${esc(num(n))}</em>`).join(', ')
        : 'no state bit is set on any frame'])
      rows.push(['DIO inputs', stats.dioFrames
        ? `set on ${esc(num(stats.dioFrames))} frames <em>mask ${esc(hex(stats.dioSeen, 8))}</em>`
        : 'never set'])
    }

    const title = streamLabelFor(header.container, si, both)
    const tag = stats ? '' : '<span class="tag">no frames found</span>'
    cards.push(`<article class="card"><h3>${esc(title)} ${tag}</h3>${kv(rows)}</article>`)
  }

  const body = cards.length
    ? `<div class="cards">${cards.join('')}</div>`
    : note('None. No frame in the file carries video.')
  return section('streams', 'Video streams', body)
}

function audioHtml (m) {
  const a = m.audio
  if (!a) {
    return section('audio', 'Audio', note(esc(m.header.hasAudio
      ? 'The header declares an audio format, but the file contains no audio packets.'
      : 'The file contains no audio.')))
  }
  return section('audio', 'Audio', kv([
    ['Packets', esc(num(a.count))],
    ['Media time', `${esc(formatTime(a.first))} to ${esc(formatTime(a.last))} ` +
      `<em>${esc(formatTime(a.span, false))}</em>`],
    ['Payload', `${esc(formatBytes(a.bytes))} ` +
      `<em>average ${esc(formatBytes(Math.round(a.bytes / a.count)))} per packet</em>`],
    ['Format', m.header.wfx ? esc(audioCodecLabel(m.header.wfx)) : ''],
    ['Bitrate', a.span > 0 ? `${esc((a.bytes * 8000 / a.span / 1000).toFixed(1))} kbit/s` : '']
  ]))
}

/** One overlay object definition as a card, with its placement drawn to scale. */
function objectCard (def, scale, frameW, frameH) {
  const box = placeRect(def.rect, scale)
  const whole = def.rect.left <= 0 && def.rect.top <= 0 &&
    def.rect.right >= OVERLAY_UNITS && def.rect.bottom >= OVERLAY_UNITS
  const rows = [
    ['Placement', `(${def.rect.left}, ${def.rect.top}) to (${def.rect.right}, ${def.rect.bottom}) ` +
      `of ${OVERLAY_UNITS}${whole ? ' <em>the whole frame</em>' : ''}` +
      (frameW && frameH
        ? ` <em>${Math.round(box.w)}&times;${Math.round(box.h)} px at ` +
          `(${Math.round(box.x)}, ${Math.round(box.y)}) on ${frameW}&times;${frameH}</em>`
        : '')]
  ]
  if (def.type === OBJ_TEXT) {
    const align = def.align === 0 ? 'centred' : def.align < 0 ? 'left aligned' : 'right aligned'
    rows.push(['Font', `${esc(def.font || 'unnamed')} <em>weight ${def.weight}, ` +
      `${def.nlines ? esc(plural(def.nlines, 'line')) : 'no line count'}, ${align}` +
      (def.shadow ? ', shadowed' : '') + '</em>'])
  } else if (def.type === OBJ_GRAPHIC) {
    rows.push(['Bitmap', esc(`${def.transparent ? 'transparent' : 'opaque'}, ` +
      `${def.constrain ? 'aspect kept' : 'stretched to fit'}`)])
  }
  if (def.path) rows.push(['Configured as', mono(def.path)])
  rows.push(['Colour', `${swatch(def.color)} on ${swatch(def.bkcolor)} <em>alpha ${def.alpha}/100</em>`])

  const conditions = []
  if (def.stateflags) {
    conditions.push(`camera state must include ${bits(def.stateflags, STATE_BIT_NAMES, 2)}`)
  }
  if (def.dio) conditions.push(`a DIO input in ${mono(hex(def.dio, 8))} must be set`)
  rows.push(['Drawn when', conditions.length ? conditions.join('; ') : 'always'])

  // The placement box over the frame, so a page of objects reads as a layout.
  const x = (def.rect.left / OVERLAY_UNITS) * 100
  const y = (def.rect.top / OVERLAY_UNITS) * 100
  const w = Math.max(1, ((def.rect.right - def.rect.left) / OVERLAY_UNITS) * 100)
  const h = Math.max(1, ((def.rect.bottom - def.rect.top) / OVERLAY_UNITS) * 100)
  const plan = `<svg class="plan" viewBox="0 0 100 56" preserveAspectRatio="none" aria-hidden="true">` +
    `<rect class="plan__frame" x="0.5" y="0.5" width="99" height="55"/>` +
    `<rect class="plan__box" x="${x.toFixed(2)}" y="${(y * 0.56).toFixed(2)}" ` +
    `width="${w.toFixed(2)}" height="${(h * 0.56).toFixed(2)}"/></svg>`

  return `<article class="card"><h3>Object ${def.index} <span class="tag">${esc(def.typeName)}</span></h3>` +
    `${plan}${kv(rows)}</article>`
}

/**
 * The overlay section: what objects exist, and the log of what they were shown.
 *
 * The log's markup is a shell -- filters, an empty table, a "show more" button.
 * The rows themselves are built in the page from the JSON block, because four
 * thousand rows of server-rendered HTML is most of a megabyte of repeated tags.
 */
function overlayHtml (m) {
  const o = m.overlay
  if (!m.index.metadata.length) {
    return section('overlay', 'Overlay metadata', note('The file carries no metadata frames, so it ' +
      'has no overlay objects, no bounding boxes and no GPS track.'))
  }

  let body = kv([
    ['Definition records', o.defRecord
      ? `1 <em>${esc(num(o.defRecord.size))} bytes, ${esc(plural(o.defs.length, 'object'))}</em>`
      : 'none <em>update records cannot be interpreted without them</em>'],
    ['Update records', o.updates.length
      ? `${esc(num(o.updates.length))} <em>${esc(formatTime(o.firstTs))} to ` +
        `${esc(formatTime(o.lastTs))}</em>`
      : 'none'],
    ['Embedded images', o.images.length
      ? `${esc(plural(o.images.length, 'unique image'))} <em>${esc(formatBytes(o.imageBytes))}` +
        (o.imagesDropped ? `, ${esc(num(o.imagesDropped))} too large to embed` : '') + '</em>'
      : 'none']
  ])

  if (o.defs.length) {
    const frameW = m.header.bmih[0] ? m.header.bmih[0].width : 0
    const frameH = m.header.bmih[0] ? m.header.bmih[0].height : 0
    const scale = rectScaleFor(o.defs.map((d) => d.rect), frameW, frameH)
    body += `<h3 class="subhead">Objects</h3><div class="cards">` +
      o.defs.map((d) => objectCard(d, scale, frameW, frameH)).join('') + '</div>'
  }

  if (!o.records || !o.records.length) {
    body += note('No update record could be read, so there is nothing to log.')
    return section('overlay', 'Overlay metadata', body)
  }

  if (o.capped) {
    body += warn(`This file holds ${esc(num(o.updates.length))} update records; the first ` +
      `${esc(num(o.recordsRead))} are logged below. Past ${esc(num(RECORD_CAP))} a recording is ` +
      'describing a pattern rather than a list, and reading further would cost minutes.')
  }

  body += `<div id="gps-track"></div>
    <h3 class="subhead">Update records</h3>
    <div class="filters">
      <input type="search" id="q" placeholder="Search text and box labels" aria-label="Search">
      <select id="obj" aria-label="Object"><option value="">Any object</option></select>
      <span class="filters__kinds" id="kinds"></span>
      <label class="chk"><input type="checkbox" id="carrying"> carrying something</label>
      <label class="chk">from <input type="text" id="from" size="6" placeholder="0:00"></label>
      <label class="chk">to <input type="text" id="to" size="6" placeholder="end"></label>
      <button type="button" id="reset">Reset</button>
    </div>
    <p class="count" id="count"></p>
    <table class="grid grid--log">
      <thead><tr><th class="n">#</th><th>Media time</th><th>UTC</th>
        <th class="n">Bytes</th><th>Carried</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="more"><button type="button" id="more">Show more</button></div>`

  return section('overlay', 'Overlay metadata', body)
}

function timelineHtml (m) {
  const { index } = m
  const marks = index.marks.slice(0, LIST_LIMIT).map((mk) => `<tr><td>` +
    `${esc(formatTime(mk.ts - index.baseTs))}</td><td>` +
    `${esc(mk.utc ? utcText(mk.utc) : `stream ${mk.stream}, frame ${mk.idx + 1}`)}</td></tr>`).join('')
  const marksBody = index.marks.length
    ? `<table class="grid"><thead><tr><th>Media time</th><th>UTC</th></tr></thead>` +
      `<tbody>${marks}</tbody></table>` +
      (index.marks.length > LIST_LIMIT
        ? note(`&hellip; and ${esc(num(index.marks.length - LIST_LIMIT))} more.`)
        : '')
    : note('None. No frame carries the MARK flag.')

  const segs = m.segments.map((s) => `<tr><td>${esc(formatTime(s.ts))}</td><td>` +
    `${esc(s.utc ? utcText(s.utc) : `stream ${s.si}`)}</td></tr>`).join('')
  const segsBody = m.segmentCount
    ? `<table class="grid"><thead><tr><th>Media time</th><th>UTC</th></tr></thead>` +
      `<tbody>${segs}</tbody></table>` +
      (m.segmentCount > m.segments.length
        ? note(`&hellip; and ${esc(num(m.segmentCount - m.segments.length))} more.`)
        : '')
    : note('One continuous segment &mdash; no ISDISCONTINUITY frame after the first.')

  return section('timeline', 'Marks and segments',
    `<h3 class="subhead">Marks</h3>${marksBody}<h3 class="subhead">Segment starts</h3>${segsBody}`)
}

function unreadableHtml (m) {
  if (!m.head) return ''
  const lines = []
  for (let off = 0; off < m.head.length; off += 16) {
    const chunk = m.head.subarray(off, off + 16)
    const hexes = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hexes.padEnd(47)}  ${ascii}`)
  }
  return section('bytes', 'Opening bytes',
    note('Nothing further could be read, so here is the front of the file for whoever has to work ' +
      'out what it is:') + `<pre class="hex">${esc(lines.join('\n'))}</pre>`)
}

function aboutHtml (m) {
  const bvr = hasBlueIrisExtras(m.header)
  return section('about', 'About this report',
    note('Written by BVR Player, which decodes recordings locally in the browser: nothing in this ' +
      'file left the machine it was made on, and this page loads nothing from the network.') +
    note(bvr
      ? 'Field names and section numbers refer to the Blue Iris BVR file format specification that ' +
        'ships with the player. &ldquo;Media time&rdquo; is measured from the first frame of the ' +
        'recording; wall-clock times are UTC, taken from the per-frame post-bytes the recorder writes.'
      : 'Box and field names are those of the ISO base media file format. &ldquo;Media time&rdquo; ' +
        'is measured from the first sample of the recording.'))
}

// --------------------------------------------------------------- page script

/* eslint-disable */
/**
 * Runs inside the generated page. Self-contained on purpose -- see the module
 * comment: it is emitted through `toString`, so any reference to a binding
 * outside it would be renamed by the bundler into a name the page cannot find.
 */
function reportScript () {
  var el = document.getElementById('report-data')
  if (!el) return
  var D = JSON.parse(el.textContent)
  var $ = function (id) { return document.getElementById(id) }
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ESC[c] })
  }
  var pad = function (v, n) { return String(v).padStart(n || 2, '0') }

  function fmtTime (ms) {
    var t = Math.max(0, Math.floor(ms))
    var h = Math.floor(t / 3600000)
    var m = Math.floor(t / 60000) % 60
    var s = Math.floor(t / 1000) % 60
    return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s) + '.' + pad(t % 1000, 3)
  }
  function parseTime (text) {
    var str = String(text || '').trim()
    if (!str) return null
    if (!/^\d{1,3}(:\d{1,2}){0,2}([.,]\d{1,3})?$/.test(str)) return null
    var parts = str.split(/[.,]/)
    var ms = 0
    parts[0].split(':').forEach(function (p) { ms = ms * 60 + Number(p) })
    ms *= 1000
    if (parts[1]) ms += Number(parts[1].padEnd(3, '0'))
    return ms
  }
  function fmtUtc (ms) {
    if (!ms) return ''
    var d = new Date(ms)
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) +
      '.' + pad(d.getUTCMilliseconds(), 3)
  }
  function fmtBytes (n) {
    if (!n) return '0 B'
    var units = ['B', 'KB', 'MB', 'GB']
    var i = 0
    var v = n
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i]
  }
  // COLORREF is 0x00BBGGRR; CSS wants #RRGGBB.
  function colour (v) {
    return '#' + (((v & 0xff) << 16 | (v & 0xff00) | ((v >> 16) & 0xff)) >>> 0)
      .toString(16).padStart(6, '0')
  }

  // ------------------------------------------------------------- motion mask
  var canvas = $('mask-canvas')
  if (canvas && D.mask) {
    var raw = atob(D.mask.b)
    var cell = Math.max(3, Math.floor(360 / D.mask.w))
    canvas.width = D.mask.w * cell
    canvas.height = D.mask.h * cell
    var ctx = canvas.getContext('2d')
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--mask-off') || '#dfe4ec'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--mask-on') || '#4c8bf5'
    for (var my = 0; my < D.mask.h; my++) {
      for (var mx = 0; mx < D.mask.w; mx++) {
        var bit = my * D.mask.w + mx
        var byte = raw.charCodeAt(bit >> 3)
        if (byte && (byte & (0x80 >> (bit & 7)))) ctx.fillRect(mx * cell, my * cell, cell, cell)
      }
    }
  }

  var recs = D.recs
  if (!recs || !recs.length) return

  var TEXT = 0, IMAGE = 1, SHAPES = 2, GPS = 3, RAW = 4
  var KIND_NAMES = ['text', 'image', 'boxes', 'GPS', 'unread']
  var PAGE = 200

  // ------------------------------------------------------------- images once
  // A data URI is built the first time a record shows the image and kept, so a
  // logo carried by four thousand records is one string in memory and one copy
  // in the file.
  var imgUrls = []
  function imageUrl (id) {
    var img = D.images[id]
    if (!img || !img.d) return ''
    if (!imgUrls[id]) imgUrls[id] = 'data:' + img.m + ';base64,' + img.d
    return imgUrls[id]
  }

  // ------------------------------------------------------------- search text
  // One lowercase haystack per record, built once. Filtering an hour of records
  // on every keystroke is otherwise a scan of every nested entry each time.
  var hay = recs.map(function (r) {
    var parts = []
    r[3].forEach(function (e) {
      if (e[1] === TEXT) parts.push(D.texts[e[2]])
      else if (e[1] === SHAPES) e[2].forEach(function (s) { parts.push(D.labels[s[6]]) })
      else if (e[1] === GPS) parts.push(e[2][0] + ',' + e[2][1])
      parts.push(KIND_NAMES[e[1]], 'object ' + e[0])
    })
    return parts.join(' ').toLowerCase()
  })

  function carries (e) {
    if (e[1] === TEXT) return !!D.texts[e[2]]
    if (e[1] === SHAPES) return e[2].length > 0
    return true
  }

  // ------------------------------------------------------------------ filters
  var kindsBox = $('kinds')
  var present = {}
  recs.forEach(function (r) { r[3].forEach(function (e) { present[e[1]] = true }) })
  Object.keys(present).sort().forEach(function (k) {
    var label = document.createElement('label')
    label.className = 'chk'
    label.innerHTML = '<input type="checkbox" data-kind="' + k + '" checked> ' + KIND_NAMES[k]
    kindsBox.appendChild(label)
  })

  var objSel = $('obj')
  D.defs.forEach(function (d) {
    var opt = document.createElement('option')
    opt.value = String(d.i)
    opt.textContent = 'Object ' + d.i + ' · ' + d.n
    objSel.appendChild(opt)
  })
  if (present[GPS]) {
    var gopt = document.createElement('option')
    gopt.value = '-1'
    gopt.textContent = 'GPS'
    objSel.appendChild(gopt)
  }

  var q = $('q'), carrying = $('carrying'), from = $('from'), to = $('to')
  var rowsBody = $('rows'), countEl = $('count'), moreBtn = $('more'), resetBtn = $('reset')
  var matches = []
  var shown = 0

  function enabledKinds () {
    var on = {}
    kindsBox.querySelectorAll('input[data-kind]').forEach(function (i) {
      if (i.checked) on[i.getAttribute('data-kind')] = true
    })
    return on
  }

  function apply () {
    var kinds = enabledKinds()
    var obj = objSel.value === '' ? null : Number(objSel.value)
    var query = q.value.trim().toLowerCase()
    var only = carrying.checked
    var lo = parseTime(from.value)
    var hi = parseTime(to.value)
    from.classList.toggle('bad-input', from.value.trim() !== '' && lo === null)
    to.classList.toggle('bad-input', to.value.trim() !== '' && hi === null)

    matches = []
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i]
      if (lo !== null && r[0] < lo) continue
      if (hi !== null && r[0] > hi) continue
      if (query && hay[i].indexOf(query) < 0) continue
      var ok = false
      for (var j = 0; j < r[3].length; j++) {
        var e = r[3][j]
        if (!kinds[e[1]]) continue
        if (obj !== null && e[0] !== obj) continue
        if (only && !carries(e)) continue
        ok = true
        break
      }
      if (ok) matches.push(i)
    }
    countEl.textContent = matches.length === recs.length
      ? 'All ' + recs.length.toLocaleString() + ' records.'
      : matches.length.toLocaleString() + ' of ' + recs.length.toLocaleString() + ' records match.'
    rowsBody.textContent = ''
    shown = 0
    more()
  }

  function summary (r) {
    if (!r[3].length) return '<span class="dim">nothing this build could read</span>'
    return r[3].map(function (e) {
      if (e[1] === TEXT) {
        var t = D.texts[e[2]]
        return t
          ? '<span class="pill">#' + e[0] + '</span>' + esc(t.length > 70 ? t.slice(0, 70) + '…' : t)
          : '<span class="pill">#' + e[0] + '</span><span class="dim">empty text</span>'
      }
      if (e[1] === SHAPES) {
        var n = e[2].length
        var names = {}
        e[2].forEach(function (s) { if (D.labels[s[6]]) names[D.labels[s[6]]] = 1 })
        var list = Object.keys(names)
        return '<span class="pill">#' + e[0] + '</span>' + (n
          ? n + (n === 1 ? ' box' : ' boxes') + (list.length ? ' · ' + esc(list.join(', ')) : '')
          : '<span class="dim">no boxes</span>')
      }
      if (e[1] === IMAGE) {
        var img = D.images[e[2]]
        return '<span class="pill">#' + e[0] + '</span>image' + (img ? ' · ' + fmtBytes(img.n) : '')
      }
      if (e[1] === GPS) {
        return '<span class="pill">GPS</span>' + e[2][0].toFixed(5) + ', ' + e[2][1].toFixed(5)
      }
      return '<span class="pill">#' + e[0] + '</span>' + e[2] + ' bytes unread'
    }).join(' ')
  }

  function boxesSvg (shapes) {
    var w = D.frame[0] || 1600
    var h = D.frame[1] || 900
    var vb = 'viewBox="0 0 ' + D.units + ' ' + Math.round(D.units * h / w) + '"'
    var inner = shapes.map(function (s) {
      var x = s[0], y = s[1] * h / w, ww = Math.max(2, s[2] - s[0])
      var hh = Math.max(2, (s[3] - s[1]) * h / w)
      return '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + ww + '" height="' +
        hh.toFixed(1) + '" fill="none" stroke="' + colour(s[5]) + '" stroke-width="4"' +
        (s[4] & 1 ? ' stroke-dasharray="12 6"' : '') + '/>'
    }).join('')
    return '<svg class="boxes" ' + vb + ' preserveAspectRatio="xMidYMid meet">' +
      '<rect class="boxes__frame" x="1" y="1" width="' + (D.units - 2) + '" height="' +
      (Math.round(D.units * h / w) - 2) + '"/>' + inner + '</svg>'
  }

  function detail (r) {
    var out = r[3].map(function (e) {
      var who = e[1] === GPS ? 'GPS fix' : 'Object ' + e[0]
      var body
      if (e[1] === TEXT) {
        body = D.texts[e[2]]
          ? '<pre class="txt">' + esc(D.texts[e[2]]) + '</pre>'
          : '<p class="dim">empty</p>'
      } else if (e[1] === SHAPES) {
        if (!e[2].length) {
          body = '<p class="dim">no boxes</p>'
        } else {
          var rows = e[2].map(function (s) {
            return '<tr><td><span class="sw" style="--sw:' + colour(s[5]) + '"></span>' +
              esc(D.labels[s[6]] || 'unlabelled') + '</td><td class="n">' + s[0] + ', ' + s[1] +
              '</td><td class="n">' + s[2] + ', ' + s[3] + '</td><td>' +
              (s[4] & 1 ? 'triggering' : '') + '</td></tr>'
          }).join('')
          body = boxesSvg(e[2]) + '<table class="grid grid--tight"><thead><tr><th>Label</th>' +
            '<th class="n">Left, top</th><th class="n">Right, bottom</th><th>State</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>'
        }
      } else if (e[1] === IMAGE) {
        var img = D.images[e[2]]
        var url = imageUrl(e[2])
        body = (url ? '<img class="shot" src="' + url + '" alt="overlay image">' : '') +
          '<p class="dim">' + (img ? esc(img.m) + ', ' + fmtBytes(img.n) : 'empty') +
          (img && !img.d ? ' — too large to embed' : '') + '</p>'
      } else if (e[1] === GPS) {
        body = '<p>' + e[2][0].toFixed(6) + ', ' + e[2][1].toFixed(6) +
          ' at ' + e[2][2].toFixed(1) + ' m</p>'
      } else {
        body = '<p class="dim">' + e[2] + ' bytes this build does not interpret</p>'
      }
      // The GPS entry names its own kind, so it does not also get the tag.
      var tag = e[1] === GPS ? '' : ' <span class="tag">' + KIND_NAMES[e[1]] + '</span>'
      return '<div class="entry"><h4>' + esc(who) + tag + '</h4>' + body + '</div>'
    }).join('')
    return out || '<p class="dim">This record carries nothing this build could read.</p>'
  }

  function more () {
    var frag = document.createDocumentFragment()
    var end = Math.min(matches.length, shown + PAGE)
    for (var i = shown; i < end; i++) {
      var idx = matches[i]
      var r = recs[idx]
      var tr = document.createElement('tr')
      tr.className = 'log'
      tr.setAttribute('data-i', String(idx))
      var utc = r[1] === null ? '' : fmtUtc(D.base + r[0] + r[1])
      tr.innerHTML = '<td class="n dim">' + (idx + 1) + '</td><td class="t">' + fmtTime(r[0]) +
        '</td><td class="t dim">' + utc + '</td><td class="n">' + r[2] + '</td><td>' +
        summary(r) + '</td>'
      frag.appendChild(tr)
    }
    rowsBody.appendChild(frag)
    shown = end
    moreBtn.hidden = shown >= matches.length
    moreBtn.textContent = 'Show more (' + (matches.length - shown).toLocaleString() + ' left)'
  }

  rowsBody.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr.log')
    if (!tr) return
    var next = tr.nextElementSibling
    if (next && next.classList.contains('log__detail')) {
      next.remove()
      tr.classList.remove('log--open')
      return
    }
    var r = recs[Number(tr.getAttribute('data-i'))]
    var det = document.createElement('tr')
    det.className = 'log__detail'
    det.innerHTML = '<td colspan="5">' + detail(r) + '</td>'
    tr.classList.add('log--open')
    tr.after(det)
  })

  ;[q, from, to].forEach(function (i) { i.addEventListener('input', apply) })
  objSel.addEventListener('change', apply)
  carrying.addEventListener('change', apply)
  kindsBox.addEventListener('change', apply)
  moreBtn.addEventListener('click', more)
  resetBtn.addEventListener('click', function () {
    q.value = ''
    from.value = ''
    to.value = ''
    objSel.value = ''
    carrying.checked = false
    kindsBox.querySelectorAll('input[data-kind]').forEach(function (i) { i.checked = true })
    apply()
  })

  // ------------------------------------------------------------- a GPS track
  var fixes = []
  recs.forEach(function (r) {
    r[3].forEach(function (e) { if (e[1] === GPS) fixes.push([r[0], e[2][0], e[2][1], e[2][2]]) })
  })
  if (fixes.length) {
    var lats = fixes.map(function (f) { return f[1] })
    var lons = fixes.map(function (f) { return f[2] })
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats)
    var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons)
    var spanLat = maxLat - minLat || 1e-6
    var spanLon = maxLon - minLon || 1e-6
    var pts = fixes.map(function (f) {
      return (((f[2] - minLon) / spanLon) * 100).toFixed(2) + ',' +
        ((1 - (f[1] - minLat) / spanLat) * 100).toFixed(2)
    }).join(' ')
    $('gps-track').innerHTML = '<h3 class="subhead">GPS track</h3>' +
      '<div class="gps"><svg class="gps__plot" viewBox="-4 -4 108 108" preserveAspectRatio="xMidYMid meet">' +
      '<polyline points="' + pts + '"/></svg>' +
      '<dl class="kv"><div><dt>Fixes</dt><dd>' + fixes.length.toLocaleString() + '</dd></div>' +
      '<div><dt>Latitude</dt><dd>' + minLat.toFixed(6) + ' to ' + maxLat.toFixed(6) + '</dd></div>' +
      '<div><dt>Longitude</dt><dd>' + minLon.toFixed(6) + ' to ' + maxLon.toFixed(6) + '</dd></div>' +
      '<div><dt>Altitude</dt><dd>' + Math.min.apply(null, fixes.map(function (f) { return f[3] })).toFixed(1) +
      ' to ' + Math.max.apply(null, fixes.map(function (f) { return f[3] })).toFixed(1) + ' m</dd></div></dl></div>'
  }

  apply()
}
/* eslint-enable */

// ----------------------------------------------------------------- the sheet

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--line:#e2e6ec;--text:#1a1e26;--dim:#606a7b;
--accent:#2563c9;--warn:#8a5a00;--warn-bg:#fff5e0;--warn-line:#e5c27a;--ok:#1a7f47;--bad:#b3261e;
--mask-off:#dfe4ec;--mask-on:#4c8bf5;--code:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--panel:#161b22;--line:#262d38;
--text:#e6ebf2;--dim:#96a2b4;--accent:#58a6ff;--warn:#e0b341;--warn-bg:#2a2210;--warn-line:#5d4a17;
--ok:#56d364;--bad:#ff7b72;--mask-off:#1c222c;--mask-on:#3f7fd6;--code:#1d232c}}
*{box-sizing:border-box}
body{margin:0;padding:0 16px 64px;background:var(--bg);color:var(--text);
font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.top{max-width:1080px;margin:0 auto;padding:28px 0 14px}
.top__kicker{margin:0;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}
.top__name{margin:4px 0 6px;font-size:23px;overflow-wrap:anywhere}
.top__facts{margin:0;color:var(--dim);font-size:13px}
.nav{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:2px;max-width:1080px;
margin:0 auto 18px;padding:8px 0;background:var(--bg);border-bottom:1px solid var(--line)}
.nav a{padding:4px 9px;border-radius:6px;color:var(--dim);text-decoration:none;font-size:12.5px}
.nav a:hover{background:var(--panel);color:var(--text)}
.sec{max-width:1080px;margin:0 auto 26px;padding:16px 18px;background:var(--panel);
border:1px solid var(--line);border-radius:12px}
.sec>h2{margin:0 0 12px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.badge{margin-left:8px;padding:1px 7px;border-radius:999px;background:var(--code);
color:var(--dim);font-size:11px;letter-spacing:0;text-transform:none}
.subhead{margin:20px 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.lede{margin:0 0 12px;font-size:15px}
.note{margin:10px 0 0;color:var(--dim);font-size:12.5px}
.callout{margin:0 0 12px;padding:9px 12px;border-radius:8px;font-size:13px}
.callout--warn{background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn)}
code{padding:1px 5px;border-radius:4px;background:var(--code);
font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.kv{margin:0;font-size:13px}
.kv>div{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid var(--line)}
.kv>div:last-child{border-bottom:0}
.kv dt{flex:0 0 auto;color:var(--dim)}
.kv dd{margin:0;text-align:right;overflow-wrap:anywhere}
.kv em{display:block;color:var(--dim);font-size:11.5px;font-style:normal}
.ok{color:var(--ok)}.bad{color:var(--bad)}.dim{color:var(--dim)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{padding:12px 14px;border:1px solid var(--line);border-radius:10px}
.card>h3{margin:0 0 8px;font-size:14px}
.tag{margin-left:6px;padding:1px 7px;border-radius:999px;background:var(--code);
color:var(--dim);font-size:11px;font-weight:400}
.sw{display:inline-block;width:10px;height:10px;margin-right:5px;border-radius:2px;
background:var(--sw);box-shadow:0 0 0 1px rgba(128,128,128,.5)}
.plan{display:block;width:100%;height:auto;margin:0 0 10px;background:var(--code);border-radius:6px}
.plan__frame{fill:none;stroke:var(--line)}
.plan__box{fill:var(--accent);fill-opacity:.28;stroke:var(--accent);stroke-width:.6}
.grid{width:100%;border-collapse:collapse;font-size:13px}
.grid th,.grid td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line)}
.grid thead th{color:var(--dim);font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.grid tfoot th{border-bottom:0;border-top:2px solid var(--line)}
.grid .n{text-align:right;font-variant-numeric:tabular-nums}
.grid--tight th,.grid--tight td{padding:3px 8px;font-size:12px}
.mask{margin:14px 0 0}
.mask canvas{display:block;width:100%;max-width:360px;border:1px solid var(--line);
border-radius:6px;image-rendering:pixelated}
.mask figcaption{margin-top:6px;color:var(--dim);font-size:12px}
.hex{overflow-x:auto;padding:10px;border-radius:8px;background:var(--code);
font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px}
.filters input[type=search],.filters input[type=text],.filters select{
padding:5px 8px;border:1px solid var(--line);border-radius:7px;background:var(--bg);
color:var(--text);font:inherit;font-size:13px}
.filters input[type=search]{flex:1 1 200px;min-width:150px}
.filters .bad-input{border-color:var(--bad)}
.filters button,.more button{padding:5px 12px;border:1px solid var(--line);border-radius:7px;
background:var(--bg);color:var(--text);font:inherit;font-size:13px;cursor:pointer}
.filters button:hover,.more button:hover{background:var(--code)}
.filters__kinds{display:flex;flex-wrap:wrap;gap:8px}
.chk{display:inline-flex;align-items:center;gap:4px;color:var(--dim);font-size:12.5px}
.count{margin:0 0 8px;color:var(--dim);font-size:12.5px}
.grid--log tbody tr{cursor:pointer}
.grid--log tbody tr.log:hover{background:var(--code)}
.grid--log .t{font-variant-numeric:tabular-nums;white-space:nowrap}
.log--open{background:var(--code)}
.log__detail>td{background:var(--code)}
.pill{display:inline-block;margin-right:5px;padding:0 6px;border-radius:999px;
background:var(--bg);border:1px solid var(--line);color:var(--dim);font-size:11px}
.entry{margin:0 0 10px}
.entry:last-child{margin-bottom:0}
.entry>h4{margin:0 0 5px;font-size:12.5px;color:var(--dim);font-weight:600}
.txt{margin:0;padding:8px 10px;border-radius:6px;background:var(--panel);border:1px solid var(--line);
white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.boxes{display:block;width:100%;max-width:420px;margin:0 0 8px;background:var(--panel);border-radius:6px}
.boxes__frame{fill:none;stroke:var(--line);stroke-width:3}
.shot{display:block;max-width:min(100%,320px);height:auto;margin:0 0 6px;
border:1px solid var(--line);border-radius:6px}
.more{margin-top:10px}
.gps{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}
.gps__plot{flex:0 0 200px;width:200px;height:200px;background:var(--code);border-radius:8px}
.gps__plot polyline{fill:none;stroke:var(--accent);stroke-width:1.4;
stroke-linejoin:round;stroke-linecap:round}
.gps .kv{flex:1 1 240px}
@media print{.nav,.filters,.more{display:none}.sec{break-inside:avoid;border-color:#ccc}}
`.trim()

// -------------------------------------------------------------------- public

/** Renders the model `collectAnalysis` produced as one standalone HTML file. */
export function renderHtmlReport (m) {
  const readable = !(m.failure || !m.header || !m.index)
  const bvr = readable && hasBlueIrisExtras(m.header)

  const parts = [summaryHtml(m)]
  const links = [['summary', 'Summary']]
  if (!readable) {
    parts.push(unreadableHtml(m))
    links.push(['bytes', 'Opening bytes'])
  } else {
    if (bvr) {
      parts.push(bvrHeaderHtml(m), bvrFormatsHtml(m))
      links.push(['header', 'Header'], ['formats', 'Formats'])
    } else {
      parts.push(mp4Html(m))
      links.push(['mp4', 'Structure'])
    }
    parts.push(inventoryHtml(m), streamsHtml(m), audioHtml(m))
    links.push(['inventory', 'Inventory'], ['streams', 'Streams'], ['audio', 'Audio'])
    if (bvr) {
      parts.push(overlayHtml(m), timelineHtml(m))
      links.push(['overlay', 'Overlay'], ['timeline', 'Marks'])
    }
  }
  parts.push(aboutHtml(m))
  links.push(['about', 'About'])

  const data = readable ? buildPageData(m) : null
  const needsScript = !!data && (data.recs || data.mask)
  const script = needsScript
    ? `<script id="report-data" type="application/json">${jsonBlock(data)}</script>` +
      `<script>(${reportScript.toString()})()</script>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="BVR Player">
<title>${esc(m.fileName || 'recording')} &mdash; metadata</title>
<style>${CSS}</style>
</head>
<body>
${bannerHtml(m)}
${navHtml(links)}
<main>
${parts.join('\n')}
</main>
${script}
</body>
</html>
`
}
