/**
 * Persistent half of the remote byte cache: whole pages, one file each, in the
 * origin private file system.
 *
 * A remote recording is read twice over -- once to index a stretch of it, again
 * to decode the frames in that stretch -- and a viewer who scrubs backwards asks
 * for the same bytes a third time. In-memory blocks answer most of that, but
 * memory is the one tier that cannot be sized to the file: a gigabyte clip has
 * to be able to give ground under pressure, and every block it gives up is a
 * range request that has to be paid for again. Pages on disk are what make the
 * second visit free, and they survive a reload -- which matters here, because
 * the address bar remembers a remote clip and its playhead exactly as it
 * remembers a local one.
 *
 * OPFS is available wherever this player runs at all: both it and WebCodecs are
 * secure-context APIs, so a page that can decode video can also store bytes.
 * Every failure here is nonetheless swallowed and reported as a miss, because a
 * cache that throws is worse than no cache -- a full disk or an evicted origin
 * must cost bandwidth, never playback.
 *
 * Pages are written whole or not at all. A partially fetched page is left to
 * memory, which keeps a file's presence and its completeness the same fact and
 * spares the store a per-block occupancy map.
 */

const ROOT = 'bvr-cache'
const META = 'meta.json'

// How much of the origin's quota the cache may hold before the least recently
// used recordings are dropped. Chrome hands out roughly 60% of free disk, so a
// fixed ceiling would be either wasteful on a large disk or over budget on a
// small one.
const BUDGET_FRACTION = 0.5
const MIN_BUDGET = 256 << 20

/**
 * The most the cache may hold whatever the quota allows.
 *
 * Half of a large disk is more than any viewer means to hand a player for
 * scratch space, and past this the cache has stopped earning it: what gets read
 * a second time is the clip in hand and the few before it, never eight
 * gigabytes of them.
 */
export const CACHE_LIMIT = 8 * (1 << 30)

// How far below the budget a prune trims. Stopping exactly at the ceiling would
// put the very next page back over it, and a walk of every cached recording per
// megabyte written is not what a full cache should cost.
const PRUNE_SLACK = 64 << 20

// Metadata is rewritten at most this often. It exists to rank recordings for
// eviction, and a rank a moment out of date costs nothing where a file write per
// page would cost a syscall on every page.
const META_INTERVAL_MS = 5000

/**
 * The stores currently open, by the recording they hold.
 *
 * Two jobs. Eviction must not take the clip being watched -- its pages would be
 * fetched again before the file was even closed, which is the one download this
 * whole tier exists to prevent. And an open store knows how much it has written
 * long before its metadata says so, which is the difference between measuring
 * the cache and measuring it as of five seconds ago. A set per key, because
 * nothing says two stores cannot be opened on one recording.
 */
const active = new Map()

// What the last prune measured, the total at which another one is worth its
// walk, and what has been written since. Together they bound what is stored now
// without reading anything, which is what lets every page written ask "could
// this be over budget?" for free.
let lastTotal = -1
let trigger = -1
let sinceTotal = 0
let pruning = null

function retain (store) {
  const stores = active.get(store.key)
  if (stores) stores.add(store)
  else active.set(store.key, new Set([store]))
}

function release (store) {
  const stores = active.get(store.key)
  if (!stores) return
  stores.delete(store)
  if (!stores.size) active.delete(store.key)
}

/** What an open store has written, which its metadata may not have caught up with. */
function liveBytes (key) {
  const stores = active.get(key)
  if (!stores) return 0
  let most = 0
  for (const store of stores) most = Math.max(most, store.bytes)
  return most
}

/**
 * A cache key for a remote file.
 *
 * Deliberately not the whole URL. A Blue Iris clip is addressed with a session
 * token in the query string, and a token that changes on every login would make
 * every session a cache miss -- besides writing a credential into a filename,
 * which is not somewhere secrets should end up. Origin and path identify the
 * recording; size and modification time say whether the bytes behind it are
 * still the ones that were cached.
 */
