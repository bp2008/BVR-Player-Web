import { FLAG_ISKEY } from './constants.js'

/**
 * One stream's frames, in the shape the rest of the player expects, but able to
 * grow while it is being played.
 *
 * The full indexer accumulates into `Growable` lists and hands over right-sized
 * copies once, because it knows every frame before anyone sees any of them. A
 * streaming index cannot: it publishes what it has, then keeps going. So the
 * columns live here permanently and `view()` hands out subarrays over them --
 * no copy, and no moment where the table is half-written.
 *
 * The one invariant everything above depends on is that **appending never moves
 * an existing frame**. Frame 40 means the same picture after an extension as
 * before it, which is what lets the decoder keep its position, the playhead keep
 * its index, and the overlay keep its cache across a growth. Only `reset()`
 * breaks that, and re-anchoring is exactly the event the player rebuilds for.
 *
 * `keyIdx` and `keys` are maintained as frames arrive rather than swept
 * afterwards, for the same reason: a seek may be asked for between any two
 * appends, and a key-frame table that is only correct at the end would be wrong
 * for the whole of a streaming session.
 */
export class FrameTable {
  constructor (capacity = 4096) {
    this.capacity = capacity
    this.count = 0
    this.offset = new Float64Array(capacity)
    this.size = new Uint32Array(capacity)
    this.ts = new Float64Array(capacity)
    this.utc = new Float64Array(capacity)
    this.flags = new Uint16Array(capacity)
    this.dio = new Uint32Array(capacity)
    this.state = new Uint32Array(capacity)
    this.keyIdx = new Int32Array(capacity)
    this.keys = new Int32Array(256)
    this.keyCount = 0
    this._lastKey = -1
  }

  push (offset, size, ts, utc, flags, dio, state) {
    if (this.count === this.capacity) this._grow()
    const i = this.count
    this.offset[i] = offset
    this.size[i] = size
    this.ts[i] = ts
    this.utc[i] = utc
    this.flags[i] = flags
    this.dio[i] = dio
    this.state[i] = state
    if (flags & FLAG_ISKEY) {
      this._lastKey = i
      if (this.keyCount === this.keys.length) {
        const next = new Int32Array(this.keys.length * 2)
        next.set(this.keys)
        this.keys = next
      }
      this.keys[this.keyCount++] = i
    }
    this.keyIdx[i] = this._lastKey
    this.count = i + 1
  }

  _grow () {
    const next = this.capacity * 2
    for (const name of ['offset', 'size', 'ts', 'utc', 'flags', 'dio', 'state', 'keyIdx']) {
      const grown = new this[name].constructor(next)
      grown.set(this[name])
      this[name] = grown
    }
    this.capacity = next
  }

  /**
   * The table as the player reads it.
   *
   * Subarrays rather than copies, so publishing an extension costs nothing;
   * a view taken before a growth still reads correctly over its own range, which
   * is why a stale one is harmless until the next refresh replaces it.
   */
  view () {
    const n = this.count
    return {
      count: n,
      offset: this.offset.subarray(0, n),
      size: this.size.subarray(0, n),
      ts: this.ts.subarray(0, n),
      utc: this.utc.subarray(0, n),
      flags: this.flags.subarray(0, n),
      dio: this.dio.subarray(0, n),
      state: this.state.subarray(0, n),
      keyIdx: this.keyIdx.subarray(0, n),
      keys: this.keys.subarray(0, this.keyCount)
    }
  }

  reset () {
    this.count = 0
    this.keyCount = 0
    this._lastKey = -1
  }

  /** Shifts every stored timestamp, for when the file's origin is learned late. */
  rebase (delta) {
    if (!delta) return
    for (let i = 0; i < this.count; i++) this.ts[i] -= delta
  }
}

/** The audio equivalent: three columns, no key frames, same growth rules. */
export class AudioTable {
  constructor (capacity = 4096) {
    this.capacity = capacity
    this.count = 0
    this.offset = new Float64Array(capacity)
    this.size = new Uint32Array(capacity)
    this.ts = new Float64Array(capacity)
  }

  push (offset, size, ts) {
    if (this.count === this.capacity) {
      const next = this.capacity * 2
      for (const name of ['offset', 'size', 'ts']) {
        const grown = new this[name].constructor(next)
        grown.set(this[name])
        this[name] = grown
      }
      this.capacity = next
    }
    const i = this.count
    this.offset[i] = offset
    this.size[i] = size
    this.ts[i] = ts
    this.count = i + 1
  }

  view () {
    const n = this.count
    return {
      count: n,
      offset: this.offset.subarray(0, n),
      size: this.size.subarray(0, n),
      ts: this.ts.subarray(0, n)
    }
  }

  reset () { this.count = 0 }

  rebase (delta) {
    if (!delta) return
    for (let i = 0; i < this.count; i++) this.ts[i] -= delta
  }
}
