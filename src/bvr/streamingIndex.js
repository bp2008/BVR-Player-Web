import { ScanReader } from './scanReader.js'
import { BlobReader } from './blobReader.js'
import { FrameTable, AudioTable } from './frameTable.js'
import { walkFrames, findFrameFrom } from './frameWalk.js'
import { readFrameHeader } from './parseFileHeader.js'
import { findLastFrame } from './tail.js'
import { firstUtcOf } from './indexer.js'
import { FLAG_MAINAVAILABLE, FLAG_MARK, STREAM_MAIN, STREAM_SUB } from './constants.js'

/**
 * A frame table for a recording that is too expensive to read all of.
 *
 * The full index (`indexer.js`) is the right answer whenever the bytes are
 * cheap: one pass, and every seek afterwards is exact. Over a network the pass
 * is the problem, because a BVR file is a chain whose links are its payloads --
 * the only way to learn where frame N+1 begins is to read frame N's header,
 * which sits on the far side of frame N's data. Indexing a stretch therefore
 * costs exactly the bytes of that stretch, and indexing all of it costs the
 * whole file. An hour of continuous recording is a gigabyte or more, and a
 * viewer who wants thirty seconds of it should not pay for the other fifty-nine
 * and a half minutes, or wait out the download before the first picture.
 *
 * So this indexes a *window*: one contiguous run of frames that covers where the
 * playhead is, grows forward as playback advances, and is thrown away and
 * rebuilt somewhere else when the viewer seeks somewhere far off. Spec 9.5
 * describes the same idea as the reference player's interpolate-and-search, and
 * two properties of the format are what make it work at all:
 *
 * - **The chain is self-synchronising.** A validated `BLUE` signature is enough
 *   to start reading frames from a byte offset nobody has ever visited, which is
 *   what `frameWalk.js`'s `findFrameFrom` does. The same hunt that recovers from
 *   corruption is what makes random access possible.
 * - **Time and bytes are close to proportional.** A camera writing at a roughly
 *   constant bitrate means a linear estimate lands within a second or two of the
 *   target, and every stretch that does get indexed contributes anchors that
 *   make the next estimate better.
 *
 * What the window costs, honestly:
 *
 * - The seek bar's duration and end time come from the last frame (spec 9.3),
 *   which is two short reads, so the timeline is whole from the first moment.
 * - Marks and segment ticks are only known where the file has been read, so they
 *   appear as the viewer travels rather than all at once.
 * - `auto` stream switching is not offered. Choosing between two streams is a
 *   judgement about stretches of time (`coverage.js`), and a plan recomputed
 *   over a growing window would revise decisions the decoder has already acted
 *   on -- the run boundaries would move under the playhead. One stream at a
 *   time is the honest option, and the picker says so.
 *
 * The one invariant the player leans on: while the window only grows, a frame's
 * index never changes. Growth is therefore something the pipelines absorb;
 * re-anchoring is what they rebuild for.
 */

// How much media to have in hand before playback starts, and how far ahead of
// the playhead to stay once it is running.
//
// Both are bounded twice over, in time and in bytes, and the byte bound is the
// one that usually bites. "Six seconds of video" is a quarter of a megabyte on a
// sub stream and seventeen megabytes on a 4K main stream recorded at ten
// megabits, and a viewer opening a clip should wait about as long either way. So
// whichever budget runs out first ends the read: time keeps a low-bitrate
// recording from stopping absurdly short, bytes keep a high-bitrate one from
// spending a viewer's data allowance before the first picture.
const OPEN_AHEAD_MS = 2500
const OPEN_AHEAD_BYTES = 2 << 20
const FOLLOW_AHEAD_MS = 12000
const FOLLOW_AHEAD_BYTES = 12 << 20

// The most a seek will ever step back looking for a key frame. The working
// figure is measured from the recording itself -- see `_seekBackoff` -- and this
// only bounds what a pathological measurement can ask for.
const MAX_BACKOFF_MS = 90000

