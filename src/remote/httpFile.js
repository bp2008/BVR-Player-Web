/**
 * A recording on an HTTP server, presented as the small part of `Blob` this
 * player actually uses.
 *
 * Everything that reads bytes here -- `BlobReader`, `ScanReader`, the metadata
 * pipeline, the exporter, the thumbnailer -- asks a file for exactly three
 * things: its `size`, its `name`, and `slice(a, b).arrayBuffer()`. Supplying
 * those over range requests is what lets a remote recording travel the whole
 * length of the app without a single module above this one learning that the
 * bytes came off a network. The parts that genuinely have to know -- how much to
 * read before playback can start, and how far ahead to index -- are in
 * `src/bvr/streamingIndex.js`, not here.
 *
 * Three things about Blue Iris's embedded server shape this file:
 *
 * - `HEAD` answers 503, so the file's size is probed with a one-byte `GET` and
 *   read out of `Content-Range`. Cross-origin that header is not exposed, so
 *   there is a second route through `Content-Length` on an aborted plain `GET`.
 * - A range whose end runs past EOF is refused with 416 rather than clamped as
 *   RFC 9110 requires, and a malformed range drops the connection with no reply
 *   at all. Every range this file sends is therefore built from two integers it
 *   has already clamped, never from a string a caller supplied.
 * - Multi-range replies are a raw concatenation rather than
 *   `multipart/byteranges`, so ranges are always requested one at a time.
 *
 * `Connection: close` on every response means each request pays for a fresh
 * connection, which is why reads are coalesced into few large ones and issued
 * several at a time: on a link with real latency the depth is what hides it.
 *
 * It is also why 503 is an ordinary event here rather than an error. Blue Iris
 * limits how many connections it will serve at once, and a burst of range
 * requests -- which is exactly what a seek is -- can cross that limit and be
 * turned away wholesale. Nothing is wrong with the recording or with the range;
 * the server is simply full. So an overload answer is not treated as a failure
 * to report but as back-pressure to obey: the request is retried after a wait
 * that grows, and the number of connections this file will open is pulled in
 * and let back out only as answers start arriving again. See `_noteOverload`.
 */

import { PageStore, cacheKey } from './opfsPages.js'

// The unit of caching and of network coalescing. Small enough that opening a
// file -- a header at the front, a last-frame hunt at the back -- costs a
// fraction of a second on a slow link, large enough that a sequential scan is
// not dominated by per-request overhead.
export const BLOCK = 256 << 10

// Blocks per persisted page. Pages are the unit written to disk, and a page is
// only written once every block in it is in hand -- which keeps a file's presence
// and its completeness the same fact, and spares the store an occupancy map. A
// larger page would mean fewer files for a gigabyte recording, but also more
// reads that finish just short of completing one and so persist nothing; a
// megabyte is comfortably filled by the sequential walk the indexer performs.
const PAGE_BLOCKS = 4
const PAGE = BLOCK * PAGE_BLOCKS

// The most one request may ask for. Beyond this a single slow response stalls
// everything queued behind it, and nothing is available to the decoder until
// the whole span lands.
const MAX_SPAN = 4 << 20

// Requests in flight. Blue Iris closes every connection, so this is also the
// number of connections being opened at once; enough to hide a transatlantic
// round trip, not so many that a home uplink is thrashed.
const CONCURRENCY = 6

// Resident bytes before the least recently used blocks are dropped. The
// persisted tier is what makes eviction cheap, so this is sized to hold a
// working set rather than a recording.
const MEMORY_BUDGET = 192 << 20

// How far past a sequential read to fetch speculatively, and the ceiling on
// speculation outstanding at any moment.
const READAHEAD = 2 << 20
const MAX_PREFETCH = 8 << 20

// Consecutive contiguous reads before speculation begins. See `_noteSequential`.
const SEQUENTIAL_RUN = 3

const RETRIES = 3
const RETRY_BASE_MS = 250