export function cacheKey (url, size, lastModified) {
  let identity = String(url)
  try {
    const base = typeof location === 'undefined' ? undefined : location.href
    const u = new URL(url, base)
    identity = u.origin + u.pathname
  } catch { /* a relative URL with no base to resolve against; use it verbatim */ }
  return `${hash32(identity)}-${size}-${lastModified || 0}`
}

/** FNV-1a, as eight lowercase hex digits. A collision here costs a re-download. */
function hash32 (s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function opfsAvailable () {
  return typeof navigator !== 'undefined' && !!navigator.storage && !!navigator.storage.getDirectory
}

async function rootDir (create) {
  if (!opfsAvailable()) return null
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(ROOT, { create })
}

/**
 * The page files for one recording.
 *
 * Instances are cheap and hold nothing but a directory handle and a running
 * byte count, so the caller makes one per open file and drops it on close.
 */
export class PageStore {
  constructor (key) {
    this.key = key
    this.dir = null
    this.bytes = 0
    this.available = false
    this._opening = null
    this._metaTimer = 0
  }

  /** Opens (or creates) this recording's directory. Never throws. */
  async open () {
    if (this._opening) return this._opening
    this._opening = (async () => {
      try {
        const root = await rootDir(true)
        if (!root) return false
        this.dir = await root.getDirectoryHandle(this.key, { create: true })
        this.bytes = await this._readMeta()
        this.available = true
        retain(this)
        // Stamped before the prune below rather than after it: a recording
        // whose metadata still says last month is a recording ranked for
        // eviction, and this is what says otherwise. A directory just created
        // has no metadata at all, which would rank it first of everything.
        await this._writeMeta()
        // Not awaited: pruning walks every cached recording, and the file being
        // opened must not wait behind that.
        prune()
        return true
      } catch {
        this.available = false
        return false
      }
    })()
    return this._opening
  }

  async _readMeta () {
    try {
      const handle = await this.dir.getFileHandle(META)
      const meta = JSON.parse(await (await handle.getFile()).text())
      return Number(meta.bytes) || 0
    } catch {
      return 0
    }
  }

  /** Records this recording's size and last use, so `prune` can rank it. */
  async _writeMeta () {
    if (!this.dir) return
    try {
      const handle = await this.dir.getFileHandle(META, { create: true })
      const w = await handle.createWritable()
      await w.write(JSON.stringify({ bytes: this.bytes, used: Date.now() }))
      await w.close()
    } catch { /* the cache is an optimisation; losing its bookkeeping is not fatal */ }
  }

  _touch () {
    if (this._metaTimer) return
    this._metaTimer = setTimeout(() => {
      this._metaTimer = 0
      this._writeMeta()
    }, META_INTERVAL_MS)
  }

  /** The page at `pageIndex`, or null when it was never stored. */
  async read (pageIndex) {
    if (!this.available) return null
    try {
      const handle = await this.dir.getFileHandle(String(pageIndex))
      const buf = await (await handle.getFile()).arrayBuffer()
      return new Uint8Array(buf)
    } catch {
      return null
    }
  }

  /** Stores a complete page. The write copies, so `bytes` may be reused after. */
  async write (pageIndex, bytes) {
    if (!this.available) return
    try {
      const handle = await this.dir.getFileHandle(String(pageIndex), { create: true })
      const w = await handle.createWritable()
      await w.write(bytes)
      await w.close()
      this.bytes += bytes.byteLength
      this._touch()
      maybePrune(bytes.byteLength)
    } catch { /* quota, eviction, a locked file: all of them mean "not cached" */ }
  }

  async close () {
    // A close can arrive while the directory is still being opened -- a viewer
    // who changes their mind mid-load -- and the store has to be let go of in
    // the order it was taken, never before it exists.
    if (this._opening) await this._opening
    if (this._metaTimer) {
      clearTimeout(this._metaTimer)
      this._metaTimer = 0
    }
    await this._writeMeta()
    if (this.available) {
      this.available = false
      release(this)
    }
  }
}

async function budget () {
  try {
    const quota = Number((await navigator.storage.estimate()).quota) || 0
    return Math.min(CACHE_LIMIT, Math.max(MIN_BUDGET, quota * BUDGET_FRACTION))
  } catch {
    return MIN_BUDGET
  }
}

/** Every cached recording, with the size and last-use time its metadata claims. */
async function listResources (root) {
  const entries = []
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory') continue
    let bytes = 0
    let used = 0
    try {
      const meta = await handle.getFileHandle(META)
      const parsed = JSON.parse(await (await meta.getFile()).text())
      bytes = Number(parsed.bytes) || 0
      used = Number(parsed.used) || 0
    } catch { /* no metadata: ancient and unmeasured, so it is evicted first */ }
    // A recording being written to has more on disk than it has admitted to.
    entries.push({ name, bytes: Math.max(bytes, liveBytes(name)), used })
  }
  return entries
}

