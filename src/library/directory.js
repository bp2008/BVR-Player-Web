import { parseBvrName } from './bvrName.js'

/**
 * Getting at a folder of recordings, by whichever route the browser offers.
 *
 * `showDirectoryPicker()` is the good one: it hands back live handles, so files
 * are opened lazily and the directory can be re-listed later without asking
 * again. `<input type="file" webkitdirectory>` is the fallback -- it materialises
 * every `File` up front, which is fine because a `File` is just a handle to disk
 * until something reads it.
 *
 * Neither works from `file://`, where there is no origin to grant anything to.
 * The browser is therefore an enhancement that appears when it can, never
 * something opening a single file depends on.
 */

export function canPickDirectory () {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export function canBrowseDirectories () {
  if (typeof document === 'undefined') return false
  if (canPickDirectory()) return true
  // Feature-detect webkitdirectory rather than sniffing: Firefox and Safari
  // support it too, and it is the only route they have.
  return 'webkitdirectory' in document.createElement('input')
}

const isBvr = (name) => name.length > 4 && name.charCodeAt(name.length - 4) === 46 /* . */ &&
  /\.bvr$/i.test(name)

// Past this many recordings, listing stops reading per-file metadata up front:
// see `listDirectory`. Below it, a folder is small enough that the old
// everything-at-once behaviour is both affordable and nicer, because size and
// modified time are then known for every clip from the first paint.
const EAGER_STAT_LIMIT = 1500

// How many `getFile()` calls to have in flight during a bulk metadata pass.
// Each one is a round trip to the file system -- over SMB, latency rather than
// throughput is the cost, so overlapping them is the whole win.
const STAT_CONCURRENCY = 24

const thumbKey = (name, size, lastModified) => `${name}:${size}:${lastModified || 0}`

function toEntry (name, size, lastModified, dir, file) {
  const parsed = parseBvrName(name)
  const known = size >= 0
  const lower = name.toLowerCase()
  return {
    name,
    // Identity for the thumbnail cache: a recording that is re-recorded under
    // the same name is a different clip, and size plus mtime says so. Empty
    // until the metadata is actually known -- see `hydrate`.
    key: known ? thumbKey(name, size, lastModified) : '',
    // -1 means "not read yet", which is not the same as an empty file.
    size: known ? size : -1,
    lastModified: lastModified || 0,
    camera: parsed.camera,
    startUtc: parsed.startUtc || (known ? lastModified || 0 : 0),
    nameMatched: parsed.matched,
    // The needle the filter box matches against. `camera` is a slice of `name`,
    // so the name alone covers both, and re-using the existing string when it is
    // already lower case keeps a six-figure listing from doubling in memory --
    // which is the usual case, since Blue Iris writes lower-case names.
    search: lower === name ? name : lower,
    // Filled in by the row model on first use; see `clipRows.js`.
    day: undefined,
    // The *directory*, shared by every entry in the listing -- one object, not
    // one per clip. The per-file handle is resolved from it on demand and let go
    // again; see `fileHandleFor` for why that matters.
    dir: dir || null,
    handle: null,
    file: file || null,
    statPromise: null
  }
}

/**
 * The handle for one clip, resolved from the directory when something needs it.
 *
 * Not cached on the entry, and this is the whole point. A `FileSystemFileHandle`
 * is not a plain object: each one is a Mojo endpoint bound in the browser
 * process, and holding a hundred thousand of them holds a hundred thousand
 * pipes open there for as long as the folder is listed. Chrome's browser process
 * is also what serves new tabs and DevTools, so making it carry that is what
 * takes the rest of the browser down with it rather than just this page.
 *
 * Resolving one costs a round trip. The grid needs about thirty at a time.
 */
async function fileHandleFor (entry) {
  if (entry.handle) return entry.handle
  if (!entry.dir) throw new Error('This clip is no longer available.')
  return entry.dir.getFileHandle(entry.name)
}

/**
 * Lets go of the browser-side state for a clip that has scrolled out of reach.
 *
 * A `File` is a blob registered in the browser process and a handle is a pipe
 * into it; neither is something to accumulate one of per clip browsed.
 */
export function releaseEntry (entry) {
  // Only where there is a way back. A listing that came from a directory can
  // always re-open a clip by name; one that came from `webkitdirectory` cannot
  // -- the File it was handed is the only reference to those bytes there will
  // ever be, and dropping it makes the clip unopenable.
  if (entry.dir) entry.file = null
  entry.handle = null
}

/**
 * Re-reads a directory handle, so a refresh picks up newly written clips.
 *
 * Names only. Reading the *names* out of a directory is one streamed operation
 * however many there are -- a quarter of a million of them come back in well
 * under a second, even off a spinning disk over SMB. Asking each handle for its
 * `File` is the opposite: an individual round trip per clip, and at a fraction
 * of a millisecond each that is half a minute of dead air for a Blue Iris folder
 * that has been running for a while. Blue Iris also writes a `.dat` sidecar next
 * to every recording, so half of what comes back is not even a candidate.
 *
 * So the listing carries only what the name itself says -- camera and start
 * time, which is what the grid is grouped and sorted by anyway -- and size and
 * modified time are filled in per clip as it scrolls into view. Small folders
 * are hydrated up front regardless, because at that size nobody would notice.
 *
 * `onProgress` is called with a running count while scanning; `signal` aborts.
 */
export async function listDirectory (dir, { onProgress, signal } = {}) {
  const entries = []
  const started = Date.now()
  let scanned = 0
  // Report every so many entries -- or every so many milliseconds, whichever
  // comes round first. Counting alone assumes entries arrive at a rate worth
  // counting: where Chrome spends 25 ms on each one, a few thousand of them is
  // minutes of a page that looks hung, and the clock is what saves it. Counting
  // is still what governs a healthy folder, where the clock would fire far too
  // often and spend more time yielding than listing.
  const TICK = 5000
  const MAX_QUIET_MS = 120
  let lastTick = started
  const tick = () => {
    lastTick = Date.now()
    // The live array, not a copy. The caller may render from it between ticks;
    // it is only ever appended to, and only ever between awaits, so there is no
    // moment at which it is half-written.
    if (onProgress) {
      onProgress({ scanned, kept: entries.length, elapsed: lastTick - started, entries })
    }
  }
  for await (const handle of dir.values()) {
    if (signal && signal.aborted) throw abortError()
    // Counted before the filter: the cost is per directory entry, and half of
    // what Blue Iris writes is a `.dat` sidecar that never reaches the list.
    scanned++
    if (handle.kind === 'file' && isBvr(handle.name)) {
      // The name is kept and the handle is dropped on the spot, so it becomes
      // garbage on this turn of the loop instead of being held for the session.
      entries.push(toEntry(handle.name, -1, 0, dir, null))
    }
    if (scanned % TICK === 0 || Date.now() - lastTick > MAX_QUIET_MS) {
      tick()
      await yieldToUi()
    }
  }
  tick()
  if (entries.length <= EAGER_STAT_LIMIT) await hydrateAll(entries, { signal })
  return entries
}

/**
 * Turns a `webkitdirectory` FileList into the same shape.
 *
 * Names only, like the directory route, and for the same reason: `size` and
 * `lastModified` on a `File` from a file chooser are not necessarily sitting in
 * memory waiting to be read, and touching a quarter of a million of them during
 * listing is the mistake this whole design exists to avoid. The `File` itself is
 * kept, because on this route it is the only handle on those bytes there is.
 */
export function entriesFromFileList (files) {
  const out = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!isBvr(file.name)) continue
    out.push(toEntry(file.name, -1, 0, null, file))
  }
  return out
}