// Statuses that mean "not now" rather than "not ever". 503 is Blue Iris's
// connection limiter; the rest are the ordinary shapes of a busy or proxied
// server. A retry after a wait is the right answer to all of them.
const OVERLOAD = new Set([429, 500, 502, 503, 504])

// The extra patience an overload buys, over and above the ordinary retry.
// Deliberately several times the plain backoff: the server is refusing because
// it is full, and hammering it is what keeps it full.
const OVERLOAD_RETRIES = 4
const OVERLOAD_BASE_MS = 600

// How long the whole file stops issuing requests after being turned away, and
// how many clean responses it takes to earn back one connection of depth.
const OVERLOAD_PAUSE_MS = 900
const RECOVER_AFTER = 8

export class HttpError extends Error {
  constructor (message, status) {
    super(message)
    this.status = status
  }
}

/**
 * A URL as it is safe to put in front of a viewer.
 *
 * A Blue Iris clip address carries a session token in its query string, and an
 * error message is the one place in this app a URL is quoted verbatim -- so it
 * is quoted without the part that would let a screenshot hand somebody else the
 * session. The origin and path are what identify the recording anyway.
 */
export function describeUrl (url) {
  try {
    const base = typeof location === 'undefined' ? undefined : location.href
    const u = new URL(url, base)
    return u.origin + u.pathname
  } catch {
    return String(url).split('?')[0]
  }
}

/** A `Blob.slice` stand-in: the range, and a promise for its bytes. */
class RemoteSlice {
  constructor (file, start, end) {
    this.file = file
    this.start = start
    this.end = end
    this.size = end - start
  }

  async arrayBuffer () {
    const bytes = await this.file.readBytes(this.start, this.size)
    return bytes.buffer
  }
}

export class HttpFile {
  /**
   * Opens a remote recording, probing its size before returning.
   *
   * `name` is what the app shows and what the address bar remembers; it
   * defaults to the last path segment, which for a Blue Iris clip is the
   * recording's own file name.
   */
  static async open (url, { name = '', headers = null, signal = null } = {}) {
    const probed = await probeSize(url, headers, signal)
    return new HttpFile(url, { ...probed, name: name || fileNameFromUrl(url), headers })
  }

  constructor (url, { size, lastModified = 0, name = '', headers = null } = {}) {
    if (!(size > 0)) throw new HttpError(`Could not determine the size of ${describeUrl(url)}`)
    this.url = url
    this.size = size
    this.name = name
    this.type = ''
    // What the container seam branches on to choose a windowed index over a
    // complete one. Nothing else in the app tests it.
    this.remote = true
    this.lastModified = lastModified
    this.headers = headers

    this.blockCount = Math.ceil(size / BLOCK)
    this._blocks = new Map()
    this._pending = new Map()
    this._pins = new Map()
    this._resident = 0
    this._queue = []
    this._active = 0
    // Connections this file will have open at once, and how the limiter is
    // being felt out. `_limit` is pulled to one the moment the server says it is
    // full and is let back out one at a time as clean answers accumulate.
    this._limit = CONCURRENCY
    this._pauseUntil = 0
    this._cleanRun = 0
    this._drainTimer = null
    this._prefetching = 0
    this._lastEnd = -1
    this._seqRun = 0
    this._closed = false
    this._aborts = new Set()

    this.pages = new PageStore(cacheKey(url, size, lastModified))
    this._pagesStored = new Set()
    this._pagesOpen = this.pages.open()

    // Bytes actually taken off the network, which is the number worth reporting
    // to a viewer on a metered connection.
    this.bytesFetched = 0
    this.requestCount = 0
  }

  /** Mirrors `Blob.slice`; the returned object is awaited for its bytes. */
  slice (start = 0, end = this.size) {
    const a = clampOffset(start, this.size)
    const b = Math.max(a, clampOffset(end, this.size))
    return new RemoteSlice(this, a, b)
  }

