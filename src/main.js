import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

createApp(App).mount('#app')

// Service workers require a secure context, so the offline/PWA layer only
// engages when the page is served. Opening docs/index.html straight off disk
// still works -- it just is not installable.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline caching is a nicety, never a requirement */
    })
  })
}
