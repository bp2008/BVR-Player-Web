import ThumbWorker from './thumbWorker.js?worker&inline'
import { describeClip, THUMB_HEIGHT, THUMB_WIDTH } from './thumbnailer.js'
import { getThumb, putThumb } from './thumbCache.js'
import { openEntry } from './directory.js'

/**
 * Produces clip thumbnails, from cache when possible, off the main thread when
 * the browser allows it.
 *
 * Three layers, cheapest first: IndexedDB, then a small pool of workers, then
 * the same code inline. The last of those is not a degraded mode so much as the
 * price of the `file://` deployment -- workers need an origin, and opening
 * `docs/index.html` off disk has none.
 *
 * Work is queued rather than fired all at once, and the queue is served by
 * priority: the caller ranks each request by how close to the middle of the
 * viewport the clip is, and the best rank goes first. Ties go to the newest
 * request, which is the right answer within one screenful. Requests for rows
 * that have scrolled away are cancelled outright.
 *
 * A plain newest-first stack was the earlier rule, on the reasoning that in a
 * grid being scrolled the last thing asked for is the thing on screen. That only
 * holds while every request comes from the same screenful: one row below the
 * fold, asked for a frame later than a row in the middle of the window, took
 * priority over it under that rule -- which is what made the order look
 * arbitrary while the pictures being looked at were still blank.
 *
 * Finished results are kept, but only a windowful of them: each carries an
 * object URL, and a folder of a hundred thousand clips is a folder somebody can
 * scroll past a hundred thousand object URLs in. The oldest are revoked once the
 * bound is passed, which costs at most an IndexedDB read if that clip is scrolled
 * back to.
 */

const OPTIONS = { maxWidth: THUMB_WIDTH, maxHeight: THUMB_HEIGHT }

// Live results to keep, in clips. Comfortably more than any window holds, so
// scrolling back a few screens still finds its pictures in memory.
const MAX_RESULTS = 600

// A worker per couple of cores, capped: the work is decode-bound and more
// concurrent hardware decoder sessions do not make the GPU faster.
function poolSize () {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  return Math.max(1, Math.min(3, Math.floor(cores / 2)))
}

class WorkerSlot {
  constructor () {
    this.worker = new ThumbWorker()
    this.busy = false
    this.seq = 0
    this.pending = new Map()
    this.worker.onmessage = (event) => {
      const msg = event.data || {}
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      this.busy = false
      if (msg.ok) entry.resolve({ info: msg.info, thumbnail: msg.thumbnail })
      else entry.reject(new Error(msg.error || 'Thumbnail failed.'))
    }
    this.worker.onerror = () => {
      for (const entry of this.pending.values()) entry.reject(new Error('The thumbnail worker stopped.'))
      this.pending.clear()
      this.busy = false
      this.broken = true
    }
  }

  run (blob) {
    const id = ++this.seq
    this.busy = true
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, blob, options: OPTIONS })
    })
  }

  terminate () {
    try { this.worker.terminate() } catch { /* already gone */ }
    this.pending.clear()
  }
}

export class ThumbService {
  constructor () {
    this.queue = []
    // Key -> queued job, so a cancel is a lookup rather than a scan of the
    // queue. Cancelled jobs are left where they are and swept out by `_take`.
    this.jobs = new Map()
    this.active = 0
    this.slots = []
    this.workersUsable = true
    this.urls = new Set()
    this.results = new Map()
    this.limit = poolSize()
  }

  /** True once a worker has actually started; useful for reporting, not logic. */
  get usingWorkers () { return this.workersUsable && this.slots.length > 0 }

  _slot () {
    if (!this.workersUsable) return null
    const free = this.slots.find((s) => !s.busy && !s.broken)
    if (free) return free
    if (this.slots.length >= this.limit) return null
    try {
      const slot = new WorkerSlot()
      this.slots.push(slot)
      return slot
    } catch {
      // No worker here -- `file://`, a strict CSP, or a browser that refuses
      // module workers. Everything runs inline from now on.
      this.workersUsable = false
      return null
    }
  }

  /**
   * Queues a clip. Resolves with `{ info, thumbUrl }`, or with `info` alone when
   * no picture could be made.
   *
   * `priority` is a rank, lowest served first; see the class comment. Callers
   * that do not care pass nothing and take their turn in request order.
   */
  request (entry, priority = 0) {
    const cached = this.get(entry.key)
    if (cached) return Promise.resolve(cached)
    const existing = this.jobs.get(entry.key)
    if (existing) {
      // Scrolling moves a clip up the list without asking for it again, so a
      // job already waiting has to be able to become more urgent than it was.
      if (priority < existing.priority) existing.priority = priority
      return existing.promise
    }

    const job = { entry, priority, cancelled: false }
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    this.jobs.set(entry.key, job)
    this.queue.push(job)
    this._pump()
    return job.promise
  }

