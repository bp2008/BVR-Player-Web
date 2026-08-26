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

/**
 * The most pictures a decoder is allowed to hold before it has to hand one back.
 *
 * H.264 and H.265 both cap the decoded picture buffer at 16 frames, so 16 chunks
 * in with nothing out is the point past which the decoder is broken rather than
 * merely patient. See `_widenForReorder`, which is what this bounds.
 */
const MAX_REORDER = 16

// How much more input one detected stall buys.
const REORDER_STEP = 4

/**
 * How long the pipeline must look stuck before it is believed.
 *
 * A decoder dequeues a chunk before it delivers the picture that chunk produced,
 * so "queue empty, nothing back yet" is also what the ordinary moment just
 * before an output looks like -- and `ondequeue` fires often enough to catch
 * several of those. A real deadlock lasts for as long as the page is open, so
 * insisting it last a tenth of a second costs nothing and keeps the allowance
 * from growing on files that were only ever a frame away from producing one.
 */
const STALL_GRACE_MS = 150

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Owns the video decoders and a sliding window of decoded frames.
 *
 * The window spans [anchor - maxBehind, anchor + maxAhead]. Keeping a few frames
 * *behind* the current position is what makes single-frame stepping backwards
 * instant instead of requiring a fresh key-frame seek every time.
 *
 * Decoders, plural, because an `auto` sequence interleaves runs of two streams
 * that need not share a codec -- H.265 main and H.264 sub is an ordinary Blue
 * Iris pairing -- and a `VideoDecoder` is configured for one codec. One decoder
 * per source stream, chosen per frame from the sequence's `srcStream`, costs
 * nothing on the single-stream case (there is only ever one) and means a switch
 * between streams is no more than the next frame going to a different decoder.
 * Everything outside `_decoderFor` still speaks in indices into the sequence
 * being played, so the window, the anchor and the seek logic are unchanged.
 */
export class VideoPipeline {
  constructor ({ reader, onError, reorderHint = 0 }) {
    this.reader = reader
    this.onError = onError || (() => {})
    // What this stream's decoder wanted last time it was played, if anything
    // has played it before. Only ever a starting point -- it is re-learned from
    // scratch if it turns out to be too little.
    this.reorderHint = clamp(Math.round(reorderHint) || 0, 0, MAX_REORDER)

    this.pstream = null
    this.codecInfo = null
    this.kind = 'video'
    // Source stream id -> its decoder, and the ids whose decoder is configured
    // and has been given a key frame. Cleared together on every restart.
    this.decoders = new Map()
    this._ready = new Set()
    // The stream the feed is currently inside, so a changeover can be noticed.
    this._feedSource = -1
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
    // Chunks this stream's decoder has been shown to swallow before it hands
    // anything back. Input only -- see `_feedAhead`.
    this._reorder = this.reorderHint
    this._outIdx = -1
    this._stallMark = ''
    this._stallSince = 0
  }

  /**
   * Frame-window sizing scaled to resolution, so 4K clips do not eat GPU memory.
   *
   * A budget rather than a limit: `_keepTo` holds a few frames past this, and a
   * stream whose decoder demands a deep reorder allowance holds more again. A
   * recording that will not play is worse than one that is expensive to play,
   * and the two rarely collide -- the deepest reordering belongs to the smallest
   * pictures, where a frame costs almost nothing to keep.
   *
   * A merged sequence is sized from its *largest* picture and then left alone,
   * even while the smaller stream is playing and a roomier window would fit. The
   * window and the feed allowance are two ends of one invariant -- nothing is
   * fed that the window will not have room for when it comes back -- and
   * re-sizing mid-flight breaks it in both directions: shrink it and pictures
   * already inside the decoder are discarded on arrival, never to be decoded
   * again, since the feed has moved past them and only a restart goes back;
   * grow it and the frames of the larger stream that the feed then runs ahead
   * for are the expensive ones. A look-ahead of a handful of frames on the sub
   * stream is the price, and it is the price this pipeline has always paid on a
   * switching-mode recording.
   */
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
   * Which of the file's streams a frame of the sequence came from. A
   * single-stream sequence says so once rather than in an array per frame.
   */
  sourceOf (idx) {
    const s = this.pstream
    if (!s) return 0
    if (!s.srcStream) return s.codecSource
    return s.srcStream[clamp(idx, 0, s.count - 1)]
  }