  /**
   * The bytes of `[offset, offset+length)`, fetching whatever is not resident.
   *
   * The copy this returns is the caller's; blocks behind it may be evicted the
   * moment this resolves.
   */
  async readBytes (offset, length) {
    if (this._closed) throw new HttpError('The remote file was closed')
    if (length <= 0) return new Uint8Array(0)
    if (offset < 0 || offset + length > this.size) {
      throw new RangeError(`read ${offset}+${length} outside 0..${this.size}`)
    }

    const first = Math.floor(offset / BLOCK)
    const last = Math.floor((offset + length - 1) / BLOCK)
    this._pin(first, last)
    try {
      await this._ensure(first, last)
      const out = new Uint8Array(length)
      for (let b = first; b <= last; b++) {
        const block = this._blocks.get(b)
        // Every block was just ensured and is pinned, so this cannot miss; the
        // check is here because a silent zero-filled gap would surface as a
        // corrupt frame a long way from its cause.
        if (!block) throw new HttpError(`block ${b} vanished while reading`)
        const blockStart = b * BLOCK
        const from = Math.max(0, offset - blockStart)
        const to = Math.min(block.length, offset + length - blockStart)
        out.set(block.subarray(from, to), blockStart + from - offset)
      }
      this._noteSequential(offset + length)
      return out
    } finally {
      this._unpin(first, last)
    }
  }

  /**
   * Asks for a span to be fetched without waiting for it.
   *
   * The indexer uses this to keep the pipe full ahead of the frame it is
   * parsing: on a link where a round trip costs more than the bytes do, what
   * decides throughput is how much is outstanding, not how fast any one
   * response arrives.
   */
  prefetch (offset, length) {
    if (this._closed || length <= 0) return
    if (this._prefetching >= MAX_PREFETCH) return
    const start = clampOffset(offset, this.size)
    const end = clampOffset(offset + length, this.size)
    if (end <= start) return
    const first = Math.floor(start / BLOCK)
    const last = Math.floor((end - 1) / BLOCK)
    this._ensure(first, last, true).catch(() => {})
  }

  /** How much of `[offset, offset+length)` is already in hand, as a fraction. */
  residentFraction (offset, length) {
    if (length <= 0) return 1
    const first = Math.floor(offset / BLOCK)
    const last = Math.floor(Math.min(this.size - 1, offset + length - 1) / BLOCK)
    let have = 0
    for (let b = first; b <= last; b++) if (this._blocks.has(b)) have++
    return have / (last - first + 1)
  }

  close () {
    this._closed = true
    if (this._drainTimer) { clearTimeout(this._drainTimer); this._drainTimer = null }
    for (const ctrl of this._aborts) {
      try { ctrl.abort() } catch { /* already settled */ }
    }
    this._aborts.clear()
    this._queue.length = 0
    this._blocks.clear()
    this._resident = 0
    this.pages.close().catch(() => {})
  }

  // ------------------------------------------------------------------ reading

  /**
   * Resolves once every block in `[first, last]` is resident.
   *
   * Missing blocks are looked for on disk first and taken off the network only
   * where that fails, and the network runs are coalesced so that a scan across
   * a hundred blocks costs a handful of requests rather than a hundred.
   */
  async _ensure (first, last, speculative = false) {
    const waits = []
    let run = -1
    for (let b = first; b <= last + 1; b++) {
      const missing = b <= last && !this._blocks.has(b)
      const pending = missing ? this._pending.get(b) : null
      if (pending) {
        waits.push(pending)
        if (run >= 0) { waits.push(this._request(run, b - 1, speculative)); run = -1 }
        continue
      }
      if (missing) {
        if (run < 0) run = b
        // A run long enough to fill a request is issued now rather than grown
        // further, so that the first bytes are on their way while the rest of
        // the span is still being worked out.
        if ((b - run + 1) * BLOCK >= MAX_SPAN) {
          waits.push(this._request(run, b, speculative))
          run = -1
        }
        continue
      }
      if (run >= 0) { waits.push(this._request(run, b - 1, speculative)); run = -1 }
    }
    if (waits.length) await Promise.all(waits)
  }

