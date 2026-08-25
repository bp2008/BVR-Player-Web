import { FLAG_ISKEY } from '../bvr/constants.js'

// Chunk timestamps are used purely as identity tags: BVR timestamps may repeat
// within a stream (spec section 5), so the frame index is a safer key. The epoch
// multiplier lets outputs from a cancelled decode run be recognised and dropped.
const TS_SCALE = 1e9

/**
 * How far ahead of the frame being asked for the pipeline decodes while the
 * viewer is dragging the scrub bar.
 *
 * Far less than the playback window: a drag replaces its target several times a
 * second, so anything decoded past it is thrown away by the next restart, and
 * the reads it costs are reads the picture actually being waited on does not
 * get. Not zero, though -- a decoder is allowed to hold a picture back until
 * more input arrives, and a stream with any reorder depth at all would then
 * never produce the one frame we asked it for.
 */
const SCRUB_AHEAD = 4

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Owns the video decoder and a sliding window of decoded frames.
 *
 * The window spans [anchor - maxBehind, anchor + maxAhead]. Keeping a few frames
 * *behind* the current position is what makes single-frame stepping backwards
 * instant instead of requiring a fresh key-frame seek every time.
 */
export class VideoPipeline {
  constructor ({ reader, onError }) {
    this.reader = reader
    this.onError = onError || (() => {})

    this.pstream = null
    this.codecInfo = null
    this.kind = 'video'
    this.decoder = null
    this.configured = false
    this.closed = false

    this.buf = new Map()
    this.epoch = 1
    this.feedIdx = 0
    this.runStart = -1
    this.anchorIdx = 0
    this.maxAhead = 24
    this.maxBehind = 8
    this.scrubbing = false
    this._playAhead = 24

    this._pumping = false
    this._pumpQueued = false
    this._inFlight = 0
    this._pendingCopies = 0
    this._copyFrames = typeof createImageBitmap === 'function'
    this._flushEpoch = -1
  }

  /** Frame-window sizing scaled to resolution, so 4K clips do not eat GPU memory. */
  _sizeWindow () {
    const w = this.pstream.width || 1920
    const h = this.pstream.height || 1080
    const bytesPerFrame = w * h * 4 // ImageBitmap is RGBA-backed
    const budget = 192 * 1024 * 1024
    const total = clamp(Math.floor(budget / bytesPerFrame), 6, 24)
    this.maxBehind = clamp(Math.floor(total / 3), 2, 8)
    this._playAhead = total - this.maxBehind
    this._applyWindow()
  }

  /**
   * Enters or leaves scrub mode, which shortens the look-ahead only.
   *
   * The frames already decoded behind the anchor are left alone: they cost
   * nothing to keep, and they are what makes a drag that doubles back land on a
   * picture immediately.
   */
  setScrubbing (on) {
    on = !!on
    if (on === this.scrubbing) return
    this.scrubbing = on
    this._applyWindow()
    // Leaving scrub mode re-opens the window; refill it.
    if (!on) this.pump()
  }

  _applyWindow () {
    this.maxAhead = this.scrubbing ? SCRUB_AHEAD : this._playAhead
  }

  async open (pstream, codecInfo) {
    this.close()
    this.closed = false
    this.pstream = pstream
    this.codecInfo = codecInfo
    this.kind = codecInfo.kind
    this._sizeWindow()
    this.epoch++
    this.feedIdx = 0
    this.runStart = -1
    this.anchorIdx = 0

    if (this.kind === 'video') {
      if (typeof VideoDecoder === 'undefined') {
        throw new Error('This browser does not support WebCodecs (VideoDecoder).')
      }
      const support = await VideoDecoder.isConfigSupported(codecInfo.config)
      if (!support.supported) {
        throw new Error(
          'This browser cannot decode ' + codecInfo.label +
          ' (codec string "' + codecInfo.config.codec + '").'
        )
      }
      this.decoder = new VideoDecoder({
        output: (frame) => this._onOutput(frame),
        error: (e) => { this.onError(e) }
      })
      if ('ondequeue' in this.decoder) {
        this.decoder.ondequeue = () => this.pump()
      }
    }
  }

