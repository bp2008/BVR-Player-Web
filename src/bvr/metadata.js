/**
 * Overlay metadata records (spec section 7).
 *
 * Two record types share the ISMETADATA flag, distinguished by `flags >> 8`:
 * type 1 defines the overlay objects once near the start of the file, type 2
 * carries their changing content throughout it. Together they describe the text,
 * clock, graphic and shape (motion / AI bounding box) layers Blue Iris drew --
 * or would have drawn -- over the recording, plus a GPS track.
 *
 * Coordinate space
 * ----------------
 * The spec describes both the object placement rectangle and `shapeobdata.rect`
 * as "video pixels". Every file actually written by Blue Iris disagrees: a
 * full-frame overlay is (0, 0, 1000, 1000), and bounding boxes on a 1920x1080
 * recording reach exactly 1000 at the frame edge. The rectangles are per-axis
 * fractions of the frame in thousandths, which is also the only reading under
 * which the spec's own "if right <= left, treat width as 100" default makes
 * sense as a placement rule. Files are the authority here, so RECTs are read as
 * thousandths, with a fall-back to pixels for any rectangle that overflows that
 * range (see `rectScaleFor`).
 */

export const OVEROBDATA_SIZE = 692
export const SHAPEOBDATA_SIZE = 56

/** Full-frame extent of an overlay rectangle, per axis. */
export const OVERLAY_UNITS = 1000

// Spec 7.1: the writer allows 63 objects; bit 63 of its change mask is GPS.
const MAX_OBJECTS = 63

// Spec 7.2: the reference reader ignores text records larger than this.
const MAX_TEXT_BYTES = 2046

export const OBJ_TEXT = 0
export const OBJ_GRAPHIC = 1
export const OBJ_SHAPES = 2

/** Shape flag bit 0: the object is currently triggering (spec 7.2). */
export const SHAPE_TRIGGERING = 0x1

const OBJECT_TYPE_NAMES = { 0: 'text', 1: 'graphic', 2: 'shapes' }

export function objectTypeName (type) {
  return OBJECT_TYPE_NAMES[type] || `type ${type}`
}

/** Reads a null-terminated UTF-16LE string of at most `maxUnits` code units. */
function readUtf16 (view, off, maxUnits) {
  let out = ''
  for (let i = 0; i < maxUnits; i++) {
    const at = off + i * 2
    if (at + 2 > view.byteLength) break
    const code = view.getUint16(at, true)
    if (code === 0) break
    out += String.fromCharCode(code)
  }
  return out
}

/** Reads a null-terminated single-byte string (ASCII/ANSI label fields). */
function readAnsi (view, off, maxBytes) {
  let out = ''
  for (let i = 0; i < maxBytes; i++) {
    const at = off + i
    if (at >= view.byteLength) break
    const b = view.getUint8(at)
    if (b === 0) break
    out += String.fromCharCode(b)
  }
  return out
}

function readRect (view, off) {
  return {
    left: view.getInt32(off, true),
    top: view.getInt32(off + 4, true),
    right: view.getInt32(off + 8, true),
    bottom: view.getInt32(off + 12, true)
  }
}

