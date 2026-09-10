/**
 * Reaching a recording on a Blue Iris server, and keeping its session token out
 * of everything that outlives the tab.
 *
 * UI3 hands a clip over by linking to this player with the clip's URL, and that
 * URL carries a session token because that is how Blue Iris authenticates. A
 * token is a credential: it should not be written into the address bar the
 * player keeps updating, into a bookmark, into a link pasted to somebody else,
 * or into the name of a cache directory. But it is also the only thing that
 * makes the next range request work, so it cannot simply be discarded either.
 *
 * The split this module draws: the *clip* is identified by origin and path, and
 * that is what gets remembered and shown; the *credential* is held in
 * `sessionStorage`, which is per-tab and dies with it. A reload therefore
 * resumes -- same tab, same storage -- while a shared link carries no more
 * authority than the person opening it already had.
 *
 * Nothing here is Blue Iris specific except the names of the parameters. A
 * recording served by any HTTP server that honours byte ranges opens the same
 * way; it simply has no credential to set aside.
 */

// Query parameters that authenticate rather than identify. Blue Iris uses
// `session`; the others are here because a server sitting in front of it -- a
// reverse proxy, a tunnel, a signed-URL CDN -- commonly adds one of them, and
// the harm in setting aside a parameter that turns out to be ordinary is that a
// link has to be opened again, where the harm in keeping one that turns out to
// be a credential is that it is published.
const CREDENTIAL_PARAMS = ['session', 'token', 'auth', 'key', 'sig', 'signature', 'password', 'pw']

const STORE_PREFIX = 'bvr-remote-credentials:'

/** Whether a URL is worth trying to open as a recording. */
export function isRemoteUrl (value) {
  const url = parse(value)
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:')
}

function parse (value) {
  try {
    const base = typeof location === 'undefined' ? undefined : location.href
    return new URL(String(value || ''), base)
  } catch {
    return null
  }
}

/**
 * Splits a hand-off URL into the part that identifies the recording and the
 * part that authenticates the request.
 *
 * Returns `null` for anything that is not an http(s) URL, so a malformed
 * fragment yields a start screen rather than an exception.
 */
export function splitRemoteUrl (value) {
  const url = parse(value)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  const credentials = []
  for (const name of CREDENTIAL_PARAMS) {
    for (const found of url.searchParams.getAll(name)) {
      if (found) credentials.push([name, found])
    }
    url.searchParams.delete(name)
  }
  return { url: url.toString(), credentials }
}

const storeKey = (publicUrl) => {
  const url = parse(publicUrl)
  return STORE_PREFIX + (url ? url.origin + url.pathname : String(publicUrl))
}

/** Remembers a recording's credential for this tab only. */
export function rememberCredentials (publicUrl, credentials) {
  if (!credentials || !credentials.length) return
  try {
    sessionStorage.setItem(storeKey(publicUrl), JSON.stringify(credentials))
  } catch {
    // A private window, or storage turned off. The clip still opens now; only
    // resuming it after a reload is lost, which is the right thing to lose.
  }
}

function recallCredentials (publicUrl) {
  try {
    const raw = sessionStorage.getItem(storeKey(publicUrl))
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function forgetCredentials (publicUrl) {
  try { sessionStorage.removeItem(storeKey(publicUrl)) } catch { /* nothing stored */ }
}

/**
 * The URL to actually request: the public one with this tab's credential put
 * back on it.
 *
 * Every range request goes through here rather than through a URL held in a
 * field somewhere, so there is exactly one place a token is reattached and
 * exactly one place to look when asking where it can end up.
 */
export function requestUrl (publicUrl) {
  const credentials = recallCredentials(publicUrl)
  if (!credentials.length) return publicUrl
  const url = parse(publicUrl)
  if (!url) return publicUrl
  for (const [name, value] of credentials) url.searchParams.append(name, value)
  return url.toString()
}

/**
 * A display name for a remote recording.
 *
 * Blue Iris addresses a clip by database id -- `@0000123.bvr` -- which is not
 * what anyone calls it, so a name carried alongside the link is preferred when
 * there is one.
 */
export function remoteName (publicUrl, given = '') {
  if (given) return given
  const url = parse(publicUrl)
  if (!url) return 'recording'
  const path = url.pathname
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'recording'
}
