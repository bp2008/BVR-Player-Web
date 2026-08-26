import { closeThumbDb, DB_NAME } from '../library/thumbCache.js'

/**
 * What this page is using of the browser's own storage, and how to give it back.
 *
 * Everything the player keeps is kept locally -- thumbnails and folder listings
 * in IndexedDB, settings in `localStorage`, the app itself in a service-worker
 * cache -- and a folder of several thousand recordings turns that into something
 * worth being able to see and to clear. The browser offers no obvious way in:
 * site data is buried several menus deep and is described in terms of origins
 * rather than of the page someone is looking at.
 *
 * `navigator.storage.estimate()` is the only measurement on offer and it is a
 * deliberately coarse one -- browsers pad it and round it so that a page cannot
 * use it to fingerprint what else the browser has been doing. It is reported as
 * an approximation for that reason, not out of politeness.
 */

/** Bytes this origin is using, and what it is allowed, as far as the browser says. */
export async function storageUsage () {
  const out = { supported: false, usage: 0, quota: 0, indexedDB: 0, caches: 0 }
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
    return out
  }
  try {
    const est = await navigator.storage.estimate()
    out.supported = true
    out.usage = est.usage || 0
    out.quota = est.quota || 0
    // Chrome breaks the total down; nothing else does, and it is only ever used
    // to say which half of the number is thumbnails.
    const details = est.usageDetails || {}
    out.indexedDB = details.indexedDB || 0
    out.caches = details.caches || 0
    return out
  } catch {
    return out
  }
}

/**
 * Everything this origin has stored, gone.
 *
 * Order matters in one place only: an IndexedDB database with a connection still
 * open to it does not delete, it *blocks* -- the request sits there until the
 * connection closes, and the page waits forever on a promise that never settles.
 * So the cache's own handle is closed first. Every step is independently
 * best-effort, because a private window or a storage policy can refuse any one
 * of them and refusing one is no reason to skip the rest.
 */
export async function clearSiteData () {
  closeThumbDb()
  await Promise.all([clearDatabases(), clearCaches(), clearWorkers()])
  try { localStorage.clear() } catch { /* unavailable in some private modes */ }
  try { sessionStorage.clear() } catch { /* the same */ }
  clearCookies()
}

async function clearDatabases () {
  if (typeof indexedDB === 'undefined') return
  // `databases()` is not universal; the app's own database is, so it is deleted
  // by name whatever the browser is willing to enumerate.
  let names = [DB_NAME]
  try {
    if (typeof indexedDB.databases === 'function') {
      const found = await indexedDB.databases()
      names = [...new Set([...names, ...found.map((d) => d && d.name).filter(Boolean)])]
    }
  } catch { /* enumeration refused; the known name still goes */ }
  await Promise.all(names.map((name) => new Promise((resolve) => {
    let request
    try {
      request = indexedDB.deleteDatabase(name)
    } catch {
      resolve()
      return
    }
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    // Something else -- another tab on the same origin -- is holding it open.
    // Waiting on that is waiting on a person, so this stops rather than hangs.
    request.onblocked = () => resolve()
  })))
}

async function clearCaches () {
  if (typeof caches === 'undefined') return
  try {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
  } catch { /* no cache storage here */ }
}

async function clearWorkers () {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map((r) => r.unregister()))
  } catch { /* none registered, or not allowed to ask */ }
}

/**
 * The player sets none, but "all site data" has to mean all of it -- and a
 * cookie set by whatever else is served from this origin is still this origin's.
 * Only cookies visible to script and scoped to this path can be reached; an
 * HttpOnly one is invisible here by design.
 */
function clearCookies () {
  if (typeof document === 'undefined' || !document.cookie) return
  const expiry = 'Thu, 01 Jan 1970 00:00:00 GMT'
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0].trim()
    if (!name) continue
    document.cookie = `${name}=; expires=${expiry}; path=/`
    document.cookie = `${name}=; expires=${expiry}; path=${location.pathname}`
  }
}

/**
 * Shuts the page, and says so when the browser will not.
 *
 * `window.close()` only works on a window script opened, or on an installed PWA
 * closing itself. An ordinary tab silently ignores it -- so whether it worked is
 * something to find out rather than assume, and the caller needs to be able to
 * say "close this tab" when it did not.
 */
export function closePage () {
  try { window.close() } catch { /* refused, which is the answer below */ }
  return new Promise((resolve) => {
    setTimeout(() => resolve(!!window.closed), 400)
  })
}
