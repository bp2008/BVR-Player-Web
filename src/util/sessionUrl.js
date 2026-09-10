/**
 * The app's state, written into the address bar and read back out of it.
 *
 * Reloading a page is the cheapest thing a browser does and the most expensive
 * thing this app can be asked to survive: a recording is a local file, the
 * playhead is somewhere an hour into it, and three panels are arranged around
 * it. None of that is worth losing to a refresh, an accidental Ctrl+R or a tab
 * restored days later -- so it goes in the fragment, where it costs nothing to
 * keep, travels with a bookmark, and is visible to anyone who wants to read it.
 *
 * The fragment rather than the query string, for three reasons. It never
 * reaches a server, so nothing about which files someone is reviewing is put in
 * a log. It leaves the URL the service worker matches on untouched, so a page
 * carrying state is still the cached page. And it is the half of a URL that may
 * be rewritten without the browser treating it as a navigation.
 *
 * Everything here is best-effort by design. A malformed fragment -- hand-edited,
 * truncated by a chat client, written by an older version -- yields defaults
 * rather than an exception, because the alternative is a player that will not
 * start because of a bad bookmark.
 */

import { PANEL_IDS } from '../panels/panels.js'

/**
 * `encodeURIComponent`, minus the escapes that only make a fragment harder to
 * read. Comma, colon and the sub-delimiters are legal in a fragment as written,
 * and a Blue Iris file name is full of them.
 */
const enc = (s) => encodeURIComponent(String(s))
  .replace(/%2C/g, ',')
  .replace(/%3A/g, ':')
  .replace(/%2F/g, '/')

/**
 * Seconds, to the millisecond, without the trailing zeros that make a URL look
 * like a machine wrote it. Milliseconds are the unit the player counts in, so
 * this is a lossless round trip either way -- see `parseTime`.
 */
function formatTime (ms) {
  const s = Math.max(0, Math.round(ms)) / 1000
  return s.toFixed(3).replace(/\.?0+$/, '') || '0'
}

const parseTime = (raw) => {
  const s = Number(raw)
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0
}

/** Known ids only, in the order given, never twice. A stale fragment names panels this build has never heard of. */
function readIds (raw, seen) {
  const out = []
  for (const id of String(raw || '').split(',')) {
    const trimmed = id.trim()
    if (!PANEL_IDS.includes(trimmed) || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Splits a fragment into its pairs.
 *
 * Deliberately not `URLSearchParams`: that is form encoding, where a space is a
 * `+` and every comma comes back as `%2C`, and this is a fragment meant to be
 * legible over someone's shoulder.
 */
function pairs (hash) {
  const out = new Map()
  for (const part of String(hash || '').replace(/^#/, '').split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq < 0 ? part : part.slice(0, eq)
    const value = eq < 0 ? '' : part.slice(eq + 1)
    try {
      out.set(decodeURIComponent(key), decodeURIComponent(value))
    } catch { /* a truncated %-escape; that pair is simply not there */ }
  }
  return out
}

/**
 * What the current URL says the app was doing.
 *
 * `file` is non-null only when the fragment names both a recording and the
 * folder it came from: a name on its own is not something that can be reopened,
 * and the folder is what says whether the handle the browser kept is the right
 * one. See `App.resumeFromUrl`.
 */
export function readSessionUrl (hash) {
  const raw = hash === undefined ? (typeof location === 'undefined' ? '' : location.hash) : hash
  const p = pairs(raw)
  const name = p.get('f') || ''
  const dir = p.get('d') || ''
  const seen = new Set()
  const left = readIds(p.get('left'), seen)
  const right = readIds(p.get('right'), seen)
  // A recording on a server, which UI3 links to directly. Only the identifying
  // half of the URL is ever written here; the session token that came with it
  // lives in `sessionStorage` instead -- see `src/remote/blueIris.js`, which is
  // also where a URL arriving with one still attached is split.
  const remote = p.get('u') || ''
  return {
    remote: remote ? { url: remote, name } : null,
    file: name && dir ? { name, dir } : null,
    time: parseTime(p.get('t')),
    playing: p.get('play') === '1',
    panels: {
      left,
      right,
      // Collapsed panels are a subset of the open ones; a fragment naming a
      // panel here and nowhere else is describing one that is not open.
      collapsed: readIds(p.get('collapsed'), new Set()).filter((id) => seen.has(id))
    }
  }
}

/**
 * The fragment for a given app state.
 *
 * Returns the fragment and, separately, the same thing without the playhead in
 * it. The caller writes the moment `stable` changes and no more than every few
 * seconds otherwise -- a position that moves thirty times a second is not worth
 * thirty URL rewrites, but the panel that just opened is worth one immediately.
 */
export function sessionHash ({ file, remote = null, time = 0, playing = false, panels }) {
  const before = []
  const after = []
  const located = !!(remote && remote.url) || !!(file && file.name && file.dir)
  if (remote && remote.url) {
    before.push(`u=${enc(remote.url)}`)
    if (remote.name) before.push(`f=${enc(remote.name)}`)
    if (playing) after.push('play=1')
  } else if (file && file.name && file.dir) {
    before.push(`f=${enc(file.name)}`, `d=${enc(file.dir)}`)
    if (playing) after.push('play=1')
  }
  const p = panels || {}
  for (const side of ['left', 'right']) {
    const ids = (p[side] || []).filter((id) => PANEL_IDS.includes(id))
    if (ids.length) after.push(`${side}=${ids.join(',')}`)
  }
  const collapsed = (p.collapsed || []).filter((id) => PANEL_IDS.includes(id))
  if (collapsed.length) after.push(`collapsed=${collapsed.join(',')}`)

  // The playhead sits between the file it belongs to and everything else, so
  // that a URL reads in the order someone would say it out loud.
  const stable = [...before, ...after].join('&')
  const t = located && time > 0 ? [`t=${formatTime(time)}`] : []
  return { hash: [...before, ...t, ...after].join('&'), stable }
}

/**
 * Puts a fragment in the address bar without navigating.
 *
 * `replaceState` rather than `pushState`: this runs every couple of seconds
 * during playback, and a back button that walks backwards through a recording
 * two seconds at a time is not a feature. It is also refused outright on
 * `file://`, where the document's origin is opaque -- so the fragment is set
 * directly there instead, which is a same-document navigation and reloads
 * nothing.
 */
export function writeSessionHash (hash) {
  if (typeof location === 'undefined') return
  const url = location.pathname + location.search + (hash ? `#${hash}` : '')
  try {
    history.replaceState(history.state, '', url)
    return
  } catch { /* opaque origin; the fragment is still ours to set */ }
  try {
    if ((location.hash || '').replace(/^#/, '') !== hash) location.replace(`#${hash}`)
  } catch { /* nothing left to try, and nothing worth breaking playback over */ }
}