// A seek this far beyond the window is cheaper to re-anchor than to read up to.
// Below it, reading forward keeps everything in between -- which is what makes
// a nudge of the scrub bar feel like a local file.
const REANCHOR_AHEAD_MS = 45000

// The most one extension reads before returning to the event loop. Bounded so a
// progress bar keeps moving and a seek issued mid-extension is noticed promptly.
const EXTEND_BYTES = 2 << 20

// The furthest a re-anchor will read forward to reach its target before giving
// up and estimating again. Without a ceiling, one bad estimate becomes a march
// to the end of the recording -- which is the whole cost this file exists to
// avoid.
const REACH_BYTES = 24 << 20

// Bounds on the seek search. Each probe is one frame header, but finding it
// costs a hunt through `PROBE_WINDOW` bytes, so the count is what to keep small.
const LOCATE_PROBES = 8
const LOCATE_TOLERANCE_MS = 1500
const PROBE_WINDOW = 256 << 10

// Bytes outstanding at the reader while the window grows. Four requests deep is
// what hides a round trip on a link with real latency; the chunk is small enough
// that the first of them lands quickly.
const SCAN_CHUNK = 512 << 10
const SCAN_DEPTH = 4

/**
 * Byte offset to media time, and back.
 *
 * Seeded from the recording's two ends and refined by every stretch that gets
 * read, so a session's estimates sharpen as it goes. Anchors are kept sorted by
 * offset and interpolated between the pair that brackets the query, which
 * handles a variable-bitrate recording far better than one global slope: a
 * quiet hour and a busy one each get their own.
 */
class TimeMap {
  constructor () {
    this.anchors = []
  }

  add (offset, ms) {
    if (!Number.isFinite(offset) || !Number.isFinite(ms)) return
    const list = this.anchors
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].offset < offset) lo = mid + 1
      else hi = mid
    }
    if (list[lo] && list[lo].offset === offset) { list[lo].ms = ms; return }
    list.splice(lo, 0, { offset, ms })
    // Thinning keeps the search cheap without losing the shape of the curve;
    // the ends are what the extrapolation depends on, so they are never dropped.
    if (list.length > 512) {
      const kept = [list[0]]
      for (let i = 1; i < list.length - 1; i += 2) kept.push(list[i])
      kept.push(list[list.length - 1])
      this.anchors = kept
    }
  }

  /** The byte offset media time `ms` is estimated to live at. */
  byteAt (ms) {
    const list = this.anchors
    if (!list.length) return 0
    if (list.length === 1) return list[0].offset
    let lo = 0
    let hi = list.length - 1
    if (ms <= list[0].ms) { lo = 0; hi = 1 } else if (ms >= list[hi].ms) { lo = hi - 1 } else {
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (list[mid].ms <= ms) lo = mid
        else hi = mid
      }
    }
    const a = list[lo]
    const b = list[lo + 1] || list[lo]
    const span = b.ms - a.ms
    if (!(span > 0)) return a.offset
    const t = (ms - a.ms) / span
    return a.offset + t * (b.offset - a.offset)
  }
}

