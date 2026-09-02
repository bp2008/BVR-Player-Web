/**
 * What a metadata report is made of, gathered once for whichever renderer asks.
 *
 * The two reports -- plain text and standalone HTML -- describe the same file
 * and differ only in how much of it they show and how it is presented, so
 * everything that costs a read or a pass over the index happens here and both
 * renderers work from the model this produces. `reportText.js` and
 * `reportHtml.js` contain no file access at all.
 *
 * Analysis must never refuse a file. It is asked for precisely when something is
 * wrong, so the container is opened in `tolerant` mode -- which skips the one
 * refusal `openContainer` normally makes, a file this device cannot decode --
 * and every stage after that is allowed to fail and still leave a model
 * describing what was learned before it did.
 */

import { BlobReader } from '../bvr/blobReader.js'
import { openContainer, sniffContainer } from './open.js'
import { hasBlueIrisExtras, streamLabelFor } from './mediaInfo.js'
import { readFrameHeader } from '../bvr/parseFileHeader.js'
import {
  FLAG_ISKEY, FLAG_ISAUDIO, FLAG_ISMETADATA, FLAG_ISDISCONTINUITY, FLAG_SUBSTREAM,
  FLAG_ISHEADER, FLAG_MARK, FLAG_MAINAVAILABLE, STATE_BIT_NAMES
} from '../bvr/constants.js'
import { parseObjectDefinitions, parseObjectUpdates } from '../bvr/metadata.js'

// How many overlay update records the detailed report will decode. A recording
// writes one after every key frame and again whenever any object's content
// changes, so an hour is a few thousand; this is the point past which a file is
// describing a pattern rather than a list, and reading on would cost minutes.
export const RECORD_CAP = 25000

// Records sit next to the video frame they describe, so they are scattered the
// length of the file and each is a few hundred bytes at most. Reading each one
// exactly beats any windowed reader -- pulling a megabyte to reach eight bytes
// is the slower answer -- but neighbours that share a read are free, so a run is
// coalesced while the gap stays small and the span stays modest.
const READ_GAP = 48 << 10
const READ_SPAN = 2 << 20

// A graphic overlay's image is rewritten in full in every record that touches
// it, so a report that embedded each copy would be hundreds of megabytes of the
// same logo. Unique images are pooled and every record points at one; this caps
// what that pool may hold.
const IMAGE_BYTES_CAP = 8 << 20

// Marks and segment starts are ordinarily a handful. A file with thousands is
// describing a pattern too, and neither report is improved by printing them all.
export const LIST_LIMIT = 500

// Enough of an unrecognised file to see what it actually is.
const SNIFF_BYTES = 64

// The share of the progress bar the index scan gets when overlay records have to
// be read afterwards. The scan reads every byte and the records are a few
// thousand short seeks, so the split is nowhere near even.
const INDEX_SHARE = 0.85

export const FRAME_FLAG_NAMES = [
  [FLAG_ISKEY, 'ISKEY'],
  [FLAG_ISAUDIO, 'ISAUDIO'],
  [FLAG_ISMETADATA, 'ISMETADATA'],
  [FLAG_ISDISCONTINUITY, 'ISDISCONTINUITY'],
  [FLAG_SUBSTREAM, 'SUBSTREAM'],
  [FLAG_ISHEADER, 'ISHEADER'],
  [FLAG_MARK, 'MARK'],
  [FLAG_MAINAVAILABLE, 'MAINAVAILABLE']
]

export const ROTATIONS = {
  0: 'none',
  90: '90 degrees clockwise',
  180: '180 degrees',
  270: '270 degrees clockwise'
}

// ---------------------------------------------------------------- formatting

export const num = (v) => Number(v || 0).toLocaleString()
export const pad = (v, n = 2) => String(v).padStart(n, '0')
export const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`

export function hex (v, digits) {
  return `0x${(v >>> 0).toString(16).padStart(digits, '0')}`
}

/** A timestamp as UTC, which is the only reading two people will agree on. */
export function utcText (ms) {
  if (!ms) return 'absent'
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)} UTC`
}