  /**
   * Claims `[from, to]`, fills it from disk or the network, and publishes it.
   *
   * The promise is registered against every block it covers before anything is
   * awaited, so a concurrent read of an overlapping span waits on this rather
   * than asking for the same bytes again.
   */
  _request (from, to, speculative) {
    const job = this._runRequest(from, to, speculative)
    for (let b = from; b <= to; b++) this._pending.set(b, job)
    const done = () => {
      for (let b = from; b <= to; b++) {
        if (this._pending.get(b) === job) this._pending.delete(b)
      }
    }
    job.then(done, done)
    return job
  }

  async _runRequest (from, to, speculative) {
    if (speculative) this._prefetching += (to - from + 1) * BLOCK
    try {
      const fromDisk = await this._fromPages(from, to)
      if (fromDisk >= 0) {
        // Everything the page store had is now resident; whatever it did not
        // have is re-derived, since a partly served run must still be whole.
        let stillMissing = false
        for (let b = from; b <= to && !stillMissing; b++) stillMissing = !this._blocks.has(b)
        if (!stillMissing) return
      }
      await this._schedule(from, to)
    } finally {
      if (speculative) this._prefetching -= (to - from + 1) * BLOCK
    }
  }

  /** Serves what the persisted pages hold. Returns -1 when there is no store. */
  async _fromPages (from, to) {
    await this._pagesOpen
    if (!this.pages.available) return -1
    const firstPage = Math.floor(from / PAGE_BLOCKS)
    const lastPage = Math.floor(to / PAGE_BLOCKS)
    for (let p = firstPage; p <= lastPage; p++) {
      if (this._pagesStored.has(p)) continue
      const bytes = await this.pages.read(p)
      if (!bytes) continue
      this._pagesStored.add(p)
      this._splitPage(p, bytes)
    }
    return 0
  }

  _splitPage (pageIndex, bytes) {
    const base = pageIndex * PAGE
    for (let i = 0; i < PAGE_BLOCKS; i++) {
      const b = pageIndex * PAGE_BLOCKS + i
      if (b >= this.blockCount) break
      const start = i * BLOCK
      if (start >= bytes.length) break
      const end = Math.min(bytes.length, start + BLOCK)
      const expected = Math.min(BLOCK, this.size - (base + start))
      if (end - start !== expected) break
      if (!this._blocks.has(b)) this._store(b, bytes.slice(start, end))
    }
  }

  /** Queues a network fetch behind the concurrency limit. */
  _schedule (from, to) {
    return new Promise((resolve, reject) => {
      this._queue.push({ from, to, resolve, reject })
      this._drain()
    })
  }

  _drain () {
    if (this._closed) return
    // A server that has just said it is full is given the quiet it asked for,
    // rather than being met with the same burst one event-loop turn later.
    const wait = this._pauseUntil - Date.now()
    if (wait > 0) {
      if (!this._drainTimer) {
        this._drainTimer = setTimeout(() => {
          this._drainTimer = null
          this._drain()
        }, wait)
      }
      return
    }
    while (this._active < this._limit && this._queue.length) {
      const job = this._queue.shift()
      this._active++
      this._fetchRun(job.from, job.to)
        .then(job.resolve, job.reject)
        .finally(() => {
          this._active--
          this._drain()
        })
    }
  }

  /**
   * The server is full: stop opening connections for a moment and open fewer.
   *
   * One connection, not none: a file that stops asking altogether cannot tell
   * when the limiter has let go, and the single request that does go out is both
   * the work and the probe.
   */
  _noteOverload () {
    this._limit = 1
    this._cleanRun = 0
    this._pauseUntil = Math.max(this._pauseUntil, Date.now() + OVERLOAD_PAUSE_MS)
  }