/** COLORREF is 0x00BBGGRR; CSS wants #RRGGBB. */
export function colorRefToCss (bgr) {
  const r = bgr & 0xff
  const g = (bgr >> 8) & 0xff
  const b = (bgr >> 16) & 0xff
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * Type 1: the array of fixed-size `overobdata` structures that names every
 * overlay object. Object identity is its position in this array.
 */
export function parseObjectDefinitions (bytes) {
  if (!bytes || bytes.length < OVEROBDATA_SIZE) return []
  const view = viewOf(bytes)
  const count = Math.min(MAX_OBJECTS, Math.floor(bytes.length / OVEROBDATA_SIZE))
  const out = []
  for (let i = 0; i < count; i++) {
    const o = i * OVEROBDATA_SIZE
    const type = view.getInt32(o + 664, true)
    // Spec 7.1: dio is honoured only when the reserved dio_x[2] byte is clear.
    const dioHonoured = view.getUint8(o + 662) === 0
    out.push({
      index: i,
      rect: readRect(view, o),
      path: readUtf16(view, o + 16, 260),
      font: readUtf16(view, o + 536, 40),
      nlines: view.getInt32(o + 616, true),
      stateflags: view.getUint32(o + 620, true),
      dio: dioHonoured ? view.getUint32(o + 656, true) : 0,
      type,
      typeName: objectTypeName(type),
      weight: view.getUint32(o + 668, true),
      color: view.getUint32(o + 672, true),
      bkcolor: view.getUint32(o + 676, true),
      alpha: view.getUint8(o + 680),
      // One union each: bitmaps read `transparent` / `constrain`, text reads
      // `align` (low byte, signed: 0 centre, -1 left, 1 right) / `shadow`.
      transparent: view.getInt32(o + 684, true) !== 0,
      align: view.getInt8(o + 684),
      constrain: view.getInt32(o + 688, true) !== 0,
      shadow: view.getInt32(o + 688, true) !== 0
    })
  }
  return out
}

/** One 56-byte `shapeobdata`: a bounding box with a style bit and a label. */
function parseShapes (view, off, size) {
  const count = Math.floor(size / SHAPEOBDATA_SIZE)
  const out = []
  for (let i = 0; i < count; i++) {
    const o = off + i * SHAPEOBDATA_SIZE
    const flags = view.getUint32(o + 16, true)
    out.push({
      rect: readRect(view, o),
      flags,
      triggering: !!(flags & SHAPE_TRIGGERING),
      color: view.getUint32(o + 20, true),
      label: readAnsi(view, o + 24, 32)
    })
  }
  return out
}

/**
 * Type 2: a sequence of `{ int32 index, int32 size, bytes }` updates.
 *
 * How `bytes` is read depends on the referenced object's declared type, so the
 * definitions from the type-1 record have to be supplied. An update naming an
 * object we have no definition for is still returned -- as `kind: 'unknown'`
 * with its raw bytes -- rather than dropped, because the inspector should be
 * able to show that the file carries something this build does not model.
 */
export function parseObjectUpdates (bytes, defs = []) {
  const out = []
  if (!bytes || bytes.length < 8) return out
  const view = viewOf(bytes)
  let p = 0
  while (p + 8 <= bytes.length) {
    const index = view.getInt32(p, true)
    const size = view.getInt32(p + 4, true)
    p += 8
    if (size < 0 || p + size > bytes.length) break
    const body = p
    p += size

    if (index === -1) {
      // Spec 7.2: GPS is written first and is the only negative index.
      if (size === 24) {
        out.push({
          index,
          kind: 'gps',
          gps: {
            altitude: view.getFloat64(body, true),
            latitude: view.getFloat64(body + 8, true),
            longitude: view.getFloat64(body + 16, true)
          }
        })
      }
      continue
    }

    const def = defs[index]
    const type = def ? def.type : -1
    if (type === OBJ_SHAPES) {
      out.push({ index, kind: 'shapes', shapes: parseShapes(view, body, size) })
    } else if (type === OBJ_GRAPHIC) {
      out.push({ index, kind: 'image', image: size ? bytes.slice(body, body + size) : null })
    } else if (type === OBJ_TEXT) {
      out.push({
        index,
        kind: 'text',
        text: size && size <= MAX_TEXT_BYTES ? readUtf16(view, body, size >> 1) : ''
      })
    } else {
      out.push({ index, kind: 'unknown', size, bytes: bytes.slice(body, body + size) })
    }
  }
  return out
}

/**
 * Whether a set of rectangles is in thousandths or in raw pixels.
 *
 * Everything Blue Iris writes uses thousandths, but a rectangle that runs past
 * that range can only be pixels, and scaling it as a fraction would put it far
 * outside the frame. Judging a whole record at once keeps one overlay
 * internally consistent.
 */
export function rectScaleFor (rects, frameW, frameH) {
  let overflow = false
  for (const r of rects) {
    if (r.right > OVERLAY_UNITS || r.bottom > OVERLAY_UNITS ||
        r.left < -OVERLAY_UNITS || r.top < -OVERLAY_UNITS) { overflow = true; break }
  }
  return overflow
    ? { x: 1, y: 1 }
    : { x: frameW / OVERLAY_UNITS, y: frameH / OVERLAY_UNITS }
}

/**
 * Places a rectangle in frame pixels.
 *
 * Spec 7.1: a degenerate rectangle means no extent was configured, and the
 * default is 100 units -- a tenth of the frame.
 */
export function placeRect (rect, scale) {
  const left = rect.left * scale.x
  const top = rect.top * scale.y
  const right = rect.right > rect.left ? rect.right * scale.x : left + 100 * scale.x
  const bottom = rect.bottom > rect.top ? rect.bottom * scale.y : top + 100 * scale.y
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * The live content of every overlay object, folded forward record by record.
 *
 * Type-2 records are deltas: only objects whose content changed are written, so
 * the state at a given time is the first record -- which spec 7 guarantees holds
 * every object's initial content -- plus every record since. Objects are keyed
 * by their definition index, which is stable for the whole file.
 */
export class OverlayState {
  constructor (defs = []) {
    this.defs = defs
    this.objects = new Map()
    this.gps = null
    // Bumped on reset so an image decode started for a superseded state can be
    // recognised and dropped rather than painted over the current one.
    this.generation = 1
  }

  reset () {
    this.generation++
    for (const obj of this.objects.values()) {
      if (obj.bitmap) obj.bitmap.close()
    }
    this.objects.clear()
    this.gps = null
  }

  _slot (index) {
    let obj = this.objects.get(index)
    if (!obj) {
      obj = {
        index,
        def: this.defs[index] || null,
        text: '',
        shapes: [],
        bitmap: null,
        imageBytes: null,
        raw: null
      }
      this.objects.set(index, obj)
    }
    return obj
  }

  /** Folds one parsed type-2 record in. Image decoding continues in background. */
  apply (updates) {
    for (const u of updates) {
      if (u.kind === 'gps') { this.gps = u.gps; continue }
      const obj = this._slot(u.index)
      if (u.kind === 'text') obj.text = u.text
      else if (u.kind === 'shapes') obj.shapes = u.shapes
      else if (u.kind === 'unknown') obj.raw = u.bytes
      else if (u.kind === 'image') this._setImage(obj, u.image)
    }
  }

  _setImage (obj, bytes) {
    obj.imageBytes = bytes
    if (obj.bitmap) { obj.bitmap.close(); obj.bitmap = null }
    if (!bytes || typeof createImageBitmap !== 'function') return
    const gen = this.generation
    // An animated GIF decodes to its first frame here. Spec 7.2 allows
    // animation, but a still is the honest thing to show against a single frame.
    createImageBitmap(new Blob([bytes]))
      .then((bmp) => {
        if (gen !== this.generation || this.objects.get(obj.index) !== obj) { bmp.close(); return }
        if (obj.bitmap) obj.bitmap.close()
        obj.bitmap = bmp
      })
      .catch(() => { /* an image format this browser will not decode */ })
  }

  /** Objects whose draw conditions the given frame satisfies (spec 2.3 / 7.1). */
  visibleObjects (stateBits, dioInputs) {
    const out = []
    for (const obj of this.objects.values()) {
      const def = obj.def
      if (def) {
        if (def.stateflags && (stateBits & def.stateflags) !== def.stateflags) continue
        if (def.dio && !(dioInputs & def.dio)) continue
      }
      out.push(obj)
    }
    return out.sort((a, b) => a.index - b.index)
  }

  close () {
    this.reset()
  }
}

/**
 * A plain, inert copy of the overlay state for the UI to render.
 *
 * The live state holds `ImageBitmap`s and is rewritten as the playhead moves;
 * neither belongs in a reactive store, and a framework proxying a decoded image
 * is a good way to leak one. Only what an inspector displays is copied out.
 */
export function snapshotOverlay (state) {
  const out = []
  if (!state) return out
  for (const obj of [...state.objects.values()].sort((a, b) => a.index - b.index)) {
    const def = obj.def
    out.push({
      index: obj.index,
      type: def ? def.type : -1,
      typeName: def ? def.typeName : 'undeclared',
      stateflags: def ? def.stateflags : 0,
      dio: def ? def.dio : 0,
      text: obj.text || '',
      shapes: (obj.shapes || []).map((s) => ({
        left: s.rect.left,
        top: s.rect.top,
        right: s.rect.right,
        bottom: s.rect.bottom,
        triggering: s.triggering,
        color: s.color,
        label: s.label
      })),
      imageBytes: obj.imageBytes ? obj.imageBytes.length : 0,
      rawBytes: obj.raw ? obj.raw.length : 0
    })
  }
  return out
}