/**
 * Rebuilds a listing from names alone, which is all a cached one holds.
 *
 * Indistinguishable from what `listDirectory` returns: a name-only entry is what
 * that produces too, and everything past the name is fetched per clip anyway.
 */
export function entriesFromNames (names, dir) {
  const out = []
  for (const name of names) {
    if (isBvr(name)) out.push(toEntry(name, -1, 0, dir, null))
  }
  return out
}

/** Whether an entry's size and modified time have been read yet. */
export const isHydrated = (entry) => entry.size >= 0

/**
 * Reads one entry's size and modified time, which is what gives it a thumbnail
 * cache key. Concurrent callers share the one round trip, and a failure is
 * recorded as a zero-byte clip rather than retried forever -- a file Blue Iris
 * is writing into right now will refuse to open, and it still belongs in the
 * list.
 */
export function hydrate (entry) {
  if (entry.size >= 0) return Promise.resolve(entry)
  if (entry.statPromise) return entry.statPromise
  entry.statPromise = (async () => {
    try {
      // getFile() is a metadata read, not a data read; the bytes stay on disk.
      // A `webkitdirectory` entry already has its File and only needs the two
      // fields read off it, which is where that route's cost actually lands.
      const file = entry.file || await (await fileHandleFor(entry)).getFile()
      entry.file = file
      entry.size = file.size
      entry.lastModified = file.lastModified
    } catch {
      entry.size = 0
    }
    if (!entry.startUtc) {
      entry.startUtc = entry.lastModified
      // The day this clip groups under is cached on it; a start time that
      // only just arrived invalidates that.
      entry.day = undefined
    }
    entry.key = thumbKey(entry.name, entry.size, entry.lastModified)
    entry.statPromise = null
    return entry
  })()
  return entry.statPromise
}