export function localText (ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** The names of the bits that are set, for a renderer to present as it likes. */
export function flagNames (value, names) {
  return names.filter(([bit]) => value & bit).map(([, name]) => name)
}

/** `FE.20260828_180000Z_5.bvr` -> `FE.20260828_180000Z_5.metadata`. */
export function reportBaseName (fileName) {
  const base = String(fileName || 'recording').replace(/\.(bvr|mp4|m4v|mov)$/i, '')
  return `${base || 'recording'}.metadata`
}

// -------------------------------------------------------------------- images

const IMAGE_KINDS = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['image/bmp', [0x42, 0x4d]]
]

function imageMime (bytes) {
  for (const [mime, sig] of IMAGE_KINDS) {
    if (sig.every((b, i) => bytes[i] === b)) return mime
  }
  // RIFF....WEBP
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  return 'application/octet-stream'
}

/**
 * Identity for an overlay image without hashing it.
 *
 * The question being answered is only "is this the same picture the last record
 * carried", and length plus both ends settles that for images a recorder wrote
 * itself. A wrong answer would show one logo where another belonged, which is
 * not worth a megabyte of hashing per record to rule out.
 */
function imageKey (bytes) {
  const edge = (from, len) => {
    let s = ''
    for (let i = from; i < from + len && i < bytes.length; i++) s += bytes[i].toString(16)
    return s
  }
  return `${bytes.length}:${edge(0, 24)}:${edge(Math.max(0, bytes.length - 24), 24)}`
}

/** Pools unique images so a record can refer to one rather than carry it. */
class ImagePool {
  constructor () {
    this.list = []
    this.bytes = 0
    this.dropped = 0
    this._byKey = new Map()
  }

  add (data) {
    if (!data || !data.length) return -1
    const key = imageKey(data)
    const hit = this._byKey.get(key)
    if (hit !== undefined) return hit
    const id = this.list.length
    const overBudget = this.bytes + data.length > IMAGE_BYTES_CAP
    if (overBudget) this.dropped++
    else this.bytes += data.length
    this.list.push({
      mime: imageMime(data),
      size: data.length,
      // Dropped images keep their slot so counts and references stay honest;
      // only the pixels are missing.
      data: overBudget ? null : data
    })
    this._byKey.set(key, id)
    return id
  }
}

// -------------------------------------------------------------------- gather

/** Reads a file as far as it can be read. Throwing is the caller's business. */
async function openForReport (blob, { header, index, probe, onProgress, shouldStop }) {
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

/** Frame 0 exactly as it is on disk, rather than as the parser reconstructed it. */
async function readRawHeaderFrame (blob) {
  const reader = new BlobReader(blob, 4096)
  try {
    const view = await reader.read(0, Math.min(blob.size, 32))
    return readFrameHeader(view, 0)
  } catch {
    return null
  } finally {
    reader.release()
  }
}

/**
 * Decodes overlay update records, coalescing neighbours into shared reads.
 *
 * `limit` is what stops a pathological file from taking minutes; the caller is
 * told how many were read so the report can say so rather than quietly lie
 * about how many exist.
 */
async function readUpdateRecords (blob, updates, defs, pool, baseTs, limit, onProgress, shouldStop) {
  const out = []
  let i = 0
  while (i < updates.length && out.length < limit) {
    if (shouldStop && shouldStop()) break
    const start = updates[i].offset
    let j = i
    let end = start + updates[i].size
    while (j + 1 < updates.length && out.length + (j + 2 - i) <= limit) {
      const next = updates[j + 1]
      if (next.offset - end > READ_GAP) break
      if (next.offset + next.size - start > READ_SPAN) break
      j++
      end = next.offset + next.size
    }

    let bytes = null
    try {
      bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer())
    } catch {
      // A read that fails here ends the run rather than the report: what was
      // decoded up to this point is still worth showing.
      break
    }
    for (let k = i; k <= j; k++) {
      const rec = updates[k]
      const at = rec.offset - start
      if (at + rec.size > bytes.length) break
      out.push(decodeRecord(rec, bytes.subarray(at, at + rec.size), defs, pool, baseTs))
    }
    i = j + 1
    if (onProgress) onProgress(Math.min(1, i / updates.length))
  }
  return out
}

/**
 * One type-2 record, with any image lifted into the pool.
 *
 * `ts` is rebased onto the same zero the frame tables use. The indexer leaves
 * metadata timestamps raw where it rebases everything else, and every file to
 * hand starts at zero anyway -- but a report that put a record at 0:04 and the
 * frame it was written after at 0:00 would be describing the reader, not the
 * recording.
 */