export class StreamingIndex {
  constructor (reader, header, { onChange = null } = {}) {
    this.reader = reader
    this.header = header
    this.onChange = onChange || (() => {})
    this.fileSize = reader.size

    this._tables = [new FrameTable(), new FrameTable()]
    this._audio = new AudioTable()
    this._map = new TimeMap()
    this._scan = null

    // Seek probes get their own reader with a small window. They are scattered
    // by nature -- that is what a search is -- so they would evict the window
    // the walk is reading through, and each would drag in a megabyte to look at
    // thirty-two bytes. One block per probe is the whole difference between a
    // seek costing a few megabytes and costing tens of them.
    this._probe = new BlobReader(reader.blob, PROBE_WINDOW)
    this._pos = 0
    this._closed = false
    this._working = false
    this._want = null
    this._wantAhead = FOLLOW_AHEAD_MS
    this._wantBytes = FOLLOW_AHEAD_BYTES
    this._error = null

    // Records from the front of the file, kept whatever the window does. Spec
    // 7.1 puts the object definitions in frame 1, and without them every later
    // update record is uninterpretable -- so the front is read once on open and
    // its records are never dropped.
    this._frontMetadata = []

    // The shape `indexer.js` produces, so nothing above this reads differently.
    this.container = 'bvr'
    this.streaming = true
    this.streams = [this._tables[0].view(), this._tables[1].view()]
    this.audio = this._audio.view()
    this.metadata = []
    this.marks = []
    this.totalFrames = 0
    this.baseTs = 0
    this.durationMs = 0
    this.startUtc = 0
    this.endUtc = 0
    this.truncated = false
    this.resyncs = 0
    this.switchingMode = !!header.switchingMode

    // Where the window is, in bytes and in media time.
    this.coveredFrom = 0
    this.coveredTo = 0
    this.coveredFromMs = 0
    this.coveredToMs = 0

    // Two different facts, and conflating them is worth naming. `atEof` says the
    // walk has reached the end of the file and there is nothing further to read
    // *forward*; `complete` says the window began at the first frame as well, so
    // it describes the whole recording. Only the second means "stop indexing" --
    // a window that opened half way in and ran to the end still knows nothing
    // about the first half, and a viewer seeking back there must still be able
    // to re-anchor. Treating the first as the second left the player refusing to
    // play anything before wherever the window happened to have started, with
    // the buffering chip up for good.
    this.atEof = false
    this.complete = false
    this.generation = 0

    // Which streams the session has seen frames of *anywhere*, and whether the
    // recording is known to carry a main stream at all.
    //
    // The window's own tables answer neither. A motion-triggered main stream
    // exists in a handful of islands, and a window sitting between two of them
    // holds none of it -- so a picker built from the window alone tells the
    // viewer the recording has no main stream, which is not what the file says.
    // Spec 5.3's MAINAVAILABLE flag rides on the sub-stream frames themselves,
    // so even a walk through sub-only bytes reports that the main stream is
    // there.
    this.everSeen = [false, false]
    this.mainAvailable = false

    // Diagnostics: how much of the file the walk has actually parsed, and how
    // many seek probes it took to get there.
    this.walkedBytes = 0
    this.probeCount = 0
  }

  /**
   * Reads the two ends of the recording and the stretch playback will start
   * from.
   *
   * The last frame settles the duration (spec 9.3) in one short read from the
   * back, which is what lets the scrub bar describe the whole recording before
   * any of the middle has been seen. `startMs` is where playback is about to
   * begin -- a hand-off from UI3 carries a position, and opening straight into
   * the middle of an hour should not read the first fifty-nine minutes to get
   * there.
   */
  async open ({ startMs = 0, onProgress = null } = {}) {
    const last = await findLastFrame(this.reader, this.header)

    // The front is always read, however far in playback begins: it is where the
    // recording's time origin, the first key frame of each stream and the
    // overlay definitions all live.
    this._wantAhead = OPEN_AHEAD_MS
    this._wantBytes = OPEN_AHEAD_BYTES
    await this._anchorAt(this.header.firstFrameOffset, OPEN_AHEAD_MS, { front: true })
    this._frontMetadata = this.metadata.slice()

    const firstTs = this._firstTimestamp()
    if (firstTs) {
      // Everything walked so far was stamped with the file's own clock; the rest
      // of the app counts from the recording's start.
      this._tables[0].rebase(firstTs)
      this._tables[1].rebase(firstTs)
      this._audio.rebase(firstTs)
      this.coveredFromMs -= firstTs
      this.coveredToMs -= firstTs
      this.baseTs = firstTs
    }

    this._gopMs = this._measureGop()
    this.startUtc = this._firstUtc()
    if (last) {
      this.durationMs = Math.max(0, last.ts - this.baseTs)
      this.endUtc = last.utc || 0
      this._map.add(last.offset, this.durationMs)
    } else {
      this.durationMs = this.coveredToMs
      this.endUtc = this._lastUtc()
    }

    // Spec 4.3: a file may carry only the sub stream even without the flag.
    if (!this.everSeen[STREAM_MAIN] && this.everSeen[STREAM_SUB] && !this.header.bmih[1]) {
      this.header.bmih[1] = this.header.bmih[0]
      this.header.hasSubHeader = true
    }

    this._publish(false)
    if (startMs > 0) await this.ensure(startMs, OPEN_AHEAD_MS)
    if (onProgress) onProgress(1)
    return this
  }

