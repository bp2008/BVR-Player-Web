/**
 * IndexedDB store for clip thumbnails and the last directory handle.
 *
 * A thumbnail costs a header parse plus one key frame decode -- a few hundred
 * kilobytes and a decoder configuration, per clip. That is cheap enough to do
 * once and far too expensive to do on every visit to a folder of several hundred
 * recordings, so the encoded image is kept, keyed by name, size and modified
 * time. Those three together mean a clip that was overwritten under the same
 * name gets a fresh thumbnail rather than the old one.
 *
 * The whole module degrades to "no cache" rather than failing: private windows,
 * `file://` and storage-pressure eviction are all normal conditions here.
 */

export const DB_NAME = 'bvr-player'
const DB_VERSION = 1
const THUMBS = 'thumbnails'
const HANDLES = 'handles'

// Cache upkeep: a folder of a few hundred clips is the target, and a thumbnail
// is a few kilobytes, so this is generous while staying bounded.
const MAX_ENTRIES = 4000
const TRIM_TO = 3200

let dbPromise = null

function open () {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let request
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(THUMBS)) {
        const store = db.createObjectStore(THUMBS, { keyPath: 'key' })
        store.createIndex('used', 'used')
      }
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

function run (storeName, mode, fn) {
  return open().then((db) => {
    if (!db) return null
    return new Promise((resolve) => {
      let tx
      try {
        tx = db.transaction(storeName, mode)
      } catch {
        resolve(null)
        return
      }
      const store = tx.objectStore(storeName)
      let result = null
      try {
        result = fn(store)
      } catch {
        resolve(null)
        return
      }
      tx.oncomplete = () => {
        // A request's own result is only readable once the transaction settles.
        resolve(result && typeof result === 'object' && 'result' in result ? result.result : result)
      }
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
    })
  }).catch(() => null)
}

export async function getThumb (key) {
  const record = await run(THUMBS, 'readonly', (store) => store.get(key))
  if (!record) return null
  // Touching the record is worth a write only when the stamp is stale enough to
  // matter to eviction order.
  if (Date.now() - (record.used || 0) > 86400000) {
    run(THUMBS, 'readwrite', (store) => store.put({ ...record, used: Date.now() }))
  }
  return record
}

export async function putThumb (record) {
  await run(THUMBS, 'readwrite', (store) => store.put({ ...record, used: Date.now() }))
  trim()
}

/** Drops the least recently used entries once the store grows past its bound. */
let trimming = false
async function trim () {
  if (trimming) return
  trimming = true
  try {
    const count = await run(THUMBS, 'readonly', (store) => store.count())
    if (!count || count <= MAX_ENTRIES) return
    const db = await open()
    if (!db) return
    await new Promise((resolve) => {
      const tx = db.transaction(THUMBS, 'readwrite')
      const index = tx.objectStore(THUMBS).index('used')
      let remaining = count - TRIM_TO
      index.openCursor().onsuccess = (event) => {
        const cursor = event.target.result
        if (!cursor || remaining <= 0) return
        cursor.delete()
        remaining--
        cursor.continue()
      }
      tx.oncomplete = resolve
      tx.onerror = resolve
      tx.onabort = resolve
    })
  } catch {
    /* the cache is an optimisation; a failed trim changes nothing */
  } finally {
    trimming = false
  }
}

export async function clearThumbs () {
  await run(THUMBS, 'readwrite', (store) => store.clear())
}

/** How many thumbnails are cached, for the settings panel to report. */
export async function countThumbs () {
  const n = await run(THUMBS, 'readonly', (store) => store.count())
  return n || 0
}

/**
 * Lets go of the database, so that deleting it can actually happen.
 *
 * `deleteDatabase` with a connection still open does not fail, it *blocks*: the
 * request waits for every connection to close and the caller waits on a promise
 * that never settles. The module reopens on the next call, which is what makes
 * this safe to do while the page keeps running.
 */
export function closeThumbDb () {
  const pending = dbPromise
  dbPromise = null
  if (pending) pending.then((db) => { if (db) db.close() }).catch(() => {})
}

/**
 * Directory handles survive a reload, which is what lets the app reopen the
 * folder someone was last looking at. The permission grant may not survive, so
 * the caller still has to check before using one.
 */
export async function saveDirectoryHandle (handle) {
  await run(HANDLES, 'readwrite', (store) => store.put(handle, 'lastDirectory'))
}

export async function loadDirectoryHandle () {
  return run(HANDLES, 'readonly', (store) => store.get('lastDirectory'))
}

export async function forgetDirectoryHandle () {
  await run(HANDLES, 'readwrite', (store) => store.delete('lastDirectory'))
}

/**
 * Folders that turned out to be ruinous to list.
 *
 * Starting a directory enumeration is not a decision that can be taken back:
 * Chrome's browser process keeps working through it whatever the page does
 * afterwards, and on a large folder over a network share that is an hour of
 * every tab being unresponsive. So the one time it happens is recorded, and the
 * folder is not listed again without being asked for.
 *
 * Keyed by name, which is all a directory handle offers. Two folders sharing a
 * name only means one inherits the other's warning, and the warning has a way
 * past it.
 */
const SLOW_KEY = (name) => `slow:${name || ''}`

/**
 * A folder's file names, so it need only be enumerated once.
 *
 * Enumerating is the expensive half of opening a folder and the half that gets
 * dramatically worse when the disk underneath is busy, so it is exactly the part
 * worth not repeating. Names are all that is kept -- everything else about a clip
 * is read from the name or fetched when it scrolls into view -- which for six
 * figures of recordings is a few megabytes.
 *
 * Stale listings are a matter of new recordings not appearing, which Refresh
 * fixes, so this trades freshness for an opening that does not cost two minutes.
 * A folder that was cheap to enumerate is simply read again instead -- see
 * `FolderBrowser.worthRelisting`, which is what `scanned` is stored for.
 */
const LISTING_KEY = (name) => `listing:${name || ''}`

/**
 * `scanned` is directory entries walked, not recordings kept: the cost of
 * listing is paid per entry, and Blue Iris writes a `.dat` beside every clip, so
 * the number of names is about half the real price of coming back for more.
 */
export async function saveListing (name, names, scanned = 0) {
  await run(HANDLES, 'readwrite', (store) =>
    store.put({ names, scanned, savedAt: Date.now() }, LISTING_KEY(name)))
}

export async function loadListing (name) {
  const record = await run(HANDLES, 'readonly', (store) => store.get(LISTING_KEY(name)))
  return record && Array.isArray(record.names) ? record : null
}

export async function clearListing (name) {
  await run(HANDLES, 'readwrite', (store) => store.delete(LISTING_KEY(name)))
}

// How long a "this folder listed slowly" note is worth keeping. A slow reading
// usually means the disk was busy at that moment -- a camera writing a clip, say
// -- rather than anything permanent about the folder, so the note expires.
const SLOW_MEMO_MS = 24 * 60 * 60 * 1000

export async function markSlowFolder (name, detail) {
  await run(HANDLES, 'readwrite', (store) => store.put({ ...detail, at: Date.now() }, SLOW_KEY(name)))
}

export async function getSlowFolder (name) {
  const record = await run(HANDLES, 'readonly', (store) => store.get(SLOW_KEY(name)))
  if (!record) return null
  if (Date.now() - (record.at || 0) > SLOW_MEMO_MS) {
    clearSlowFolder(name)
    return null
  }
  return record
}

export async function clearSlowFolder (name) {
  await run(HANDLES, 'readwrite', (store) => store.delete(SLOW_KEY(name)))
}
