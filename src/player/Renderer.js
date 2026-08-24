/**
 * Canvas presenter for decoded frames.
 *
 * Drawing goes through an explicit transform (fit -> zoom -> pan -> rotate ->
 * flip) rather than relying on the canvas intrinsic size, so the digital-zoom
 * feature planned for a later iteration only has to move `view`.
 */
export class Renderer {
  constructor (canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    this.rotation = 0
    this.flipH = false
    this.view = { zoom: 1, panX: 0, panY: 0 }
    this.lastFrame = null
    this._cssW = 0
    this._cssH = 0
  }

  setOrientation (rotation, flipH) {
    this.rotation = ((rotation % 360) + 360) % 360
    this.flipH = !!flipH
  }

  /** Matches the backing store to the element box; returns true when it changed. */
  resize () {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (w === this.canvas.width && h === this.canvas.height) return false
    this.canvas.width = w
    this.canvas.height = h
    this._cssW = rect.width
    this._cssH = rect.height
    return true
  }

  clear () {
    const { ctx, canvas } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  /** Draws a VideoFrame or ImageBitmap, letterboxed and oriented. */
  draw (frame) {
    if (!frame) return
    this.lastFrame = frame
    const { ctx, canvas } = this
    const sw = frame.displayWidth || frame.width || 0
    const sh = frame.displayHeight || frame.height || 0
    if (!sw || !sh) return

    const cw = canvas.width
    const ch = canvas.height
    const swap = this.rotation === 90 || this.rotation === 270
    const dispW = swap ? sh : sw
    const dispH = swap ? sw : sh
    const fit = Math.min(cw / dispW, ch / dispH)
    const scale = fit * this.view.zoom

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, cw, ch)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    ctx.translate(cw / 2 + this.view.panX, ch / 2 + this.view.panY)
    ctx.scale(scale, scale)
    if (this.rotation) ctx.rotate((this.rotation * Math.PI) / 180)
    if (this.flipH) ctx.scale(-1, 1)
    ctx.drawImage(frame, -sw / 2, -sh / 2, sw, sh)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** Re-draws the last presented frame, e.g. after a resize. */
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
  }
}
