/**
 * Canvas presenter for decoded frames.
 *
 * Drawing goes through an explicit transform (fit -> zoom -> pan -> rotate ->
 * flip) rather than relying on the canvas intrinsic size. Digital zoom is
 * therefore a matter of writing `view` and re-drawing, and anything painted on
 * top of the video -- overlay boxes, overlay text -- can be given in frame
 * coordinates and inherit the same transform, so it stays registered with the
 * picture under rotation, flip and zoom alike.
 */

export const MIN_ZOOM = 1
export const MAX_ZOOM = 16

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export class Renderer {
  constructor (canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    this.rotation = 0
    this.flipH = false
    // Width/height the picture should be shown at, whatever shape the frames
    // arrive in; 0 means "as decoded". See setDisplayAspect.
    this.displayAspect = 0
    this.view = { zoom: 1, panX: 0, panY: 0 }
    this.lastFrame = null
    // Painted inside the frame transform, after the picture itself.
    this.overlayPainter = null
    this._cssW = 0
    this._cssH = 0
    this._geom = null
  }

  setOrientation (rotation, flipH) {
    this.rotation = ((rotation % 360) + 360) % 360
    this.flipH = !!flipH
  }

  setOverlayPainter (fn) {
    this.overlayPainter = fn || null
  }

  /**
   * Forces every frame to a given display aspect ratio, or 0 for none.
   *
   * Blue Iris records the resolution it asked each camera for, and the encoder
   * does not always oblige: a sub stream declared 640x480 arriving encoded
   * 704x480 is ordinary output, and in switching mode it arrives interleaved
   * with a main stream of yet another shape, so without this the picture is
   * stretched sideways and changes shape mid-playback. The header's declared
   * shape is the field of view the recording claims, so that is the shape
   * everything is shown in.
   */
  setDisplayAspect (aspect) {
    const a = Number(aspect)
    this.displayAspect = Number.isFinite(a) && a > 0 ? a : 0
  }

  /**
   * The whole-pixel size a picture of `sw` x `sh` ends up being drawn at.
   *
   * Public because the UI has to be able to say whether a stream is being
   * rescaled, and answering that anywhere but here would be a second copy of
   * the rule in _effective.
   */
  presentedSize (sw, sh) {
    if (!(sw > 0) || !(sh > 0)) return { width: 0, height: 0 }
    const { w, h } = this._effective(sw, sh)
    return { width: Math.round(w), height: Math.round(h) }
  }

  /**
   * The size a frame is drawn at: its own, unless a display aspect is in force
   * and the frame disagrees with it.
   *
   * The short axis is stretched rather than the long one cropped. Cropping would
   * discard picture the recording does contain, and a mismatched surveillance
   * sub stream is squeezed rather than cropped in the first place -- undoing the
   * squeeze is exactly what restores it.
   */
  _effective (sw, sh) {
    const target = this.displayAspect
    if (!target || !(sw > 0) || !(sh > 0)) return { w: sw, h: sh }
    const native = sw / sh
    // A percent of slack: encoders round to macroblocks, and re-shaping a
    // picture that is already the right shape only costs sharpness.
    if (Math.abs(native - target) <= target * 0.01) return { w: sw, h: sh }
    return native < target
      ? { w: sh * target, h: sh }
      : { w: sw, h: sw / target }
  }

  /** Matches the backing store to the element box; returns true when it changed. */
  resize () {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    this._cssW = rect.width
    this._cssH = rect.height
    if (w === this.canvas.width && h === this.canvas.height) return false
    this.canvas.width = w
    this.canvas.height = h
    // A narrower viewport can leave a pan that now shows past the frame edge.
    this.clampView()
    return true
  }

  clear () {
    const { ctx, canvas } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  /** Backing-store pixels per CSS pixel; pointer events arrive in CSS pixels. */
  get dpr () {
    if (this._cssW > 0) return this.canvas.width / this._cssW
    return Math.min(window.devicePixelRatio || 1, 2)
  }

  /**
   * The placement of the current picture: where it sits, how big it is drawn,
   * and the scale factor in force. Null until something has been drawn.
   */
  get geometry () { return this._geom }

  _measure (sw, sh) {
    const cw = this.canvas.width
    const ch = this.canvas.height
    const swap = this.rotation === 90 || this.rotation === 270
    const dispW = swap ? sh : sw
    const dispH = swap ? sw : sh
    const fit = Math.min(cw / dispW, ch / dispH)
    return { cw, ch, sw, sh, dispW, dispH, fit, scale: fit * this.view.zoom }
  }

  /**
   * Holds the pan inside the picture.
   *
   * The bound is how far the drawn image extends past the viewport, so at zoom 1
   * -- where the image is letterboxed rather than cropped -- it collapses to
   * zero and the picture is pinned centred. Above that, panning stops exactly
   * when an edge of the frame reaches the corresponding edge of the viewport,
   * which is the "visible region cannot leave the frame" rule.
   */
  clampView () {
    const v = this.view
    v.zoom = clamp(v.zoom || 1, MIN_ZOOM, MAX_ZOOM)
    const g = this._geom
    if (!g) { v.panX = 0; v.panY = 0; return }
    const drawnW = g.dispW * g.fit * v.zoom
    const drawnH = g.dispH * g.fit * v.zoom
    const maxX = Math.max(0, (drawnW - g.cw) / 2)
    const maxY = Math.max(0, (drawnH - g.ch) / 2)
    v.panX = clamp(v.panX, -maxX, maxX)
    v.panY = clamp(v.panY, -maxY, maxY)
  }

  /**
   * Zooms to `zoom` while holding the content under a CSS-pixel point still.
   *
   * The anchor is converted into the rotated display space first, so the same
   * arithmetic serves an upright picture and a rotated one.
   */
  zoomAt (zoom, cssX, cssY) {
    const g = this._geom
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
    if (!g) { this.view.zoom = next; this.clampView(); return }
    const dpr = this.dpr
    const px = cssX * dpr
    const py = cssY * dpr
    const before = g.fit * this.view.zoom
    const after = g.fit * next
    const dx = (px - (g.cw / 2 + this.view.panX)) / before
    const dy = (py - (g.ch / 2 + this.view.panY)) / before
    this.view.zoom = next
    this.view.panX = px - g.cw / 2 - dx * after
    this.view.panY = py - g.ch / 2 - dy * after
    this.clampView()
  }

  /** Moves the picture by a CSS-pixel delta. */
  panBy (cssDx, cssDy) {
    const dpr = this.dpr
    this.view.panX += cssDx * dpr
    this.view.panY += cssDy * dpr
    this.clampView()
  }

  resetView () {
    this.view.zoom = 1
    this.view.panX = 0
    this.view.panY = 0
    this.clampView()
  }

  get zoomed () { return this.view.zoom > MIN_ZOOM + 1e-6 }

  /** Draws a VideoFrame or ImageBitmap, letterboxed and oriented. */
  draw (frame) {
    if (!frame) return
    this.lastFrame = frame
    const { ctx } = this
    const fw = frame.displayWidth || frame.width || 0
    const fh = frame.displayHeight || frame.height || 0
    if (!fw || !fh) return

    // Everything downstream -- fit, zoom bounds, overlay coordinates -- works in
    // the shape the picture is shown at, not the shape it decoded to.
    const { w: sw, h: sh } = this._effective(fw, fh)
    const g = this._measure(sw, sh)
    this._geom = g
    this.clampView()
    const scale = g.fit * this.view.zoom

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, g.cw, g.ch)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    ctx.save()
    ctx.translate(g.cw / 2 + this.view.panX, g.ch / 2 + this.view.panY)
    ctx.scale(scale, scale)
    if (this.rotation) ctx.rotate((this.rotation * Math.PI) / 180)
    if (this.flipH) ctx.scale(-1, 1)
    ctx.drawImage(frame, -sw / 2, -sh / 2, sw, sh)

    if (this.overlayPainter) {
      // Hand the painter a frame-space origin: (0, 0) is the top-left of the
      // picture and one unit is one frame pixel, whatever the view is doing.
      ctx.translate(-sw / 2, -sh / 2)
      try {
        this.overlayPainter(ctx, {
          width: sw,
          height: sh,
          scale,
          rotation: this.rotation,
          flipH: this.flipH
        })
      } catch {
        // A painter that throws must not take the video down with it.
        this.overlayPainter = null
      }
    }
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /**
   * Renders a frame into a canvas of its own, for saving to disk.
   *
   * The whole picture, at the size it is presented in: aspect corrected,
   * rotated, flipped and overlaid exactly as on screen, but with none of the
   * things that belong to the viewport rather than to the picture -- no
   * letterbox bars, and no digital zoom crop, so a snapshot taken while zoomed
   * in still holds every pixel the recording has.
   *
   * Overlay line and glyph sizes are specified in device pixels, so they are
   * given the on-screen fit as their scale: what is saved then matches what was
   * being looked at, instead of hairlines on a 2688-pixel-wide still. The clamp
   * keeps a docked-down or enormous stage from carrying that too far.
   */
  snapshot (frame = this.lastFrame) {
    if (!frame) return null
    const fw = frame.displayWidth || frame.width || 0
    const fh = frame.displayHeight || frame.height || 0
    if (!fw || !fh) return null

    const { w: sw, h: sh } = this._effective(fw, fh)
    const swap = this.rotation === 90 || this.rotation === 270
    const outW = Math.max(1, Math.round(swap ? sh : sw))
    const outH = Math.max(1, Math.round(swap ? sw : sh))

    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return null
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, outW, outH)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    ctx.save()
    ctx.translate(outW / 2, outH / 2)
    if (this.rotation) ctx.rotate((this.rotation * Math.PI) / 180)
    if (this.flipH) ctx.scale(-1, 1)
    ctx.drawImage(frame, -sw / 2, -sh / 2, sw, sh)

    if (this.overlayPainter) {
      const fit = this._geom ? this._geom.fit : 1
      ctx.translate(-sw / 2, -sh / 2)
      try {
        this.overlayPainter(ctx, {
          width: sw,
          height: sh,
          scale: clamp(fit, 0.15, 2),
          rotation: this.rotation,
          flipH: this.flipH
        })
      } catch {
        // A still without its overlays is still worth saving.
      }
    }
    ctx.restore()
    return canvas
  }

  /** Re-draws the last presented frame, e.g. after a resize or a zoom change. */
  redraw () {
    if (!this.lastFrame) return
    try {
      this.draw(this.lastFrame)
    } catch {
      // The frame was recycled out from under us; the player will re-present.
      this.lastFrame = null
    }
  }

  forget () {
    this.lastFrame = null
    this._geom = null
  }
}