  /** A clean answer; enough of them in a row buy back a connection of depth. */
  _noteClean () {
    if (this._limit >= CONCURRENCY) return
    if (++this._cleanRun < RECOVER_AFTER) return
    this._cleanRun = 0
    this._limit++
  }

  async _fetchRun (from, to) {
    const start = from * BLOCK
    const end = Math.min(this.size, (to + 1) * BLOCK)
    const bytes = await this._fetchRange(start, end - start)
    for (let b = from; b <= to; b++) {
      const offset = b * BLOCK - start
      if (offset >= bytes.length) break
      const slice = bytes.subarray(offset, Math.min(bytes.length, offset + BLOCK))
      if (!this._blocks.has(b)) this._store(b, slice)
    }
    this._storePages(from, to)
  }

  /**
   * One range request, retried on the failures that are worth retrying.
   *
   * A dropped connection and a 5xx are transient -- Blue Iris closes every
   * connection anyway, so a half-open socket is an ordinary event. A 416 is
   * not: it means the range asked for something that is not there, which is a
   * bug here or a file that changed underneath, and repeating it would only
   * ask again.
   */
  async _fetchRange (offset, length) {
    let lastError = null
    // An overload buys the request a larger budget -- the server is full rather
    // than broken, and half a minute of patience is cheaper than a recording
    // that stops playing. The budget is a ceiling, not a renewal: without one, a
    // server that is refusing everything keeps extending its own reprieve.
    let allowed = RETRIES
    for (let attempt = 0; attempt <= allowed; attempt++) {
      if (this._closed) throw new HttpError('The remote file was closed')
      try {
        const bytes = await this._fetchOnce(offset, length)
        this._noteClean()
        return bytes
      } catch (e) {
        if (e instanceof HttpError && e.status === 416) throw e
        if (this._closed) throw e
        lastError = e
        const busy = e instanceof HttpError && OVERLOAD.has(e.status)
        if (busy) {
          this._noteOverload()
          allowed = RETRIES + OVERLOAD_RETRIES
        }
        if (attempt >= allowed) break
        const base = busy ? OVERLOAD_BASE_MS : RETRY_BASE_MS
        // Jitter, because every request in flight was refused by the same
        // limiter at the same moment and would otherwise come back in step.
        await delay(base * (1 << Math.min(attempt, 3)) * (0.7 + Math.random() * 0.6))
      }
    }
    throw lastError
  }

  async _fetchOnce (offset, length) {
    // Both ends are integers this file computed and clamped. A range built any
    // other way risks the malformed-header case, where the server drops the
    // connection without answering at all.
    const last = Math.min(this.size, offset + length) - 1
    const range = `bytes=${offset}-${last}`
    const ctrl = new AbortController()
    this._aborts.add(ctrl)
    try {
      this.requestCount++
      const res = await fetch(this.url, {
        headers: { ...(this.headers || {}), Range: range },
        signal: ctrl.signal,
        credentials: 'same-origin',
        cache: 'no-store'
      })
      if (res.status !== 206 && res.status !== 200) {
        // The body is not wanted, and leaving it unread holds the connection.
        try { await res.body?.cancel() } catch { /* already closed */ }
        throw new HttpError(`${describeUrl(this.url)} answered ${res.status} for ${range}`, res.status)
      }
      // A server that ignored the range hands back the whole file. Reading the
      // prefix we asked for is correct only when the range began at the start;
      // anywhere else the bytes would be the wrong ones.
      if (res.status === 200 && offset !== 0) {
        try { await res.body?.cancel() } catch { /* already closed */ }
        throw new HttpError(`${describeUrl(this.url)} ignored the Range header`, 200)
      }
      const bytes = res.status === 200
        ? await readPrefix(res, last + 1, ctrl)
        : new Uint8Array(await res.arrayBuffer())
      if (bytes.length < last + 1 - offset) {
        throw new HttpError(`short read at ${offset}: wanted ${last + 1 - offset}, got ${bytes.length}`)
      }
      this.bytesFetched += bytes.length
      return bytes
    } finally {
      this._aborts.delete(ctrl)
    }
  }