  // --------------------------------------------------------------- driving it

  /**
   * Asks, without waiting, for the window to cover `ms` and a little beyond.
   *
   * Called from the player's animation loop, so it has to be cheap and safe to
   * call at sixty hertz: it records the position wanted and returns, and the
   * single worker already running picks up the new target at its next step.
   */
  follow (ms, ahead = FOLLOW_AHEAD_MS, bytes = FOLLOW_AHEAD_BYTES) {
    // `complete`, not `atEof`: a window that has run to the end of the file may
    // still begin after the moment being asked for, and reaching that moment
    // means starting again further back.
    if (this._closed || this.complete) return
    this._want = ms
    this._wantAhead = ahead
    this._wantBytes = bytes
    if (!this._working) this._pump()
  }

  /**
   * The awaitable form, for a seek that must not be acted on until it lands.
   *
   * The worker may already be running towards an older target, and the promise
   * it is holding can settle before the new one is reached -- so this drives it
   * until the window actually covers what was asked for, and gives up only when
   * a turn of the loop achieves nothing.
   */
  async ensure (ms, ahead = OPEN_AHEAD_MS, bytes = OPEN_AHEAD_BYTES) {
    this._want = ms
    this._wantAhead = ahead
    this._wantBytes = bytes
    for (let guard = 0; guard < 64; guard++) {
      if (this._closed || this.holds(ms)) break
      const at = this.coveredToMs
      const gen = this.generation
      await this._pump()
      if (this._error) { const e = this._error; this._error = null; throw e }
      if (this.coveredToMs === at && this.generation === gen) break
    }
  }

  /**
   * Whether reading further would serve the current target.
   *
   * Two budgets, and the tighter of them wins -- see the constants above. The
   * byte budget is measured from where the playhead actually sits rather than
   * from the start of the window, so a viewer who has been watching for a while
   * is not held back by everything already read behind them.
   */
  _satisfied (ms) {
    // Coverage first, and only then the question of reading further: a window
    // that has reached the end of the file is as unsatisfied as any other about
    // a moment lying before where it starts.
    if (!this.holds(ms)) return false
    if (this.atEof) return true
    if (this.coveredToMs >= Math.min(this.durationMs, ms + this._wantAhead)) return true
    return this._pos - this._byteAt(ms) >= this._wantBytes
  }