/**
 * Hydrates a whole listing, overlapping the round trips.
 *
 * Only worth doing when something needs metadata for clips it cannot see --
 * sorting by size, most obviously -- or when the folder is small enough that
 * doing it up front is free.
 */
export async function hydrateAll (entries, { onProgress, signal } = {}) {
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < entries.length) {
      if (signal && signal.aborted) throw abortError()
      const entry = entries[next++]
      await hydrate(entry)
      // The File is only held so a thumbnail job can skip re-opening it. A bulk
      // pass is not going to make thumbnails, and six figures of retained File
      // objects is not free.
      releaseEntry(entry)
      if (++done % 512 === 0) {
        if (onProgress) onProgress(done, entries.length)
        await yieldToUi()
      }
    }
  }
  const width = Math.max(1, Math.min(STAT_CONCURRENCY, entries.length))
  await Promise.all(Array.from({ length: width }, worker))
  if (onProgress) onProgress(entries.length, entries.length)
}

function abortError () {
  const e = new Error('Cancelled.')
  e.name = 'AbortError'
  return e
}

/**
 * Hands control back to the browser: a macrotask, not a microtask, because a
 * promise continuation runs before any painting happens and so yields nothing.
 *
 * Not `setTimeout`. A background tab clamps timers to one a second, so a scan
 * someone left running while they looked at another tab would slow to a crawl
 * exactly when it is least able to explain itself -- and even in the foreground
 * a nested timeout is pinned to a 4 ms floor. A `MessageChannel` message is
 * neither throttled nor clamped. One message is posted per waiter, so the
 * twenty-odd concurrent callers in `hydrateAll` each get their own.
 */
const yieldToUi = (() => {
  if (typeof MessageChannel !== 'function') {
    return () => new Promise((resolve) => setTimeout(resolve, 0))
  }
  const channel = new MessageChannel()
  const waiting = []
  channel.port1.onmessage = () => {
    const resolve = waiting.shift()
    if (resolve) resolve()
  }
  return () => new Promise((resolve) => {
    waiting.push(resolve)
    channel.port2.postMessage(0)
  })
})()

/** The Blob for an entry, opened only when something actually needs the bytes. */
export async function openEntry (entry) {
  if (entry.file) return entry.file
  const file = await (await fileHandleFor(entry)).getFile()
  entry.file = file
  if (entry.size < 0) {
    entry.size = file.size
    entry.lastModified = file.lastModified
    entry.key = thumbKey(entry.name, entry.size, entry.lastModified)
  }
  return file
}

/**
 * Whether a stored directory handle can still be read.
 *
 * A handle persisted in IndexedDB survives a reload but its permission grant may
 * not, and re-requesting needs a user gesture -- so the caller has to know which
 * of the two situations it is in before it can do the right thing.
 */
export async function directoryPermission (handle, request = false, mode = 'read') {
  if (!handle || typeof handle.queryPermission !== 'function') return 'granted'
  try {
    const state = await handle.queryPermission({ mode })
    if (state === 'granted' || !request) return state
    return await handle.requestPermission({ mode })
  } catch {
    return 'denied'
  }
}

/**
 * A name nothing in `dir` is using yet.
 *
 * `getFileHandle(name, { create: true })` would happily write over whatever is
 * already there, and silently destroying a file is not something a snapshot
 * button should be capable of. Anything other than "no such file" is treated as
 * "taken" rather than investigated -- the next candidate costs nothing.
 */
async function unusedName (dir, name) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; n <= 200; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`
    try {
      await dir.getFileHandle(candidate)
    } catch (e) {
      if (e && e.name === 'NotFoundError') return candidate
    }
  }
  return `${stem}-${Date.now()}${ext}`
}

/**
 * Writes one file into a directory the user has granted write access to, and
 * returns the name it ended up with.
 */
export async function writeFileTo (dir, name, blob) {
  const finalName = await unusedName(dir, name)
  const handle = await dir.getFileHandle(finalName, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
    await writable.close()
  } catch (e) {
    try { await writable.abort() } catch { /* already closed */ }
    throw e
  }
  return finalName
}