  // ------------------------------------------------------------------ storage

  _store (b, bytes) {
    this._blocks.set(b, bytes)
    this._resident += bytes.length
    this._evict()
  }

  /**
   * Drops least recently used blocks until the budget is met.
   *
   * A `Map` iterates in insertion order and a hit re-inserts, so its first
   * entries are the coldest. Pinned blocks are skipped: they belong to a read
   * that is part way through assembling its result, and evicting one would turn
   * a completed fetch into a missing block.
   */
  _evict () {
    if (this._resident <= MEMORY_BUDGET) return
    for (const [b, bytes] of this._blocks) {
      if (this._resident <= MEMORY_BUDGET) break
      if (this._pins.has(b) || this._pending.has(b)) continue
      this._blocks.delete(b)
      this._resident -= bytes.length
    }
  }

  _pin (first, last) {
    for (let b = first; b <= last; b++) this._pins.set(b, (this._pins.get(b) || 0) + 1)
  }

  _unpin (first, last) {
    for (let b = first; b <= last; b++) {
      const n = (this._pins.get(b) || 0) - 1
      if (n > 0) this._pins.set(b, n)
      else this._pins.delete(b)
    }
  }

  /** Writes out any page the run just completed. */
  _storePages (from, to) {
    if (!this.pages.available) return
    const firstPage = Math.floor(from / PAGE_BLOCKS)
    const lastPage = Math.floor(to / PAGE_BLOCKS)
    for (let p = firstPage; p <= lastPage; p++) {
      if (this._pagesStored.has(p)) continue
      const bytes = this._gatherPage(p)
      if (!bytes) continue
      this._pagesStored.add(p)
      this.pages.write(p, bytes).catch(() => {})
    }
  }

  /** A page's bytes, or null when any of its blocks is absent. */
  _gatherPage (pageIndex) {
    const base = pageIndex * PAGE
    const length = Math.min(PAGE, this.size - base)
    if (length <= 0) return null
    const out = new Uint8Array(length)
    for (let i = 0; i < PAGE_BLOCKS; i++) {
      const b = pageIndex * PAGE_BLOCKS + i
      const start = i * BLOCK
      if (start >= length) break
      const block = this._blocks.get(b)
      if (!block) return null
      out.set(block.subarray(0, Math.min(block.length, length - start)), start)
    }
    return out
  }

  /**
   * Read-ahead, driven by what the last read did rather than by a caller's
   * declaration.
   *
   * The indexer walks forward and so does the decoder's frame feed, but neither
   * is in a position to say how far ahead is useful -- that depends on the link,
   * not on the file. Noticing that reads are arriving in order and running a
   * little ahead of them covers both without either having to ask.
   */
  _noteSequential (end) {
    const contiguous = this._lastEnd >= 0 && end >= this._lastEnd && end - this._lastEnd < BLOCK * 2
    this._lastEnd = end
    // A run has to establish itself before anything is fetched on spec. A seek
    // search reads a window here and a window there, and two of those landing
    // near each other by chance is not a pattern -- but treating it as one used
    // to cost a couple of megabytes per probe, which on an hour-long recording
    // was most of what a seek spent. A walk through the frame chain reaches the
    // threshold immediately and keeps it for as long as it runs.
    this._seqRun = contiguous ? this._seqRun + 1 : 0
    if (this._seqRun >= SEQUENTIAL_RUN) this.prefetch(end, Math.min(READAHEAD, this.size - end))
  }
}

// ---------------------------------------------------------------------- probe

