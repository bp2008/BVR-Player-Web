import { MAX_ZOOM, MIN_ZOOM } from './Renderer.js'

/**
 * Pointer handling for digital zoom and pan.
 *
 * The whole feature is a matter of writing `renderer.view` and asking for a
 * re-draw, so this class owns nothing but gesture state. It drives the renderer
 * directly rather than routing through the player, because zooming has no
 * bearing on decoding, timing or transport -- the picture on screen is
 * re-presented from the frame that was already decoded.
 *
 * Gestures
 *   wheel / trackpad pinch  zoom about the pointer
 *   two-finger pinch        zoom about the midpoint, panning with it
 *   drag                    pan, once zoomed in
 *   double click / tap      reset, when zoomed
 *
 * A drag past a few pixels also suppresses the click that would otherwise
 * follow it, so panning never toggles playback on release.
 */

// Wheel notches vary wildly between mice, trackpads and browsers; normalising to
// a fraction of a zoom doubling per notch keeps all of them usable.
const WHEEL_RATE = 0.0022
const LINE_HEIGHT = 16
const PAGE_HEIGHT = 400

// Past this a press is a pan, not a click.
const DRAG_SLOP = 4

export class ViewController {
  constructor ({ element, renderer, onChange }) {
    this.element = element
    this.renderer = renderer
    this.onChange = onChange || (() => {})

    this.pointers = new Map()
    this.dragging = false
    this.moved = false
    this.suppressClick = false
    this._pinch = null

    this._onWheel = this._onWheel.bind(this)
    this._onDown = this._onDown.bind(this)
    this._onMove = this._onMove.bind(this)
    this._onUp = this._onUp.bind(this)
  }

  attach () {
    const el = this.element
    // Not passive: a wheel over the video zooms rather than scrolls the page.
    el.addEventListener('wheel', this._onWheel, { passive: false })
    el.addEventListener('pointerdown', this._onDown)
    el.addEventListener('pointermove', this._onMove)
    el.addEventListener('pointerup', this._onUp)
    el.addEventListener('pointercancel', this._onUp)
  }

  detach () {
    const el = this.element
    el.removeEventListener('wheel', this._onWheel)
    el.removeEventListener('pointerdown', this._onDown)
    el.removeEventListener('pointermove', this._onMove)
    el.removeEventListener('pointerup', this._onUp)
    el.removeEventListener('pointercancel', this._onUp)
    this.pointers.clear()
  }

  get zoom () { return this.renderer.view.zoom }
  get zoomed () { return this.renderer.zoomed }

  reset () {
    if (!this.renderer.zoomed) return false
    this.renderer.resetView()
    this._changed()
    return true
  }

  /** Zooms about the centre of the viewport; used by the keyboard and buttons. */
  nudge (factor) {
    const rect = this.element.getBoundingClientRect()
    this.renderer.zoomAt(this.renderer.view.zoom * factor, rect.width / 2, rect.height / 2)
    this._changed()
  }

  _changed () {
    this.onChange({ zoom: this.renderer.view.zoom, zoomed: this.renderer.zoomed })
  }

  _local (event) {
    const rect = this.element.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  _onWheel (event) {
    if (!this.renderer.geometry) return
    event.preventDefault()
    let dy = event.deltaY
    if (event.deltaMode === 1) dy *= LINE_HEIGHT
    else if (event.deltaMode === 2) dy *= PAGE_HEIGHT
    const factor = Math.exp(-dy * WHEEL_RATE)
    const next = this.renderer.view.zoom * factor
    // Nothing to do at either stop, and swallowing the event there would make
    // the page feel stuck.
    if ((next <= MIN_ZOOM && this.renderer.view.zoom <= MIN_ZOOM) ||
        (next >= MAX_ZOOM && this.renderer.view.zoom >= MAX_ZOOM)) return
    const p = this._local(event)
    this.renderer.zoomAt(next, p.x, p.y)
    this._changed()
  }

  _onDown (event) {
    if (event.button !== undefined && event.button !== 0) return
    if (!this.renderer.geometry) return
    const at = this._local(event)
    this.pointers.set(event.pointerId, at)
    this._downAt = at
    this.moved = false

    if (this.pointers.size === 2) {
      this._beginPinch()
      this.dragging = false
      return
    }
    if (this.pointers.size !== 1) return
    if (!this.renderer.zoomed) return
    // Only a zoomed picture can be panned; below that a press stays a click.
    this.dragging = true
    try { this.element.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
  }

  _beginPinch () {
    const [a, b] = [...this.pointers.values()]
    this._pinch = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      zoom: this.renderer.view.zoom
    }
  }

  _onMove (event) {
    if (!this.pointers.has(event.pointerId)) return
    const prev = this.pointers.get(event.pointerId)
    const p = this._local(event)
    this.pointers.set(event.pointerId, p)

    if (this.pointers.size >= 2) {
      this._pinchMove()
      return
    }
    if (!this.dragging) return
    // A press only becomes a pan once it has travelled far enough from where it
    // started; below that it is hand tremor on what is meant to be a click.
    if (!this.moved) {
      const from = this._downAt || prev
      if (Math.hypot(p.x - from.x, p.y - from.y) < DRAG_SLOP) return
      this.moved = true
    }
    this.renderer.panBy(p.x - prev.x, p.y - prev.y)
    this._changed()
  }

  _pinchMove () {
    const pinch = this._pinch
    if (!pinch) return
    const [a, b] = [...this.pointers.values()]
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    if (pinch.distance <= 0) return
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    this.moved = true

    // Zoom about the current midpoint, then carry the picture along with that
    // midpoint as the fingers travel -- the two together are what make a pinch
    // feel like it is holding the image rather than scaling a fixed point.
    this.renderer.zoomAt(pinch.zoom * (distance / pinch.distance), center.x, center.y)
    this.renderer.panBy(center.x - pinch.center.x, center.y - pinch.center.y)
    pinch.center = center
    this._changed()
  }

  _onUp (event) {
    this.pointers.delete(event.pointerId)
    try { this.element.releasePointerCapture(event.pointerId) } catch { /* never captured */ }
    if (this.pointers.size < 2) this._pinch = null

    if (this.pointers.size === 1) {
      // One finger lifted out of a pinch. Re-seat the survivor as the start of a
      // fresh drag so the picture does not jump on its next move, and keep the
      // gesture marked as moved -- lifting out of a pinch is never a click.
      this._downAt = [...this.pointers.values()][0]
      this.dragging = this.renderer.zoomed
      this.moved = true
      return
    }
    if (this.pointers.size > 1) return

    // A pan or a pinch must not also register as the click that toggles play.
    if (this.moved) this.suppressClick = true
    this.dragging = false
    this.moved = false
  }

  /** Reads and clears the "the last press was a drag" latch. */
  takeClickSuppression () {
    const was = this.suppressClick
    this.suppressClick = false
    return was
  }
}
