import { BlobReader } from '../bvr/blobReader.js'
import { parseObjectDefinitions, parseObjectUpdates, OverlayState } from '../bvr/metadata.js'

/**
 * Keeps the overlay state (spec section 7) in step with the playhead.
 *
 * Type-2 records are deltas, so the state at time T is not any single record --
 * it is the first record folded together with every record since. Replaying all
 * of them after each seek would be thousands of reads on a long clip, and the
 * format's own placement guarantees make that unnecessary: shapes and every
 * object that has ever changed are rewritten after each key frame, and objects
 * that never change appear in the very first record. Rebuilding therefore costs
 * one read of record 0 plus the handful of records inside the current GOP.
 *
 * Playing forward is cheaper still: records are folded in as the playhead
 * crosses them, one small read each.
 *
 * The reader is its own, with a small window. Overlay records sit immediately
 * after the video frame they describe, so they trail the playhead, while the
 * video pipeline reads ahead of it -- sharing one sliding window would have the
 * two ends of the file evicting each other.
 */
const META_WINDOW = 256 << 10

// Records are a few hundred bytes; a modest cache spares repeat reads while
// stepping back and forth over the same GOP.
const CACHE_LIMIT = 256

// How far ahead a forward seek may fold records one by one before rebuilding
// from the GOP is the cheaper route. A rebuild costs record 0 plus one GOP, so
// the crossover is well under a hundred.
const REBUILD_AFTER = 64

export class MetadataPipeline {
  constructor ({ blob, index, onChange }) {
    this.reader = new BlobReader(blob, META_WINDOW)
    this.index = index
    this.onChange = onChange || (() => {})

    // Spec 7: the type-1 record is written once, near the start of the file.
    this.defRecord = index.metadata.find((m) => m.subtype === 1) || null
    this.updates = index.metadata.filter((m) => m.subtype === 2)

    this.defs = []
    this.state = new OverlayState([])
    this.ready = false
    this.hasRecords = this.updates.length > 0 || !!this.defRecord

    this._cache = new Map()
    this._applied = -1
    this._epoch = 0
    this._busy = false
    this._want = null
  }

  /** Reads the object definitions. Everything else waits on this. */
  async load () {
    if (this.ready) return
    if (this.defRecord) {
      try {
        const bytes = await this.reader.readCopy(this.defRecord.offset, this.defRecord.size)
        this.defs = parseObjectDefinitions(bytes)
      } catch {
        // A truncated or corrupt definition record leaves the updates
        // uninterpretable, but the file itself still plays.
        this.defs = []
      }
    }
    this.state = new OverlayState(this.defs)
    this.ready = true
  }

  /** Index of the last type-2 record at or before `ms`, or -1. */
  _recordIndexAt (ms) {
    const list = this.updates
    if (!list.length || ms < list[0].ts) return -1
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (list[mid].ts <= ms) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  async _bytesFor (i) {
    const hit = this._cache.get(i)
    if (hit) return hit
    const rec = this.updates[i]
    const bytes = await this.reader.readCopy(rec.offset, rec.size)
    if (this._cache.size >= CACHE_LIMIT) {
      // Plain FIFO: the access pattern is a moving window, so the oldest entry
      // is reliably the least useful one.
      this._cache.delete(this._cache.keys().next().value)
    }
    this._cache.set(i, bytes)
    return bytes
  }

  /**
   * Brings the overlay state to `ms`. `keyTs` is the timestamp of the key frame
   * the position decodes from, and bounds how far back a rebuild has to reach.
   *
   * Requests coalesce: while one update is in flight the newest target is
   * remembered and run afterwards, so dragging the scrub bar cannot pile up a
   * queue of reads for positions nobody is looking at any more.
   */
  update (ms, keyTs) {
    if (!this.hasRecords) return
    this._want = { ms, keyTs }
    if (this._busy) return
    this._busy = true
    this._drain().catch(() => { /* overlays are never worth failing playback for */ })
      .finally(() => { this._busy = false })
  }

  async _drain () {
    await this.load()
    while (this._want) {
      const { ms, keyTs } = this._want
      this._want = null
      await this._applyTo(ms, keyTs)
    }
  }

  async _applyTo (ms, keyTs) {
    const target = this._recordIndexAt(ms)
    if (target === this._applied) return
    const epoch = this._epoch

    let from
    if (target < 0) {
      // Before the first record: nothing has been declared yet.
      this.state.reset()
      this._applied = -1
      this.onChange(this.state)
      return
    }
    // Playing forward, or a seek short enough that folding the records in one at
    // a time is cheaper than a rebuild. A long forward seek is not: jumping half
    // an hour ahead would replay thousands of records to reach a state the GOP
    // rewrites give in a handful of reads.
    if (target > this._applied && this._applied >= 0 && target - this._applied <= REBUILD_AFTER) {
      from = this._applied + 1
    } else {
      // A backward jump, or the first position of the file. Rebuild from the
      // opening record plus this GOP's worth of rewrites.
      this.state.reset()
      const guard = Number.isFinite(keyTs) ? keyTs : ms
      let start = target
      while (start > 0 && this.updates[start - 1].ts >= guard) start--
      if (start > 0) {
        const first = await this._bytesFor(0)
        if (epoch !== this._epoch) return
        this.state.apply(parseObjectUpdates(first, this.defs))
      }
      from = start
    }

    for (let i = from; i <= target; i++) {
      const bytes = await this._bytesFor(i)
      if (epoch !== this._epoch) return
      this.state.apply(parseObjectUpdates(bytes, this.defs))
    }
    this._applied = target
    this.onChange(this.state)
  }

  /** All records parsed at one position, for the inspector panel. */
  async recordAt (ms) {
    await this.load()
    const i = this._recordIndexAt(ms)
    if (i < 0) return null
    const rec = this.updates[i]
    const bytes = await this._bytesFor(i)
    return { ...rec, recordIndex: i, updates: parseObjectUpdates(bytes, this.defs) }
  }

  close () {
    this._epoch++
    this._want = null
    this._cache.clear()
    this.state.close()
    this.reader.release()
  }
}
