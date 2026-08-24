/**
 * The playback clock, in media milliseconds.
 *
 * The wall-clock source is pluggable: once an AudioContext exists we drive the
 * clock from `AudioContext.currentTime` so that audio scheduling and video
 * presentation share one timebase and cannot drift apart. Without audio we fall
 * back to performance.now().
 *
 * `hold` freezes media time without changing the user-visible play/pause state;
 * it is what the player uses while re-buffering after a seek.
 */
export const performanceWall = () => performance.now() / 1000

export class MediaClock {
  constructor () {
    this.rate = 1
    this.playing = false
    this.held = false
    this._media = 0
    this._anchor = 0
    this._wall = performanceWall
  }

  setWallSource (fn) {
    const t = this.currentTime
    this._wall = fn
    this._media = t
    this._anchor = this._wall()
  }

  get wallNow () { return this._wall() }

  get currentTime () {
    if (!this.playing || this.held) return this._media
    return this._media + (this._wall() - this._anchor) * 1000 * this.rate
  }

  set currentTime (ms) {
    this._media = ms
    this._anchor = this._wall()
  }

  /** Converts a media time into the wall-source timebase (seconds). */
  wallForMedia (ms) {
    if (!this.playing || this.held) return this._wall()
    return this._anchor + (ms - this._media) / (1000 * this.rate)
  }

  play () {
    if (this.playing) return
    this._anchor = this._wall()
    this.playing = true
  }

  pause () {
    if (!this.playing) return
    this._media = this.currentTime
    this.playing = false
  }

  setHeld (held) {
    if (held === this.held) return
    this._media = this.currentTime
    this._anchor = this._wall()
    this.held = held
  }
}
