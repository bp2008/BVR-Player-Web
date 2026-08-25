/**
 * A panel in a browser window of its own.
 *
 * The panel is not re-implemented for the second window: Vue keeps rendering
 * the same component, and a `<Teleport>` puts its DOM in the popup's document
 * instead of the dock. Everything the component does -- reactivity, event
 * handlers, refs -- keeps working, because Vue binds listeners to elements
 * rather than delegating from a root.
 *
 * Two things do not travel automatically, and are handled here: the stylesheets
 * (a second document has none) and the window's own lifetime (closing it has to
 * put the panel back rather than leave it rendering into a dead document).
 */

const FEATURES = 'popup=yes,menubar=no,toolbar=no,location=no,status=no,scrollbars=yes,resizable=yes'

/**
 * Copies every stylesheet the app is using into the popup.
 *
 * `<style>` covers both deployments -- Vite injects them in development and the
 * single-file build inlines them -- and the `<link>` case is there for a plain
 * static host. Cross-origin sheets cannot be read, so they are re-linked by URL
 * rather than copied.
 */
function adoptStyles (doc) {
  doc.documentElement.style.colorScheme = 'dark'
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    doc.head.appendChild(node.cloneNode(true))
  }
  const base = doc.createElement('style')
  base.textContent = `
    html, body { height: 100%; margin: 0; overflow: hidden; }
    body { background: #0d1016; color: #e9edf3;
           font: 400 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .popout-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  `
  doc.head.appendChild(base)
}

/**
 * Opens (or re-focuses) the window for one panel.
 *
 * Returns `{ win, mount }`, or null when the browser refused -- a blocked popup
 * is an ordinary outcome here, not an error, and the caller simply leaves the
 * panel docked.
 */
export function openPanelWindow ({ id, title, width = 400, height = 640, onClose }) {
  let win = null
  try {
    const left = Math.max(0, (window.screenX || 0) + (window.outerWidth || width) - width - 40)
    const top = Math.max(0, (window.screenY || 0) + 60)
    win = window.open('', `bvr-panel-${id}`, `${FEATURES},width=${width},height=${height},left=${left},top=${top}`)
  } catch {
    return null
  }
  if (!win) return null

  // Everything past the open() is inside the try as well. A window can come
  // back whose document cannot be touched -- an opaque origin under file://
  // does exactly that -- and half-furnishing it would leave an empty window on
  // screen with the panel nowhere. Failing here is reported the same way a
  // blocked popup is, and the panel simply stays docked.
  try {
    const doc = win.document
    if (!doc || !doc.body || !doc.head) throw new Error('no document')

    // A re-used window name hands back the window that is already open;
    // clearing it is what makes re-popping the same panel idempotent.
    doc.head.replaceChildren()
    doc.body.replaceChildren()
    doc.title = title

    const meta = doc.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'width=device-width, initial-scale=1'
    doc.head.appendChild(meta)
    adoptStyles(doc)

    const mount = doc.createElement('div')
    mount.className = 'popout-root'
    doc.body.appendChild(mount)

    // pagehide fires for a closed window where unload is unreliable; both are
    // registered because neither is guaranteed on its own across browsers.
    const bye = () => { if (onClose) onClose() }
    win.addEventListener('pagehide', bye)
    win.addEventListener('beforeunload', bye)

    return { win, mount }
  } catch {
    try { win.close() } catch { /* not ours to close after all */ }
    return null
  }
}

export function closePanelWindow (handle) {
  if (!handle || !handle.win) return
  try {
    if (!handle.win.closed) handle.win.close()
  } catch { /* already gone */ }
}
