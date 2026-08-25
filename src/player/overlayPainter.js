import {
  OBJ_GRAPHIC, OBJ_SHAPES, OBJ_TEXT, colorRefToCss, placeRect, rectScaleFor
} from '../bvr/metadata.js'

/**
 * Draws the overlay objects a BVR file carries onto the video surface.
 *
 * Everything here works in frame coordinates -- (0, 0) is the top-left of the
 * picture, one unit is one frame pixel -- because the Renderer has already put
 * the context into that space. Registration with the video is therefore exact
 * under rotation, flip and zoom without any of them being handled here.
 *
 * The one thing that must not simply inherit the transform is glyph rendering:
 * a rotated or mirrored recording would otherwise get rotated or mirrored text,
 * which is unreadable and helps nobody. Text is drawn through an anchor that
 * undoes the orientation and keeps only the scale.
 */

// Line and glyph sizes are specified in device pixels and divided by the
// current scale, so a box outline stays crisp whether the view is zoomed out to
// a thumbnail-sized stage or magnified 8x.
const BOX_LINE_PX = 2
const TRIGGER_LINE_PX = 3
const LABEL_PX = 13
const MIN_TEXT_PX = 11

// Blue Iris leaves the colour of motion and AI boxes at 0 (black), which would
// vanish against night video. Boxes therefore get the app's own palette unless
// the file names a colour of its own.
const BOX_COLOR = '#58a6ff'
const TRIGGER_COLOR = '#ffd166'

function cssColor (colorRef, fallback) {
  return colorRef ? colorRefToCss(colorRef) : fallback
}

/**
 * Positions a drawing origin so that glyphs come out upright.
 *
 * Undoing the flip and the rotation around the anchor leaves the caller in a
 * space whose axes point the way the viewer's do, still at video scale.
 */
function upright (ctx, geom, x, y) {
  ctx.translate(x, y)
  if (geom.flipH) ctx.scale(-1, 1)
  if (geom.rotation) ctx.rotate((-geom.rotation * Math.PI) / 180)
}

function drawTextBlock (ctx, geom, obj, box, px) {
  const def = obj.def
  const lines = String(obj.text || '').split('\n')
  if (!lines.length) return

  // The placement rectangle is the type designer's intent: fit the configured
  // number of lines into it, falling back to however many arrived.
  const rows = Math.max(1, def && def.nlines > 0 ? def.nlines : lines.length)
  const lineHeight = Math.max(box.h / rows, MIN_TEXT_PX / px)
  const size = lineHeight * 0.82
  const family = def && def.font ? `"${def.font}", ui-monospace, monospace` : 'ui-monospace, monospace'
  const weight = def && def.weight >= 600 ? '700' : '400'

  if (def && def.alpha > 0) {
    ctx.save()
    ctx.globalAlpha = Math.min(1, def.alpha / 100)
    ctx.fillStyle = colorRefToCss(def.bkcolor)
    ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.restore()
  }

  // align: 0 centre, -1 left, 1 right (spec 7.1).
  const align = def ? def.align : -1
  const anchorX = align === 0 ? box.x + box.w / 2 : align > 0 ? box.x + box.w : box.x
  const textAlign = align === 0 ? 'center' : align > 0 ? 'right' : 'left'

  ctx.save()
  upright(ctx, geom, anchorX, box.y)
  ctx.font = `${weight} ${size}px ${family}`
  ctx.textAlign = textAlign
  ctx.textBaseline = 'top'
  if (!def || def.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)'
    ctx.shadowBlur = 2 / px
    ctx.shadowOffsetX = 1 / px
    ctx.shadowOffsetY = 1 / px
  }
  ctx.fillStyle = cssColor(def ? def.color : 0, '#ffffff')
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 0, i * lineHeight)
  }
  ctx.restore()
}

function drawShapes (ctx, geom, obj, px) {
  const shapes = obj.shapes
  if (!shapes || !shapes.length) return
  const scale = rectScaleFor(shapes.map((s) => s.rect), geom.width, geom.height)

  for (const shape of shapes) {
    const box = placeRect(shape.rect, scale)
    const color = cssColor(shape.color, shape.triggering ? TRIGGER_COLOR : BOX_COLOR)
    ctx.save()
    ctx.lineWidth = (shape.triggering ? TRIGGER_LINE_PX : BOX_LINE_PX) / px
    ctx.strokeStyle = color
    // A dark halo under the outline keeps it readable over a bright sky just as
    // well as over shadow.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
    ctx.shadowBlur = 3 / px
    ctx.strokeRect(box.x, box.y, box.w, box.h)
    ctx.restore()

    if (!shape.label) continue
    const size = LABEL_PX / px
    ctx.save()
    upright(ctx, geom, box.x, box.y)
    ctx.font = `600 ${size}px system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    const pad = 3 / px
    const w = ctx.measureText(shape.label).width
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
    ctx.fillRect(-pad, -size - pad * 2, w + pad * 2, size + pad * 2)
    ctx.fillStyle = color
    ctx.fillText(shape.label, 0, -pad)
    ctx.restore()
  }
}

function drawGraphic (ctx, obj, box) {
  const bmp = obj.bitmap
  if (!bmp) return
  const def = obj.def
  let { x, y, w, h } = box
  if (def && def.constrain && bmp.width > 0 && bmp.height > 0) {
    const fit = Math.min(w / bmp.width, h / bmp.height)
    const fw = bmp.width * fit
    const fh = bmp.height * fit
    x += (w - fw) / 2
    y += (h - fh) / 2
    w = fw
    h = fh
  }
  ctx.save()
  if (def && def.alpha > 0 && def.alpha < 100) ctx.globalAlpha = def.alpha / 100
  ctx.drawImage(bmp, x, y, w, h)
  ctx.restore()
}

/**
 * Paints one overlay state. `stateBits` and `dio` come from the frame on screen
 * and decide which objects are eligible to draw at all (spec 2.2 / 7.1).
 */
export function paintOverlay (ctx, geom, { state, stateBits = 0, dio = 0, show = {} }) {
  if (!state) return
  const px = geom.scale || 1
  for (const obj of state.visibleObjects(stateBits, dio)) {
    const type = obj.def ? obj.def.type : -1
    if (type === OBJ_SHAPES) {
      if (show.shapes !== false) drawShapes(ctx, geom, obj, px)
      continue
    }
    if (!obj.def) continue
    const box = placeRect(obj.def.rect, rectScaleFor([obj.def.rect], geom.width, geom.height))
    if (type === OBJ_TEXT) {
      if (show.text !== false && obj.text) drawTextBlock(ctx, geom, obj, box, px)
    } else if (type === OBJ_GRAPHIC) {
      if (show.graphics !== false) drawGraphic(ctx, obj, box)
    }
  }
}