  /**
   * A finished result, if one is still in memory.
   *
   * A plain read: this is called from a render, and a render must not reorder
   * anything. Insertion order is close enough to use order here, because what
   * gets evicted is what was fetched furthest back, which is what was on screen
   * furthest back.
   */
  get (key) {
    return this.results.get(key) || null
  }

  cancel (key) {
    const job = this.jobs.get(key)
    if (!job || job.started) return
    this.jobs.delete(key)
    job.cancelled = true
    job.resolve(null)
  }

  /**
   * The most urgent queued job, and the moment cancelled ones are swept out.
   *
   * A linear pass, because the queue only ever holds what is near the viewport
   * -- a screenful and a row either side, a few dozen at the outside -- and a
   * heap would be more machinery than that is worth. Iterating in insertion
   * order and taking `<=` means the newest of equally ranked jobs wins, which is
   * the old newest-first rule surviving where it was always right.
   */
  _take () {
    let best = -1
    let write = 0
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i]
      // A cancelled job is left in the queue rather than spliced out of it, so
      // this is where it actually goes away.
      if (job.cancelled) continue
      this.queue[write++] = job
      if (best < 0 || job.priority <= this.queue[best].priority) best = write - 1
    }
    this.queue.length = write
    if (best < 0) return null
    return this.queue.splice(best, 1)[0]
  }

  _pump () {
    // One job per worker. Going wider would only push the surplus onto the main
    // thread, which is the thing the pool exists to avoid; without workers a
    // single inline job at a time keeps the grid scrolling.
    const cap = this.workersUsable ? this.limit : 1
    while (this.active < cap) {
      const job = this._take()
      if (!job) break
      job.started = true
      this.jobs.delete(job.entry.key)
      this.active++
      this._run(job)
        .then((result) => { if (!job.cancelled) job.resolve(result) })
        // A clip that cannot be read is still an answer, and it is recorded as
        // one: a caller that asks again on every scroll frame -- which is what
        // a virtual list does -- must not re-open a corrupt file every time.
        .catch(() => { if (!job.cancelled) job.resolve(this._publish(job.entry.key, {}, null)) })
        .finally(() => {
          // However this ended -- picture, failure or cancellation -- the File
          // has done its job, and a File pins a blob in the browser process.
          // Anything listed from a directory can be re-opened by name; a
          // `webkitdirectory` listing cannot, and its File is the only route
          // back to the bytes.
          if (job.entry.dir) job.entry.file = null
          this.active--
          this._pump()
        })
    }
  }

  async _run (job) {
    const entry = job.entry
    const hit = await getThumb(entry.key)
    if (hit) {
      const result = this._publish(entry.key, hit.info, hit.image)
      return result
    }

    const blob = await openEntry(entry)
    if (job.cancelled) return null

    let produced = null
    const slot = this._slot()
    if (slot) {
      try {
        produced = await slot.run(blob)
      } catch {
        // One failed worker should not condemn the whole pool, but a broken one
        // is retired and the job finished inline.
        if (slot.broken) {
          this.slots = this.slots.filter((s) => s !== slot)
          slot.terminate()
        }
      }
    }
    if (!produced) produced = await describeClip(blob, OPTIONS)
    if (job.cancelled) return null

    const image = produced.thumbnail ? produced.thumbnail.blob : null
    putThumb({
      key: entry.key,
      info: produced.info,
      image,
      width: produced.thumbnail ? produced.thumbnail.width : 0,
      height: produced.thumbnail ? produced.thumbnail.height : 0
    })
    return this._publish(entry.key, produced.info, image)
  }

  _publish (key, info, image) {
    let thumbUrl = ''
    if (image) {
      thumbUrl = URL.createObjectURL(image)
      this.urls.add(thumbUrl)
    }
    const result = { info, thumbUrl }
    this.results.set(key, result)
    // Map iterates in insertion order, so the front of it is the oldest thing
    // nothing has asked for lately.
    while (this.results.size > MAX_RESULTS) {
      const oldest = this.results.keys().next().value
      const stale = this.results.get(oldest)
      this.results.delete(oldest)
      if (stale && stale.thumbUrl) {
        URL.revokeObjectURL(stale.thumbUrl)
        this.urls.delete(stale.thumbUrl)
      }
    }
    return result
  }

  /** Drops every object URL and queued job; called when the browser closes. */
  dispose () {
    for (const job of this.queue) { job.cancelled = true; job.resolve(null) }
    this.queue.length = 0
    this.jobs.clear()
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
    this.results.clear()
    for (const slot of this.slots) slot.terminate()
    this.slots.length = 0
  }
}
