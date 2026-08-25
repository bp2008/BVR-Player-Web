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

const DB_NAME = 'bvr-player'
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