  /** The codec configuration for the stream a frame came from. */
  _infoFor (idx) {
    const info = this.codecInfo
    if (!info) return null
    const by = info.bySource
    return (by && by[this.sourceOf(idx)]) || info
  }

  /** The decoder for one source stream, created on first use. */
  _decoderFor (si) {
    let dec = this.decoders.get(si)
    if (dec && dec.state !== 'closed') return dec
    dec = new VideoDecoder({
      output: (frame) => this._onOutput(frame),
      error: (e) => { this.onError(e) }
    })
    if ('ondequeue' in dec) dec.ondequeue = () => this.pump()
    this.decoders.set(si, dec)
    return dec
  }

  /** Chunks every decoder still owes a picture for. */
  _queued () {
    let n = 0
    for (const d of this.decoders.values()) {
      if (d.state === 'configured') n += d.decodeQueueSize
    }
    return n
  }

  /**
   * How far past the anchor chunks may be *fed*, as opposed to how many decoded
   * pictures are kept.
   *
   * These are two different quantities, and conflating them is what deadlocked
   * this pipeline. A decoder does not hand a picture back the moment it is fed
   * one: it fills its decoded picture buffer first so that it can emit in
   * display order, and Chrome's hardware H.264 path does that whatever
   * `optimizeForLatency` says. How many it swallows first is set by the stream's
   * level and picture size -- measured on one recording, its 3632x1632 level-5.1
   * main stream wants eight chunks in before the first picture comes out and its
   * 1200x536 sub stream wants seventeen. The software decoder wants two.
   *
   * The frame window, meanwhile, is sized from a memory budget, and a 5.9
   * megapixel picture earns a look-ahead of six. Six chunks in, nothing out, and
   * nothing more fed because the window is "full" of them: each side waits for
   * the other, nothing has failed so no error is raised, and the buffering chip
   * stays up for as long as the page is left open.
   *
   * The extra chunks sit inside the decoder rather than in `buf`, so this
   * allowance is paid in input and not in memory -- and the two demands trade
   * against each other anyway, because the picture buffer a decoder is entitled
   * to shrinks as the pictures grow. The deepest reordering belongs to the
   * smallest frames.
   */
  _feedAhead () {
    return this.maxAhead + this._reorder
  }

  /** The highest index worth keeping a picture for; see `_feedAhead`. */
  _keepTo () {
    // Outputs lag the feed by the reorder depth, so an allowance running ahead
    // of the slack here would decode pictures only to throw them away and then
    // want them again a frame later.
    return this.anchorIdx + this.maxAhead + Math.max(4, this._reorder)
  }

  /**
   * Grows the input allowance when the decoder is holding on to everything it
   * has been given.
   *
   * Predicting the depth from the bitstream means the level table, VUI parsing,
   * and trusting the decoder to agree with all of it. Detecting the stall and
   * feeding more until pictures appear needs none of that, and costs nothing at
   * all on a file that never stalls.
   */
  _widenForReorder () {
    if (this.kind !== 'video' || this.closed || !this.configured) return
    if (!this._ready.size) return
    if (this._reorder >= MAX_REORDER) return
    // There is more of the stream to feed, and the allowance is what stopped us.
    if (!this.pstream || this.feedIdx >= this.pstream.count) return
    if (this.feedIdx <= this.anchorIdx + this._feedAhead()) return
    // The decoder has taken every chunk and no picture is on its way back, so
    // nothing is going to change without more input.
    if (this._queued() > 0 || this._pendingCopies > 0) return
    // The test is whether the look-ahead has *filled*, not whether the frame
    // being waited on has turned up. A decoder that hands back frame N only once
    // frame N+17 has gone in keeps playback alive with no look-ahead at all --
    // every picture arrives exactly when it is needed, the buffering chip never
    // goes out, and one slow read is a visible stutter. That is a starved
    // pipeline too, and the cure is the same.
    if (this._outIdx >= this.anchorIdx + this.maxAhead) return
    // Nothing has moved for long enough that nothing is going to; see
    // STALL_GRACE_MS. Pictures still arriving count as movement, so a decoder
    // that is merely slow resets the clock rather than being fed more. The
    // player pumps this once an animation frame while it waits, so the second
    // reading is never far behind.
    const mark = `${this.epoch}:${this.feedIdx}:${this.anchorIdx}:${this._outIdx}`
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (this._stallMark !== mark) { this._stallMark = mark; this._stallSince = now; return }
    if (now - this._stallSince < STALL_GRACE_MS) return
    this._reorder = Math.min(MAX_REORDER, this._reorder + REORDER_STEP)
    this.pump()
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
    // Pictures kept, which is a memory question. What the decoder must be fed
    // in order to produce them is a separate one -- see `_feedAhead`.
    this.maxAhead = this.scrubbing ? SCRUB_AHEAD : this._playAhead
  }

