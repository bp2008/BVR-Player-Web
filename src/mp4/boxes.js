/**
 * ISO base media file format box walking (ISO/IEC 14496-12).
 *
 * Deliberately two layers. `walk` and `find` work over a `Uint8Array` that is
 * already in hand and are therefore synchronous, which is what the sample-table
 * parse wants -- it touches thousands of small fields and an await per box would
 * dominate. `scanTopLevel` is the async one, and it only ever reads the 8 or 16
 * bytes of a box header at a time, so finding `moov` in a 4 GB file costs a
 * handful of short reads rather than a scan.
 *
 * The reverse of `src/export/mp4Muxer.js`, and the two agree about rather more
 * than the boxes: an export written by this app is a file this reads back.
 */

const enc = new TextDecoder('latin1')

/** A box header: type, total size, and where its payload starts. */
function readHeader (view, at, limit) {
  if (at + 8 > limit) return null
  let size = view.getUint32(at)
  const type = enc.decode(new Uint8Array(view.buffer, view.byteOffset + at + 4, 4))
  let headerSize = 8

  if (size === 1) {
    if (at + 16 > limit) return null
    // 64-bit sizes only appear on a huge `mdat`, and a length that large is
    // still far inside the exact-integer range of a double.
    const hi = view.getUint32(at + 8)
    const lo = view.getUint32(at + 12)
    size = hi * 4294967296 + lo
    headerSize = 16
  } else if (size === 0) {
    // "To the end of the file" -- legal, and what a live-written recording that
    // was never finalised looks like.
    size = limit - at
  }

  if (size < headerSize) return null
  // A `uuid` box names itself in the 16 bytes after the type. Nothing here reads
  // one, but its payload must not be mistaken for children.
  if (type === 'uuid') headerSize += 16
  return { type, size, headerSize, start: at, body: at + headerSize, end: at + size }
}

/**
 * Calls `fn(box, view)` for each box in [from, to) of `bytes`.
 *
 * Stops at the first malformed header rather than throwing: a truncated file --
 * a recording interrupted mid-write, which is exactly the case this app exists
 * to salvage -- is common enough that "everything up to the damage" is a more
 * useful answer than an exception.
 */
export function walk (bytes, from, to, fn) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = from
  while (at < to) {
    const box = readHeader(view, at, to)
    if (!box) break
    if (fn(box, view) === false) break
    at = box.end
  }
}

/** The first child box of the given type, or null. */
export function find (bytes, from, to, type) {
  let hit = null
  walk(bytes, from, to, (box) => {
    if (box.type === type) { hit = box; return false }
  })
  return hit
}

/** Every child box of the given type. */
export function findAll (bytes, from, to, type) {
  const hits = []
  walk(bytes, from, to, (box) => { if (box.type === type) hits.push(box) })
  return hits
}

/**
 * Follows a path of box types down from a starting range, e.g.
 * `descend(bytes, 0, len, ['moov', 'trak', 'mdia'])`. Returns the innermost box
 * or null if any step is missing.
 */
export function descend (bytes, from, to, path) {
  let lo = from
  let hi = to
  let box = null
  for (const type of path) {
    box = find(bytes, lo, hi, type)
    if (!box) return null
    lo = box.body
    hi = box.end
  }
  return box
}

/** A FullBox's version and flags, from the four bytes at `at`. */
export function fullBoxHeader (view, at) {
  const v = view.getUint32(at)
  return { version: v >>> 24, flags: v & 0xffffff }
}

/**
 * Walks the top-level boxes of the file, reading only their headers.
 *
 * `onBox` may return `false` to stop early -- which is what finding `moov`
 * before a multi-gigabyte `mdat` is skipped over should do.
 */
export async function scanTopLevel (reader, onBox) {
  let pos = 0
  const size = reader.size
  while (pos + 8 <= size) {
    const head = await reader.read(pos, Math.min(16, size - pos))
    const box = readHeader(head, 0, head.byteLength)
    if (!box) break
    const abs = {
      type: box.type,
      size: box.size,
      headerSize: box.headerSize,
      start: pos,
      body: pos + box.headerSize,
      end: pos + box.size
    }
    // A box claiming to run past the end of the file is the signature of a
    // truncated recording; report it at its real extent so the caller can still
    // use what is there.
    if (abs.end > size) abs.end = size
    if ((await onBox(abs)) === false) return
    if (abs.end <= pos) break
    pos = abs.end
  }
}

/** Reads a whole box (header included) into its own buffer. */
export async function readBox (reader, box) {
  return reader.readCopy(box.start, box.end - box.start)
}

/** A four-character type read as a string, for sample entries and brands. */
export function typeAt (view, at) {
  return enc.decode(new Uint8Array(view.buffer, view.byteOffset + at, 4))
}

/**
 * Whether the first bytes of a file look like ISO base media.
 *
 * The check is "a well-formed box whose type is one of the handful that legally
 * open such a file", not merely "ftyp at offset 4": some recorders write a bare
 * `moov`/`mdat` pair with no `ftyp` at all, and a QuickTime `.mov` may open with
 * `wide` or `skip`.
 */
export function looksLikeIso (bytes) {
  if (!bytes || bytes.length < 8) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = view.getUint32(0)
  const type = enc.decode(bytes.subarray(4, 8))
  if (!/^[\x20-\x7e]{4}$/.test(type)) return false
  const openers = ['ftyp', 'moov', 'mdat', 'styp', 'free', 'skip', 'wide', 'pnot', 'moof']
  if (!openers.includes(type)) return false
  // `size` may be 0 ("to EOF") or 1 ("64-bit size follows"); anything else has
  // to at least cover its own header.
  return size === 0 || size === 1 || size >= 8
}
