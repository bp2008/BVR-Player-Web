/**
 * Read-ahead sequential reader, used for the one full pass the indexer makes.
 *
 * Indexing touches every byte of the file in order, so the job is bounded by how
 * fast the platform hands the bytes over rather than by anything we compute.
 * Reading one window at a time leaves the storage stack idle between requests;
 * fixed, aligned chunks let several reads be in flight at once, so a queue is
 * always outstanding and the parse of one chunk overlaps the fetch of the next.
 * Measured at roughly twice the throughput of a single sliding window, and the
 * gap widens as per-read latency grows -- a virtual machine's disk, a network
 * share, a spinning platter.
 *
 * Chunks overlap by PAD bytes so that a frame header straddling a boundary is
 * still wholly readable from the chunk it starts in. That keeps the hot loop
 * free of any stitching, which matters when it runs once per frame.
 */

// Longest structure the scanner reads in one go: 16-byte header + extension.
const PAD = 64

export class ScanReader {
  constructor (blob, { chunkSize = 8 << 20, depth = 4 } = {}) {
    this.blob = blob
    this.size = blob.size
    this.chunkSize = chunkSize
    this.depth = depth
    this.inflight = new Map()
    this.view = null
    this.base = 0
    this.limit = 0     // file offset one past the last resident byte
    this.k = -1
    this.bytesRead = 0
  }

  _request (k) {
    const start = k * this.chunkSize
    if (start >= this.size || this.inflight.has(k)) return
    const end = Math.min(this.size, start + this.chunkSize + PAD)
    this.inflight.set(k, this.blob.slice(start, end).arrayBuffer())
  }

  /**
   * Offset of `pos` within the resident chunk when the next `need` bytes are
   * already there, else -1. Synchronous on purpose: awaiting once per frame
   * costs a microtask turn per frame and nothing else.
   */
  offsetOf (pos, need) {
    return pos >= this.base && pos + need <= this.limit ? pos - this.base : -1
  }

  /** Makes `pos` resident and returns its offset, or -1 at end of file. */
  async seek (pos) {
    const k = Math.floor(pos / this.chunkSize)
    for (const key of this.inflight.keys()) if (key < k) this.inflight.delete(key)
    this._request(k)
    for (let i = 1; i < this.depth; i++) this._request(k + i)
    const pending = this.inflight.get(k)
    if (!pending) return -1
    const buf = await pending
    this.inflight.delete(k)
    this.view = new DataView(buf)
    this.base = k * this.chunkSize
    this.limit = this.base + buf.byteLength
    this.k = k
    this.bytesRead += buf.byteLength
    return this.offsetOf(pos, 0)
  }

  release () {
    this.inflight.clear()
    this.view = null
    this.base = this.limit = 0
    this.k = -1
  }
}
