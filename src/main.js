import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

createApp(App).mount('#app')

// Service workers require a secure context, so the offline/PWA layer only
// engages when the page is served. Opening docs/index.html straight off disk
// still works -- it just is not installable.
//
// Never in dev: the worker is cache-first over every same-origin GET, which on
// the dev server means each edited module is served from cache forever. A dev
// page also unregisters any worker left behind by a production build that was
// once loaded from this same origin.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        /* offline caching is a nicety, never a requirement */
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .then((undone) => {
        if (undone.some(Boolean) && 'caches' in window) {
          return caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        }
      })
      .catch(() => { /* nothing cached, nothing to undo */ })
  }
}