function decodeRecord (rec, bytes, defs, pool, baseTs) {
  const entries = []
  for (const u of parseObjectUpdates(bytes, defs)) {
    if (u.kind === 'image') {
      entries.push({ index: u.index, kind: 'image', imageId: pool.add(u.image) })
    } else {
      entries.push(u)
    }
  }
  return { offset: rec.offset, size: rec.size, ts: rec.ts - baseTs, utc: rec.utc, entries }
}

/**
 * The overlay side of the file: what objects exist, and what they were told to
 * show.
 *
 * `detailed` decides how much of the second half is read. The plain-text report
 * takes the first and last records, which is enough to say what the overlay was
 * and how it ended; the HTML report takes every record, because listing them is
 * the whole reason it exists.
 */
async function readOverlay (blob, index, { detailed, onProgress, shouldStop }) {
  const out = {
    defRecord: null,
    defs: [],
    updates: [],
    other: [],
    records: null,
    recordsRead: 0,
    capped: false,
    first: null,
    last: null,
    firstTs: 0,
    lastTs: 0,
    images: [],
    imageBytes: 0,
    imagesDropped: 0
  }
  if (!index || !index.metadata || !index.metadata.length) return out

  out.defRecord = index.metadata.find((m) => m.subtype === 1) || null
  out.updates = index.metadata.filter((m) => m.subtype === 2)
  out.other = index.metadata.filter((m) => m.subtype !== 1 && m.subtype !== 2)
  if (out.updates.length) {
    out.firstTs = out.updates[0].ts - index.baseTs
    out.lastTs = out.updates[out.updates.length - 1].ts - index.baseTs
  }

  const pool = new ImagePool()
  const reader = new BlobReader(blob, 256 << 10)
  try {
    if (out.defRecord) {
      const bytes = await reader.readCopy(out.defRecord.offset, out.defRecord.size)
      out.defs = parseObjectDefinitions(bytes)
    }
  } catch {
    // A truncated definition record leaves the updates uninterpretable, but the
    // counts above survive to say the records were there.
  } finally {
    reader.release()
  }

  if (detailed && out.updates.length) {
    out.records = await readUpdateRecords(
      blob, out.updates, out.defs, pool, index.baseTs, RECORD_CAP, onProgress, shouldStop)
    out.recordsRead = out.records.length
    out.capped = out.recordsRead < out.updates.length
    out.first = out.records[0] || null
    // Only the real last record gets to be called that. When the cap stopped the
    // read early the final record in hand is one from the middle of the file,
    // and a report labelling it "last" would be stating something untrue.
    out.last = (!out.capped && out.records.length > 1)
      ? out.records[out.records.length - 1]
      : null
  } else if (out.updates.length) {
    const ends = [out.updates[0]]
    if (out.updates.length > 1) ends.push(out.updates[out.updates.length - 1])
    const read = await readUpdateRecords(blob, ends, out.defs, pool, index.baseTs, 2, null, shouldStop)
    out.first = read[0] || null
    out.last = read[1] || null
    out.recordsRead = read.length
  }

  out.images = pool.list
  out.imageBytes = pool.bytes
  out.imagesDropped = pool.dropped
  return out
}

// --------------------------------------------------------------------- stats

/** Everything a report says about one video stream, in one pass over it. */
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
    // segment start, which is what the reports mean by the word.
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

/** Where the last complete frame ends, so a report can say what follows it. */
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

const METADATA_SUBTYPES = { 1: 'object definitions', 2: 'object updates' }

