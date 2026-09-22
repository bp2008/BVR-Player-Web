/**
 * The back button, for an app whose pages are not URLs.
 *
 * The app has three places to be -- the start screen, the folder browser and a
 * recording -- and none of them is an address: the fragment is already spoken
 * for as the reload-proof description of the session (see `sessionUrl.js`), and
 * it is rewritten with `replaceState` every few seconds during playback. So the
 * page is kept beside the URL rather than in it, in `history.state`, which that
 * rewriting carries over untouched.
 *
 * Every entry the app owns is tagged `{ bvrNav, page, prev, key }`:
 *
 * - `page` is `'home'`, `'library'` or `'player'`.
 * - `prev` is the page of the entry beneath, as far as the app knows, which is
 *   what lets an in-app Back or Close decide between `history.back()` -- so the
 *   browser's stack stays in step with what is on screen -- and simply
 *   relabelling the entry it is on.
 * - `key` names the entry, so the recording shown on it can be found again when
 *   Back or Forward returns there. Unique across reloads, because the entries
 *   outlive the page that wrote them.
 *
 * Best-effort throughout. `pushState` is refused on `file://`, where the origin
 * is opaque, and there the back button simply leaves the app as it always did.
 */

let seq = 0
const newKey = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`

/** The app's tag on the current entry, or null for one it did not write. */
export function navState () {
  if (typeof history === 'undefined') return null
  const s = history.state
  return s && s.bvrNav ? s : null
}

/** A new entry for `page`, on top of the current one. Answers its key, or null. */
export function navPush (page, extra = {}) {
  const here = navState()
  const state = { bvrNav: 1, page, prev: here ? here.page : null, key: newKey(), ...extra }
  try {
    history.pushState(state, '', location.href)
    return state.key
  } catch {
    return null
  }
}

/**
 * Relabels the current entry as `page`, keeping its key and what lies beneath
 * it. An entry the app did not write -- the one the page loaded on, or one made
 * by editing the fragment by hand -- is adopted here.
 */
export function navReplace (page, extra = {}) {
  const here = navState()
  const state = {
    bvrNav: 1,
    page,
    prev: here ? here.prev : null,
    key: here ? here.key : newKey(),
    ...extra
  }
  try {
    history.replaceState(state, '', location.href)
    return state.key
  } catch {
    return null
  }
}

/**
 * Returns to `page`, which the app has just put on screen by itself.
 *
 * When the entry beneath is that page, this is exactly what the browser's own
 * Back would have done, and doing it with `history.back()` keeps the two from
 * drifting apart -- otherwise the next press of Back would land on the page
 * already showing, and appear to do nothing. The `popstate` that follows finds
 * the app already there. Anything else relabels the current entry instead,
 * because going back would leave the app or land somewhere unrelated.
 */
export function navReturn (page) {
  const here = navState()
  if (here && here.prev === page) {
    history.back()
    return
  }
  navReplace(page)
}
