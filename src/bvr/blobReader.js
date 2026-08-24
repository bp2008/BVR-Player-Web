/**
 * Sequential/windowed reader over a Blob (or File).
 *
 * Every read the player performs is either a forward scan (indexing) or a
 * short-range payload fetch that is very likely followed by another fetch a
 * few kilobytes further on. A single sliding window therefore turns thousands
 * of tiny frame-payload reads into a handful of large ones.
 */
export class BlobReader {
  constructor (blob, windowSize = 1 << 20) {
    this.blob = blob
    this.size = blob.size
    this.windowSize = windowSize
    this._start = 0
    this._end = 0
    this._buf = null
    this._view = null
    this._inflight = null
  }

  /**
   * Returns a DataView covering [offset, offset+length). The view is backed by
   * the shared window buffer and is only valid until the next read() call.
   */
  async read (offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(`read ${offset}+${length} outside 0..${this.size}`)
    }
    if (length === 0) return new DataView(new ArrayBuffer(0))
    if (offset < this._start || offset + length > this._end) {
      await this._fill(offset, length)
    }
    return new DataView(this._buf, offset - this._start, length)
  }

  /** Returns a copy of [offset, offset+length) that outlives further reads. */
  async readCopy (offset, length) {
    const view = await this.read(offset, length)
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + length))
  }

  async _fill (offset, length) {
    const want = Math.max(this.windowSize, length)
    const start = offset
    const end = Math.min(this.size, start + want)
    // Serialise fills so concurrent callers never observe a half-swapped window.
    while (this._inflight) await this._inflight
    if (offset >= this._start && offset + length <= this._end) return
    this._inflight = this.blob.slice(start, end).arrayBuffer()
    try {
      this._buf = await this._inflight
    } finally {
      this._inflight = null
    }
    this._start = start
    this._end = start + this._buf.byteLength
    if (this._buf.byteLength < length) {
      throw new RangeError(`short read at ${offset}: wanted ${length}, got ${this._buf.byteLength}`)
    }
  }

  /** Drops the cached window (used when switching phases to free memory). */
  release () {
    this._buf = null
    this._start = this._end = 0
  }
}