/** The frame-inventory table both reports print. */
function buildInventory (header, index) {
  const bvr = hasBlueIrisExtras(header)
  const both = index.streams[0].count > 0 && index.streams[1].count > 0
  const rows = []
  if (bvr) rows.push({ name: 'Header', frames: 1, bytes: Math.max(0, header.firstFrameOffset - 32) })
  for (let si = 0; si < 2; si++) {
    const s = index.streams[si]
    // A second stream the file neither describes nor carries is not a row
    // reading zero -- it is a stream that does not exist. A BVR whose header
    // declares one still gets the row, because "declared but empty" is a fact
    // worth seeing.
    if (si === 1 && s.count === 0 && !header.bmih[1]) continue
    rows.push({
      name: streamLabelFor(header.container, si, both),
      frames: s.count,
      bytes: sumSizes(s.size, s.count)
    })
  }
  rows.push({ name: 'Audio', frames: index.audio.count, bytes: sumSizes(index.audio.size, index.audio.count) })

  if (bvr) {
    const byType = new Map()
    for (const m of index.metadata) {
      const cur = byType.get(m.subtype) || { n: 0, bytes: 0 }
      cur.n++
      cur.bytes += m.size
      byType.set(m.subtype, cur)
    }
    if (!byType.size) rows.push({ name: 'Metadata', frames: 0, bytes: 0 })
    for (const subtype of [...byType.keys()].sort((a, b) => a - b)) {
      const v = byType.get(subtype)
      const known = METADATA_SUBTYPES[subtype]
      rows.push({
        name: `Metadata, type ${subtype}${known ? ` (${known})` : ''}`,
        frames: v.n,
        bytes: v.bytes
      })
    }
  }
  return rows
}

/** Every frame after the first that opens a new recording segment. */
function collectSegments (index) {
  const out = []
  for (let si = 0; si < 2; si++) {
    const s = index.streams[si]
    for (let i = 1; i < s.count; i++) {
      if (s.flags[i] & FLAG_ISDISCONTINUITY) out.push({ si, ts: s.ts[i], utc: s.utc[i] })
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

function audioStats (index) {
  const a = index.audio
  if (!a.count) return null
  return {
    count: a.count,
    bytes: sumSizes(a.size, a.count),
    first: a.ts[0],
    last: a.ts[a.count - 1],
    span: a.ts[a.count - 1] - a.ts[0]
  }
}

// -------------------------------------------------------------------- public

/**
 * Everything either report needs, read once.
 *
 * `header`, `index` and `probe` may be passed in when the file is already open,
 * which is the difference between an instant report and reading a gigabyte
 * again. `detailed` asks for every overlay update record rather than the two at
 * the ends. Nothing about the file itself can make this throw.
 */
export async function collectAnalysis (blob, opts = {}) {
  const { detailed = false, onProgress, shouldStop } = opts
  const mustOpen = !(opts.header && opts.index)
  const indexShare = (mustOpen && detailed) ? INDEX_SHARE : (mustOpen ? 1 : 0)
  const report = (p) => { if (onProgress) onProgress(Math.max(0, Math.min(1, p))) }

  const { header, index, probe, failure, kind } = await openForReport(blob, {
    header: opts.header,
    index: opts.index,
    probe: opts.probe,
    onProgress: (p) => report(p * indexShare),
    shouldStop
  })

  const model = {
    fileName: opts.fileName || '',
    size: blob.size,
    generatedAt: Date.now(),
    kind,
    header,
    index,
    probe,
    failure,
    detailed,
    rawHeaderFrame: null,
    head: null,
    streams: [null, null],
    videoFrames: 0,
    inventory: [],
    inventoryTotals: { frames: 0, bytes: 0 },
    lastFrameEnd: 0,
    audio: null,
    overlay: null,
    segments: [],
    segmentCount: 0
  }

  if (failure || !header || !index) {
    try {
      model.head = new Uint8Array(await blob.slice(0, Math.min(blob.size, SNIFF_BYTES)).arrayBuffer())
    } catch { /* nothing more to say about a blob that will not even slice */ }
    report(1)
    return model
  }

  const bvr = hasBlueIrisExtras(header)
  if (bvr) model.rawHeaderFrame = await readRawHeaderFrame(blob)

  model.streams = [streamStats(index.streams[0]), streamStats(index.streams[1])]
  model.videoFrames = index.streams[0].count + index.streams[1].count
  model.inventory = buildInventory(header, index)
  for (const row of model.inventory) {
    model.inventoryTotals.frames += row.frames
    model.inventoryTotals.bytes += row.bytes
  }
  model.lastFrameEnd = lastFrameEnd(index)
  model.audio = audioStats(index)
  const segments = collectSegments(index)
  model.segmentCount = segments.length
  model.segments = segments.slice(0, LIST_LIMIT)

  if (bvr) {
    model.overlay = await readOverlay(blob, index, {
      detailed,
      onProgress: (p) => report(indexShare + p * (1 - indexShare)),
      shouldStop
    })
  }
  report(1)
  return model
}