/**
 * Drops whole recordings, least recently used first, until the cache is inside
 * its budget.
 *
 * Whole recordings rather than individual pages: a half-cached clip is the worst
 * of both worlds -- it still costs a request at every gap -- and the unit a
 * viewer thinks in is the clip, not the page.
 */
export function prune () {
  if (!pruning) {
    pruning = pruneOnce()
      .catch(() => { /* an unreadable cache is one that does not get trimmed */ })
      .finally(() => { pruning = null })
  }
  return pruning
}

async function pruneOnce () {
  const root = await rootDir(false).catch(() => null)
  if (!root) return
  // Cleared before the walk, so pages written while it runs count against the
  // total it is about to measure instead of being forgotten.
  sinceTotal = 0
  const entries = await listResources(root)
  let total = entries.reduce((sum, e) => sum + e.bytes, 0)

  const limit = await budget()
  if (total > limit) {
    const target = Math.max(0, limit - PRUNE_SLACK)
    entries.sort((a, b) => a.used - b.used)
    for (const entry of entries) {
      if (total <= target) break
      if (active.has(entry.name)) continue
      try {
        await root.removeEntry(entry.name, { recursive: true })
        total -= entry.bytes
      } catch { /* held open by another tab; the next prune will find it */ }
    }
  }
  lastTotal = total
  // Under budget, the next walk is worth doing the moment the estimate crosses
  // it. Still over -- everything left is open, or another tab holds it -- and
  // walking again per page would achieve nothing but the walk, so it waits for
  // another slack of writes to change the picture.
  trigger = total > limit ? total + PRUNE_SLACK : limit
}

/**
 * Prunes, but only when the cache could plausibly be over its budget.
 *
 * Opening a file is not the only way to fill this cache past the ceiling: a
 * session left sitting on a long recording writes gigabytes without opening
 * anything again, and a prune that ran only at open would let it. Measuring
 * properly costs a metadata read per cached recording, far too much to do per
 * page -- but the last measurement plus what has been written since is an upper
 * bound on what is stored now, and that costs nothing. So a cache with room to
 * spare never touches the disk, and one at the ceiling is trimmed to a little
 * under it, which puts the walk at one per `PRUNE_SLACK` rather than one per
 * page.
 */
function maybePrune (added) {
  sinceTotal += added
  if (trigger < 0 || lastTotal + sinceTotal > trigger) prune()
}

/** Removes every cached recording. */
export async function clearCache () {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(ROOT, { recursive: true })
  } catch { /* nothing cached, or no OPFS: either way there is nothing to clear */ }
  // Not zero: a recording still open holds pages this could not remove, and
  // what is left is only worth a walk once something is written again.
  lastTotal = -1
  trigger = -1
  sinceTotal = 0
}

/** The size the cache trims back to, for the settings panel to name. */
export async function cacheBudget () {
  return budget()
}

/** Total bytes currently held, for the settings panel to report. */
export async function cacheSize () {
  const root = await rootDir(false).catch(() => null)
  if (!root) return 0
  const entries = await listResources(root).catch(() => [])
  return entries.reduce((sum, e) => sum + e.bytes, 0)
}