  /** Where `ms` sits in the file: exactly if the window knows, else estimated. */
  _byteAt (ms) {
    for (const t of this._tables) {
      if (!t.count || ms < t.ts[0] || ms > t.ts[t.count - 1]) continue
      let lo = 0
      let hi = t.count - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (t.ts[mid] <= ms) lo = mid
        else hi = mid - 1
      }
      return t.offset[lo]
    }
    return this._map.byteAt(ms)
  }

  /** Whether the window holds `ms` at all, ignoring how much lies beyond it. */
  holds (ms) {
    if (ms < this.coveredFromMs) return false
    return this.atEof || ms <= this.coveredToMs
  }

  async _pump () {
    if (this._working) return this._pending
    this._working = true
    this._pending = (async () => {
      try {
        // Re-anchoring is bounded per turn of the worker. A stretch holding no
        // video frames at all -- the tail of a recording that ended mid-audio,
        // say -- would otherwise be hunted for over and over, since the test
        // that asks for a re-anchor is still true after one. Two attempts, then
        // this turn gives up and `ensure` notices that nothing moved.
        let anchors = 0
        while (!this._closed) {
          const ms = this._want
          if (ms == null) break
          if (this._needsAnchor(ms)) {
            if (anchors >= 2) break
            anchors++
            await this._reanchor(ms)
            this._publish(true)
            continue
          }
          if (this._satisfied(ms)) break
          const grew = await this._extend()
          if (grew) this._publish(false)
          if (!grew) break
        }
      } catch (e) {
        this._error = e
      } finally {
        this._working = false
        this._pending = null
      }
    })()
    return this._pending
  }

  /**
   * Whether `ms` is better reached by starting again somewhere else.
   *
   * Behind the window there is no choice: the chain cannot be walked backwards,
   * so anything earlier than what has been read means re-anchoring. Ahead of it
   * the question is only whether reading the gap is cheaper than a fresh hunt,
   * and up to `REANCHOR_AHEAD_MS` it is -- with the bonus that everything
   * skipped over stays indexed.
   */
  _needsAnchor (ms) {
    if (this._tables[0].count === 0 && this._tables[1].count === 0) return true
    if (ms < this.coveredFromMs) return true
    return ms > this.coveredToMs + REANCHOR_AHEAD_MS && !this.atEof
  }

  // ------------------------------------------------------------------ walking

  _sink () {
    const tables = this._tables
    const audio = this._audio
    const metadata = this.metadata
    const marks = this.marks
    return {
      video: (si, payloadPos, datasize, timestamp, utc, flags, dio, stateBits) => {
        const t = tables[si]
        t.push(payloadPos, datasize, timestamp - this.baseTs, utc, flags, dio, stateBits)
        if (flags & FLAG_MARK) marks.push({ stream: si, idx: t.count - 1, ts: timestamp, utc })
        // Kept across re-anchors, unlike the tables themselves: what the file
        // contains does not stop being true when the window moves off it.
        this.everSeen[si] = true
        if (si === STREAM_MAIN || (flags & FLAG_MAINAVAILABLE)) this.mainAvailable = true
      },
      audio: (payloadPos, datasize, timestamp) => {
        audio.push(payloadPos, datasize, timestamp - this.baseTs)
      },
      metadata: (payloadPos, datasize, subtype, timestamp, utc) => {
        metadata.push({ offset: payloadPos, size: datasize, subtype, ts: timestamp, utc })
      }
    }
  }

  /** Reads forward from where the window ends, for a bounded number of bytes. */
  async _extend () {
    if (this.atEof || this._pos >= this.fileSize) { this._noteEof(); return false }
    const before = this._pos
    const stopAt = Math.min(this.fileSize, this._pos + EXTEND_BYTES)

    // Speculation runs past what this step will parse, so the next step's bytes
    // are already on their way while this one is being walked.
    if (this.reader.blob && this.reader.blob.prefetch) {
      this.reader.blob.prefetch(stopAt, EXTEND_BYTES)
    }

    const walked = await walkFrames(this._scan, {
      from: this._pos,
      to: stopAt,
      fileSize: this.fileSize,
      reader: this.reader,
      sink: this._sink()
    })
    this.walkedBytes += walked.pos - before
    this._pos = walked.pos
    this.resyncs += walked.resyncs
    this.totalFrames += walked.frames
    if (walked.truncated) this.truncated = true
    if (walked.truncated || this._pos >= this.fileSize) this._noteEof()
    if (this._pos === before) { this._noteEof(); return false }

    this._noteCoverage()
    return walked.frames > 0
  }

  /**
   * The time at one byte offset, for the cost of finding a frame there.
   *
   * The whole seek strategy rests on being able to ask "what moment lives at
   * this offset?" without committing to reading anything, so this reads exactly
   * one frame header and files the answer with the time map. Any frame will do:
   * audio, video and metadata all share the recording's timebase (spec 8), so
   * the first signature found is as good as the next.
   */
  async _probeAt (offset) {
    this.probeCount++
    const at = await findFrameFrom(this._probe, this.fileSize, offset, PROBE_WINDOW)
    if (at < 0) return null
    const view = await this._probe.read(at, Math.min(32, this.fileSize - at))
    const hdr = readFrameHeader(view, 0)
    if (!hdr) return null
    const ms = hdr.timestamp - this.baseTs
    this._map.add(at, ms)
    return { offset: at, ms }
  }

  /**
   * The byte offset to start reading at to reach `targetMs`.
   *
   * A single linear estimate is not good enough, and the reason is worth
   * spelling out: the arrangement Blue Iris users most often have -- a sub
   * stream running continuously and a main stream written only while something
   * moves -- produces a file whose bytes-per-second varies by an order of
   * magnitude along its length. On one hour-long sample here, interpolating
   * between the two ends put the half-way mark six minutes away from where it
   * really was.
   *
   * So this is an interpolation search bracketed by two known points, exactly as
   * spec 9.5 describes, and each probe both narrows the bracket and leaves a
   * permanent anchor behind -- which is why the second seek into a recording is
   * cheaper than the first, and the tenth is nearly free.
   */
  async _locate (targetMs) {
    if (targetMs <= 0) return this.header.firstFrameOffset
    let lo = { offset: this.header.firstFrameOffset, ms: 0 }
    let hi = { offset: this.fileSize, ms: this.durationMs }
    // Signed distances from the target, in the sign convention of a root find:
    // negative below it, positive above.
    let fLo = lo.ms - targetMs
    let fHi = hi.ms - targetMs
    let side = 0
    let best = lo
    let first = true

    for (let i = 0; i < LOCATE_PROBES && hi.offset - lo.offset > PROBE_WINDOW; i++) {
      // The first guess comes from every anchor the session has accumulated,
      // which on a recording already visited is often the answer outright.
      // After that the bracket is what to trust: anchors outside it describe a
      // part of the file this search has already ruled out.
      let guess = first ? this._map.byteAt(targetMs) : NaN
      first = false
      if (!(guess > lo.offset && guess < hi.offset)) {
        guess = fHi === fLo
          ? (lo.offset + hi.offset) / 2
          : (lo.offset * fHi - hi.offset * fLo) / (fHi - fLo)
      }
      const edge = (hi.offset - lo.offset) / 64
      guess = Math.floor(clamp(guess, lo.offset + edge, hi.offset - edge))

      const p = await this._probeAt(guess)
      if (!p || p.offset <= lo.offset || p.offset >= hi.offset) break

      const f = p.ms - targetMs
      if (Math.abs(f) < Math.abs(best.ms - targetMs)) best = p
      if (Math.abs(f) <= LOCATE_TOLERANCE_MS) { best = p; break }

      // The Illinois twist, and the reason it is here rather than plain false
      // position: on a file whose bitrate is lopsided -- a sub stream running
      // the whole hour beside a main stream that only records on motion -- the
      // straight interpolation converges from one side and leaves the other end
      // of the bracket where it started. The half-way mark then never moves and
      // the search burns its whole budget having learned almost nothing. Halving
      // the retained end's weight after a repeat pulls it in and restores the
      // guarantee that both ends close on the answer.
      if (f < 0) {
        lo = p
        fLo = f
        if (side === -1) fHi /= 2
        side = -1
      } else {
        hi = p
        fHi = f
        if (side === 1) fLo /= 2
        side = 1
      }
    }

    // Overshooting the target is allowed here -- the caller has already stepped
    // back by a key-frame interval, and landing a little late inside that margin
    // still leaves the frame the viewer asked for ahead of where reading starts.
    // Landing early is only wasted bytes, so the closer of the two wins.
    return Math.max(this.header.firstFrameOffset, best.offset)
  }

  /**
   * How far before a seek target to begin reading.
   *
   * Decoding can only start at a key frame, so the window has to open on one
   * before the target -- and how far back that is depends on the recording, not
   * on a constant. A camera writing a key frame every second and one writing
   * every eight want very different answers, and guessing high is not free: on a
   * main stream at ten megabits, every second of back-off is another megabyte
   * over the wire. So it is measured from the key frames the opening read
   * already turned up.
   */
  _seekBackoff () {
    return clamp((this._gopMs || 1000) * 2.5, 2500, MAX_BACKOFF_MS / 2)
  }

  /**
   * Throws the window away and rebuilds it around `ms`.
   *
   * Reading begins a little before the target rather than at it, because a
   * picture cannot be decoded from anywhere but a key frame and the chain
   * cannot be walked backwards -- so the only way to have the key frame that
   * precedes the target is to have started before it.
   */
  async _reanchor (ms) {
    let backoff = this._seekBackoff()
    for (let attempt = 0; attempt < 3; attempt++) {
      const offset = await this._locate(Math.max(0, ms - backoff))
      await this._anchorAt(offset, backoff + this._wantAhead)
      if (this.atEof && !this._tables[0].count && !this._tables[1].count) return
      // Landing after the target means the estimate ran long even with the
      // probes; the map is better for having tried, so step further back.
      if (this.coveredFromMs <= ms) break
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 4)
    }

    // Walk on until the target itself is in hand. Bounded, because a wrong
    // estimate must cost a bounded read and another anchor rather than an
    // unbounded march to the end of the recording -- and if the landing was so
    // far short that walking would be the expensive way there, it is better to
    // leave the window where it is and let the worker estimate again.
    if (ms - this.coveredToMs > REANCHOR_AHEAD_MS) return
    const from = this._pos
    while (!this.atEof && this.coveredToMs < ms && this._pos - from < REACH_BYTES) {
      if (!(await this._extend())) break
    }
  }

  /**
   * Starts a window at the first whole frame at or after `estimate`.
   *
   * The offset is a guess from the clock, so it is almost never a frame
   * boundary; `findFrameFrom` turns it into one by hunting for a signature whose
   * frame is complete and is itself followed by another -- the same validation
   * the corruption path uses, because the situations are the same shape.
   */
  async _anchorAt (estimate, ahead, { front = false, capped = true } = {}) {
    this._tables[0].reset()
    this._tables[1].reset()
    this._audio.reset()
    this.metadata = front ? [] : this._frontMetadata.slice()
    this.marks = []
    this.totalFrames = 0
    this.atEof = false
    this.complete = false
    if (this._scan) this._scan.release()
    this._scan = new ScanReader(this.reader.blob, { chunkSize: SCAN_CHUNK, depth: SCAN_DEPTH })

    const start = front
      ? this.header.firstFrameOffset
      : await findFrameFrom(this.reader, this.fileSize, estimate)
    if (start < 0) {
      // No frame chain from here to the end of the file. The window covers
      // nothing, and saying so before the flags are settled matters: `complete`
      // is read off `coveredFrom`, and left at the previous window's value this
      // would claim to describe a recording it has just failed to find.
      this.coveredFrom = this.fileSize
      this.coveredTo = this.fileSize
      this._noteEof()
      return
    }
    this._pos = start
    this.coveredFrom = start
    this.coveredTo = start
    this.generation++

    // Enough to know where in the recording this window begins, before the
    // caller is told anything about it.
    let guard = 0
    while (this._tables[0].count === 0 && this._tables[1].count === 0 && !this.atEof && guard++ < 64) {
      if (!(await this._extend())) break
    }
    this._noteCoverage()
    const budget = capped ? this._wantBytes : Infinity
    while (!this.atEof &&
           this.coveredToMs - this.coveredFromMs < ahead &&
           this._pos - this.coveredFrom < budget) {
      if (!(await this._extend())) break
    }
  }

  /** Recomputes where the window sits in time, and files anchors for later. */
  _noteCoverage () {
    const spans = []
    for (const t of this._tables) {
      if (t.count) spans.push([t.ts[0], t.ts[t.count - 1], t.offset[0], t.offset[t.count - 1]])
    }
    if (!spans.length) {
      this.coveredTo = this._pos
      return
    }
    this.coveredFromMs = Math.min(...spans.map((s) => s[0]))
    this.coveredToMs = Math.max(...spans.map((s) => s[1]))
    this.coveredTo = this._pos
    for (const [firstMs, lastMs, firstOff, lastOff] of spans) {
      this._map.add(firstOff, firstMs)
      this._map.add(lastOff, lastMs)
    }
    if (this.atEof) this.durationMs = Math.max(this.durationMs, this.coveredToMs)
    this._settleComplete()
  }

  /**
   * Records that the walk has nothing left to read forward.
   *
   * Whether that also makes the index *complete* depends on where the window
   * began, which is why the two are settled together and never by hand.
   */
  _noteEof () {
    this.atEof = true
    this._settleComplete()
  }

  /**
   * Whether the window, having reached the end, also reaches the beginning.
   *
   * Only then does it describe the recording rather than a stretch of it, and
   * only then may the player stop asking for more, stop banding the scrub bar
   * as part-read, and start quoting a frame count as the file's own.
   */
  _settleComplete () {
    this.complete = this.atEof && this.coveredFrom <= this.header.firstFrameOffset
  }

  // ---------------------------------------------------------------- publishing

  _publish (reanchored) {
    this.streams = [this._tables[0].view(), this._tables[1].view()]
    this.audio = this._audio.view()
    this.onChange({ reanchored, index: this })
  }

  _firstTimestamp () {
    const a = this._tables[0].count ? this._tables[0].ts[0] : Infinity
    const b = this._tables[1].count ? this._tables[1].ts[0] : Infinity
    const v = Math.min(a, b)
    return Number.isFinite(v) ? v : 0
  }

  /** The wall-clock moment media time zero corresponds to; see `firstUtcOf`. */
  _firstUtc () {
    return firstUtcOf(this._tables)
  }

  _lastUtc () {
    let best = 0
    for (const t of this._tables) {
      for (let i = t.count - 1; i >= 0; i--) {
        if (t.utc[i] > 0) { best = Math.max(best, t.utc[i]); break }
      }
    }
    return best
  }

  /**
   * Typical key-frame spacing, in ms, across the streams read so far.
   *
   * The widest spacing of the two wins, because the back-off has to be enough
   * for whichever stream is being played, and the picker may change that later.
   * The median rather than the mean: a stream whose recording restarts inside
   * the opening read has one enormous interval that no average survives.
   */
  _measureGop () {
    let worst = 0
    for (const t of this._tables) {
      if (t.keyCount < 3) continue
      const gaps = []
      for (let i = 1; i < t.keyCount; i++) {
        const d = t.ts[t.keys[i]] - t.ts[t.keys[i - 1]]
        if (d > 0) gaps.push(d)
      }
      if (!gaps.length) continue
      gaps.sort((a, b) => a - b)
      worst = Math.max(worst, gaps[gaps.length >> 1])
    }
    return worst
  }

  /** Which of the file's streams have frames in the window. */
  presentStreams () {
    return [this._tables[STREAM_MAIN].count > 0, this._tables[STREAM_SUB].count > 0]
  }

  /**
   * Which of the file's streams the recording is known to hold at all.
   *
   * Wider than `presentStreams`, and it is the wider answer the stream picker
   * wants: a main stream written only while something moved is absent from most
   * windows and present in the file.
   */
  knownStreams () {
    return [
      this.everSeen[STREAM_MAIN] || this.mainAvailable,
      this.everSeen[STREAM_SUB]
    ]
  }

  close () {
    this._closed = true
    this._want = null
    if (this._scan) { this._scan.release(); this._scan = null }
  }
}

/** Opens a streaming index over `reader`, reading only what starting needs. */
export async function openStreamingIndex (reader, header, opts = {}) {
  const index = new StreamingIndex(reader, header, opts)
  await index.open(opts)
  return index
}

/** Bounds a value to a range; the same helper the player uses. */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