/**
 * The size of a remote file, by whichever of two routes the server allows.
 *
 * `HEAD` is not one of them: Blue Iris answers it with 503 and an empty body.
 * A one-byte ranged `GET` is the cheap route, and its `Content-Range` carries
 * the total -- but that header is not CORS-safelisted, so a player served from
 * a different origin than the recording cannot read it. There the fallback is a
 * plain `GET` read only as far as its headers and then aborted: `Content-Length`
 * is safelisted, so the total arrives that way instead, and the body is dropped
 * before any of it is transferred.
 */
export async function probeSize (url, headers = null, signal = null) {
  let last = null
  for (let attempt = 0; attempt <= OVERLOAD_RETRIES; attempt++) {
    try {
      return await probeSizeOnce(url, headers, signal)
    } catch (e) {
      // The very first request this app makes to a Blue Iris server is as
      // liable to meet a full connection limiter as any other, and giving up
      // there is a recording that "could not be opened" for no better reason
      // than that something else was being served at that moment.
      if (!(e instanceof HttpError) || !OVERLOAD.has(e.status)) throw e
      last = e
      if (signal && signal.aborted) throw e
      await delay(OVERLOAD_BASE_MS * (1 << Math.min(attempt, 4)) * (0.7 + Math.random() * 0.6))
    }
  }
  throw last
}

async function probeSizeOnce (url, headers, signal) {
  const ranged = await fetch(url, {
    headers: { ...(headers || {}), Range: 'bytes=0-0' },
    signal,
    credentials: 'same-origin',
    cache: 'no-store'
  })
  const lastModified = Date.parse(ranged.headers.get('last-modified') || '') || 0
  if (ranged.status === 206) {
    const total = parseContentRange(ranged.headers.get('content-range'))
    try { await ranged.body?.cancel() } catch { /* already closed */ }
    if (total > 0) return { size: total, lastModified }
  } else if (ranged.status === 200) {
    // The server ignored the range. Its Content-Length is the whole file.
    const total = Number(ranged.headers.get('content-length')) || 0
    try { await ranged.body?.cancel() } catch { /* already closed */ }
    if (total > 0) return { size: total, lastModified, noRanges: true }
  } else {
    try { await ranged.body?.cancel() } catch { /* already closed */ }
    throw new HttpError(`${describeUrl(url)} answered ${ranged.status}`, ranged.status)
  }

  const ctrl = new AbortController()
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'same-origin',
      cache: 'no-store'
    })
    if (!res.ok) throw new HttpError(`${describeUrl(url)} answered ${res.status}`, res.status)
    const total = Number(res.headers.get('content-length')) || 0
    if (!(total > 0)) throw new HttpError(`${describeUrl(url)} did not say how large it is`)
    return { size: total, lastModified: lastModified || Date.parse(res.headers.get('last-modified') || '') || 0 }
  } finally {
    try { ctrl.abort() } catch { /* already settled */ }
  }
}

function parseContentRange (value) {
  const m = /\/\s*(\d+)\s*$/.exec(String(value || ''))
  return m ? Number(m[1]) : 0
}

/** Reads the first `length` bytes of a response, then abandons the rest. */
async function readPrefix (res, length, ctrl) {
  const out = new Uint8Array(length)
  let filled = 0
  const reader = res.body.getReader()
  while (filled < length) {
    const { done, value } = await reader.read()
    if (done) break
    const take = Math.min(value.length, length - filled)
    out.set(value.subarray(0, take), filled)
    filled += take
  }
  try { ctrl.abort() } catch { /* already settled */ }
  return filled === length ? out : out.subarray(0, filled)
}

export function fileNameFromUrl (url) {
  try {
    const base = typeof location === 'undefined' ? undefined : location.href
    const path = new URL(url, base).pathname
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'recording'
  } catch {
    return 'recording'
  }
}

function clampOffset (v, size) {
  const n = Math.floor(Number(v) || 0)
  return n < 0 ? 0 : n > size ? size : n
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