  async open (pstream, codecInfo) {
    this.close()
    this.closed = false
    this.pstream = pstream
    this.codecInfo = codecInfo
    // A merged sequence is 'video' if any of its streams is; a decoder is only
    // ever asked for by the frames that need one.
    this.kind = this._codecs().some((c) => c.kind === 'video') ? 'video' : codecInfo.kind
    // Whatever the last stream's decoder needed says nothing about this one's,
    // so this starts from the hint for *this* stream and re-learns from there.
    this._reorder = this.reorderHint
    this._outIdx = -1
    this._stallMark = ''
    this.epoch++
    this.feedIdx = 0
    this.runStart = -1
    this.anchorIdx = 0
    this._sizeWindow()

    if (this.kind === 'video' && typeof VideoDecoder === 'undefined') {
      throw new Error('This browser does not support WebCodecs (VideoDecoder).')
    }
    // Every stream in the sequence is checked, not just the primary: an `auto`
    // sequence that cannot decode half its frames is not playable, and finding
    // that out here is a message rather than a stall.
    for (const codec of this._codecs()) {
      if (codec.kind !== 'video') continue
      const support = await VideoDecoder.isConfigSupported(codec.config)
      if (!support.supported) {
        throw new Error(
          'This browser cannot decode ' + codec.label +
          ' (codec string "' + codec.config.codec + '").'
        )
      }
    }
  }

  /** Every distinct codec configuration this sequence will need. */
  _codecs () {
    const info = this.codecInfo
    if (!info) return []
    if (!info.bySource) return [info]
    const out = []
    for (const si of (this.pstream.sources || [])) {
      if (info.bySource[si]) out.push(info.bySource[si])
    }
    return out.length ? out : [info]
  }

