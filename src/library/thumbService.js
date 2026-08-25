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
 * Work is queued rather than fired all at once, and the queue is a stack: the
 * newest request is served first, because in a scrolling grid it is the one the
 * user is looking at. Requests for rows that have scrolled away are cancelled
 * outright.
 */

const OPTIONS = { maxWidth: THUMB_WIDTH, maxHeight: THUMB_HEIGHT }

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
   */
  request (entry) {
    const cached = this.results.get(entry.key)
    if (cached) return Promise.resolve(cached)
    const existing = this.queue.find((job) => job.entry.key === entry.key)
    if (existing) return existing.promise

    const job = { entry, cancelled: false }
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    this.queue.push(job)
    this._pump()
    return job.promise
  }

  cancel (key) {
    const at = this.queue.findIndex((job) => job.entry.key === key)
    if (at < 0) return
    const [job] = this.queue.splice(at, 1)
    job.cancelled = true
    job.resolve(null)
  }

  _pump () {
    // One job per worker. Going wider would only push the surplus onto the main
    // thread, which is the thing the pool exists to avoid; without workers a
    // single inline job at a time keeps the grid scrolling.
    const cap = this.workersUsable ? this.limit : 1
    while (this.active < cap && this.queue.length) {
      // Newest first: in a grid being scrolled, the last thing asked for is the
      // thing on screen.
      const job = this.queue.pop()
      if (job.cancelled) continue
      this.active++
      this._run(job)
        .then((result) => { if (!job.cancelled) job.resolve(result) })
        .catch(() => { if (!job.cancelled) job.resolve(null) })
        .finally(() => { this.active--; this._pump() })
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
    return result
  }

  /** Drops every object URL and queued job; called when the browser closes. */
  dispose () {
    for (const job of this.queue) { job.cancelled = true; job.resolve(null) }
    this.queue.length = 0
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
    this.results.clear()
    for (const slot of this.slots) slot.terminate()
    this.slots.length = 0
  }
}