  close () {
    this.closed = true
    this._releaseBuffer()
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close() } catch { /* already torn down */ }
    }
    this.decoder = null
    this.configured = false
  }

  _releaseBuffer () {
    for (const f of this.buf.values()) f.close()
    this.buf.clear()
  }

  has (idx) { return this.buf.has(idx) }
  get (idx) { return this.buf.get(idx) || null }

  /** Highest buffered index at or below idx. */
  bestAtOrBefore (idx) {
    let best = -1
    for (const k of this.buf.keys()) {
      if (k <= idx && k > best) best = k
    }
    return best
  }

  get bufferedCount () { return this.buf.size }

  setAnchor (idx) {
    this.anchorIdx = idx
    this._trim()
    this.pump()
  }

  /** Nearest decodable index at or before idx (skips a leading non-key run). */
  decodableIndex (idx) {
    const s = this.pstream
    idx = clamp(idx, 0, s.count - 1)
    if (s.keyIdx[idx] >= 0) return idx
    return s.keys.length ? s.keys[0] : idx
  }

  /** Prepares the pipeline so that idx becomes available as soon as possible. */
  async seekTo (idx) {
    const s = this.pstream
    idx = this.decodableIndex(idx)
    this.anchorIdx = idx
    if (this.buf.has(idx)) { this._trim(); this.pump(); return idx }

    const k = Math.max(0, s.keyIdx[idx])
    // Continuing forward beats a decoder restart whenever we are already past
    // the key frame that idx depends on.
    const canContinue = this.kind !== 'video'
      ? this.feedIdx <= idx
      : this.configured && this.feedIdx <= idx && this.feedIdx > k
    if (!canContinue) this._restartAt(k)
    this._trim()
    this.pump()
    return idx
  }

  _restartAt (k) {
    this.epoch++
    this._releaseBuffer()
    if (this.kind === 'video' && this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.reset() } catch { /* nothing was queued */ }
      this.decoder.configure(this.codecInfo.config)
      this.configured = true
    }
    this.feedIdx = k
    this.runStart = k
  }

  pump () {
    if (this.closed) return
    if (this._pumping) { this._pumpQueued = true; return }
    this._pumping = true
    this._run().finally(() => {
      this._pumping = false
      if (this._pumpQueued) { this._pumpQueued = false; this.pump() }
    })
  }

  async _run () {
    const s = this.pstream
    if (!s || s.count === 0) return
    if (this.kind === 'video' && !this.configured) {
      this._restartAt(Math.max(0, s.keyIdx[this.anchorIdx]))
    }
    while (!this.closed) {
      if (this.feedIdx >= s.count) break
      if (this.feedIdx > this.anchorIdx + this.maxAhead) break
      if (this.kind === 'video') {
        if (!this.decoder || this.decoder.state !== 'configured') break
        // Bound the decoder's outstanding work: queued chunks plus pictures we
        // have not yet handed back must stay under its output pool size.
        if (this.decoder.decodeQueueSize + this._pendingCopies >= 6) break
      } else if (this._inFlight >= 4) break

      const idx = this.feedIdx
      const epoch = this.epoch
      const off = s.offset[idx]
      const len = s.size[idx]
      let view
      try {
        view = await this.reader.read(off, len)
      } catch (e) {
        this.onError(e)
        break
      }
      // A seek may have landed while the read was in flight.
      if (this.closed || epoch !== this.epoch || this.feedIdx !== idx) break

      const bytes = new Uint8Array(view.buffer, view.byteOffset, len)
      if (this.kind === 'video') {
        // EncodedVideoChunk copies its input, so a view into the read window is safe.
        const chunk = new EncodedVideoChunk({
          type: (s.flags[idx] & FLAG_ISKEY) ? 'key' : 'delta',
          timestamp: epoch * TS_SCALE + idx,
          data: bytes
        })
        try {
          this.decoder.decode(chunk)
        } catch (e) {
          this.onError(e)
          break
        }
      } else {
        this._decodeImage(bytes.slice(), idx, epoch)
      }
      this.feedIdx = idx + 1
    }
    this._maybeFlush()
  }

  /**
   * Drains the decoder once the last chunk of the stream has been fed -- without
   * this the final pictures stay inside the decoder and playback stops a few
   * frames short of the end.
   */
  _maybeFlush () {
    if (this.kind !== 'video' || !this.configured || this.closed) return
    if (!this.pstream || this.feedIdx < this.pstream.count) return
    if (this._flushEpoch === this.epoch) return
    if (!this.decoder || this.decoder.state !== 'configured') return
    this._flushEpoch = this.epoch
    this.decoder.flush().catch(() => { /* superseded by a seek */ })
  }

  _decodeImage (bytes, idx, epoch) {
    this._inFlight++
    createImageBitmap(new Blob([bytes], { type: this.codecInfo.mime }))
      .then((bmp) => {
        if (this.closed || epoch !== this.epoch) { bmp.close(); return }
        this._store(idx, bmp)
      })
      .catch((e) => { this.onError(e) })
      .finally(() => { this._inFlight--; this.pump() })
  }

  _onOutput (frame) {
    if (this.closed) { frame.close(); return }
    const epoch = Math.floor(frame.timestamp / TS_SCALE)
    if (epoch !== this.epoch) { frame.close(); return }
    const idx = frame.timestamp - epoch * TS_SCALE
    if (idx < this.anchorIdx - this.maxBehind || idx > this.anchorIdx + this.maxAhead + 4) {
      frame.close()
      return
    }
    if (!this._copyFrames) { this._store(idx, frame); return }

    // A hardware decoder owns a small, fixed pool of output pictures and stalls
    // outright once the application holds on to more than a handful of them
    // (empirically ~6). Copying each picture into an ImageBitmap hands the pool
    // slot straight back, which is what lets the frame window be sized for
    // playback smoothness rather than for the decoder's internal limits.
    this._pendingCopies++
    createImageBitmap(frame)
      .then((bmp) => {
        if (this.closed || epoch !== this.epoch) bmp.close()
        else this._store(idx, bmp)
        frame.close()
      })
      .catch(() => {
        // No copy path on this platform: keep the decoder frames themselves and
        // shrink the window so the pool is never exhausted.
        this._copyFrames = false
        this.maxAhead = Math.min(this.maxAhead, 3)
        this.maxBehind = Math.min(this.maxBehind, 1)
        if (this.closed || epoch !== this.epoch) frame.close()
        else this._store(idx, frame)
      })
      .finally(() => {
        this._pendingCopies--
        this.pump()
      })
  }

  _store (idx, frame) {
    if (idx < this.anchorIdx - this.maxBehind || idx > this.anchorIdx + this.maxAhead + 4) {
      // Key-frame lead-in, or output that arrived after the anchor moved on.
      frame.close()
      return
    }
    const prev = this.buf.get(idx)
    if (prev) prev.close()
    this.buf.set(idx, frame)
    this._trim()
  }

  _trim () {
    const lo = this.anchorIdx - this.maxBehind
    const hi = this.anchorIdx + this.maxAhead + 4
    for (const [k, f] of this.buf) {
      if (k < lo || k > hi) { f.close(); this.buf.delete(k) }
    }
  }
}