  close () {
    this.closed = true
    this._releaseBuffer()
    for (const dec of this.decoders.values()) {
      if (dec.state !== 'closed') {
        try { dec.close() } catch { /* already torn down */ }
      }
    }
    this.decoders.clear()
    this._ready.clear()
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

  /** What this stream's decoder turned out to want, for the next pipeline. */
  get reorder () { return this._reorder }

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

  /**
   * Abandons whatever was being decoded and prepares to feed from `k`.
   *
   * Every decoder is reset, not only the one the new position belongs to: the
   * others hold pictures from the run that has just been left, and a picture
   * that arrives after a seek is tagged with the old epoch and thrown away
   * anyway. Configuration is deferred to `_run`, which configures a decoder the
   * first time it is handed a key frame -- so a seek into a stretch of sub
   * stream never touches the main stream's decoder at all.
   */
  _restartAt (k) {
    this.epoch++
    this._releaseBuffer()
    for (const dec of this.decoders.values()) {
      if (dec.state === 'closed') continue
      try { dec.reset() } catch { /* nothing was queued */ }
    }
    this._ready.clear()
    this._feedSource = -1
    this.configured = true
    this.feedIdx = k
    this.runStart = k
    this._outIdx = -1
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
    if (!this.configured) this._restartAt(Math.max(0, s.keyIdx[this.anchorIdx]))

    while (!this.closed) {
      if (this.feedIdx >= s.count) break
      if (this.feedIdx > this.anchorIdx + this._feedAhead()) break
      // Bound the decoders' outstanding work: queued chunks plus pictures we
      // have not yet handed back must stay under the output pool size.
      if (this.kind === 'video') {
        if (this._queued() + this._pendingCopies >= 6) break
      } else if (this._inFlight >= 4) break

      const idx = this.feedIdx
      const si = this.sourceOf(idx)
      const info = this._infoFor(idx)
      const isKey = !!(s.flags[idx] & FLAG_ISKEY)

      // The feed has crossed into the other stream, so the one being left has to
      // be drained. A decoder holds pictures back until enough input has
      // followed them, and no more input for that stream is coming until the run
      // after next -- without this the last frames before every switch would
      // simply never be handed over, and the picture would stall for the length
      // of the decoder's reorder depth at each changeover. The pictures arrive
      // through the ordinary output path, so nothing here waits for them.
      if (si !== this._feedSource) {
        this._drain(this._feedSource)
        this._feedSource = si
      }

      // A stream is entered only on a key frame. After a restart in the middle
      // of one run, the frames of the *other* stream that follow belong to a run
      // that has not begun yet, and feeding a decoder a delta frame it has no
      // reference for produces either an error or a corrupt picture.
      if (info && info.kind === 'video' && !this._ready.has(si) && !isKey) {
        this.feedIdx = idx + 1
        continue
      }

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
      if (info && info.kind === 'video') {
        let dec
        try {
          dec = this._decoderFor(si)
          if (!this._ready.has(si)) {
            dec.configure(info.config)
            this._ready.add(si)
          }
          // EncodedVideoChunk copies its input, so a view into the read window is safe.
          dec.decode(new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: epoch * TS_SCALE + idx,
            data: bytes
          }))
        } catch (e) {
          this.onError(e)
          break
        }
      } else {
        this._decodeImage(bytes.slice(), idx, epoch, info)
      }
      this.feedIdx = idx + 1
    }
    this._maybeFlush()
    this._widenForReorder()
  }

  /**
   * Asks one stream's decoder to emit everything it is holding.
   *
   * `flush` empties the decoded picture buffer without discarding the decoder's
   * state, so feeding the same stream again afterwards -- which a seek back
   * across the switch will do -- carries on as if nothing had happened.
   */
  _drain (si) {
    if (si < 0 || !this._ready.has(si)) return
    const dec = this.decoders.get(si)
    if (!dec || dec.state !== 'configured') return
    dec.flush().catch(() => { /* superseded by a seek */ })
  }

  /**
   * Drains every decoder once the last chunk of the stream has been fed --
   * without this the final pictures stay inside the decoder and playback stops a
   * few frames short of the end.
   */
  _maybeFlush () {
    if (this.kind !== 'video' || !this.configured || this.closed) return
    if (!this.pstream || this.feedIdx < this.pstream.count) return
    if (this._flushEpoch === this.epoch) return
    if (!this._ready.size) return
    this._flushEpoch = this.epoch
    for (const si of this._ready) this._drain(si)
  }

  _decodeImage (bytes, idx, epoch, info) {
    this._inFlight++
    createImageBitmap(new Blob([bytes], { type: (info || this.codecInfo).mime }))
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
    // Recorded before the window has its say: a lead-in picture is thrown away
    // but it is still proof the decoder is producing, which is what
    // `_widenForReorder` needs to know.
    if (idx > this._outIdx) this._outIdx = idx
    if (idx < this.anchorIdx - this.maxBehind || idx > this._keepTo()) {
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
    if (idx < this.anchorIdx - this.maxBehind || idx > this._keepTo()) {
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
    const hi = this._keepTo()
    for (const [k, f] of this.buf) {
      if (k < lo || k > hi) { f.close(); this.buf.delete(k) }
    }
  }
}
