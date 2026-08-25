/* BVR Player service worker: an app-shell cache so the installed PWA opens
   offline. Everything it serves is static; .bvr files are never fetched. */
/* Bumped once to evict the caches built by the old cache-first worker, whose
   entries had no way of ever expiring. The stale-while-revalidate rule below
   keeps every entry fresh from here on, so this should not need bumping again
   -- and it deliberately is not derived from the build, which would re-download
   the whole shell on every deploy for no benefit. */
const CACHE = 'bvr-player-v2'

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((p) => new URL(p, self.registration.scope).toString())))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Navigations: prefer the network so a deployed update lands immediately,
  // fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Store under both the requested URL and './index.html'. The latter is
          // the offline fallback below, and a visitor who only ever loads './'
          // would otherwise leave it frozen at whatever install() precached.
          //
          // Both clones are taken here and not inside the open() callback: by
          // then the returned response is already being consumed, and cloning a
          // disturbed body throws.
          const forRequest = response.clone()
          const forIndex = response.ok ? response.clone() : null
          caches.open(CACHE).then((cache) => {
            cache.put(request, forRequest).catch(() => {})
            if (forIndex) cache.put(indexUrl(), forIndex).catch(() => {})
          }).catch(() => {})
          return response
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match(indexUrl())))
    )
    return
  }

  // Everything else -- icons, the manifest -- is stale-while-revalidate: answer
  // from cache at once, then refresh it in the background. Plain cache-first
  // never expired, and because CACHE is a constant and this file is byte for
  // byte identical between builds, install() never re-ran to evict anything. A
  // changed icon would have stuck on existing installs forever.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      })
      if (!hit) return network
      // Offline, this refresh is expected to fail; swallow it so it does not
      // surface as an unhandled rejection. waitUntil keeps the worker alive
      // long enough for the cache write, and is guarded because calling it
      // after the event settles throws.
      const quiet = network.catch(() => {})
      try { event.waitUntil(quiet) } catch { /* event already finished */ }
      return hit
    })
  )
})

/** Absolute URL of the shell, used as the offline fallback for navigations. */
function indexUrl () {
  return new URL('./index.html', self.registration.scope).toString()
}
