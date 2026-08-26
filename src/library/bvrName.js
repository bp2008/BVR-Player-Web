/**
 * Blue Iris encodes the camera and the recording's start time into the file
 * name, e.g. `hillsidedrivet.20260824_203931Z.bvr`.
 *
 * That is worth reading because it is free: a folder listing has every name in
 * hand before a single byte of any file is touched, so a directory can be
 * grouped by camera and laid out on a timeline immediately, with thumbnails and
 * durations filling in behind. The header's own UTC is authoritative when a file
 * is actually opened; this is the cheap approximation that makes the listing
 * useful straight away.
 *
 * There are two names in circulation for the same recording. The one above is
 * what Blue Iris writes into its own storage folders. A clip downloaded through
 * UI3, its web interface, arrives named for a reader rather than for a file
 * system -- `Front Wide 2026-08-25 05.00.00 PM.bvr` -- with the camera under its
 * configured name, spaces intact, and a local wall-clock time in place of the
 * compact UTC stamp. Both are recognised, because a folder of downloads is as
 * ordinary a thing to browse as a folder of recordings.
 */

// <camera>.<YYYYMMDD>_<HHMMSS>[Z][ suffix ].bvr -- the trailing Z marks UTC,
// and Blue Iris appends its own suffixes to continuation clips.
const CLIP = /^(.+?)\.(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(Z?)(?:[._-][^.]*)?\.bvr$/i

// <camera> <YYYY-MM-DD> <hh>.<mm>.<ss>[ AM|PM][ (n)].bvr -- UI3's download name.
// The colons a clock would use are illegal in a Windows file name, so the time
// is dotted; the trailing `(2)` is what a browser adds when the same clip is
// downloaded twice. There is no zone marker of any kind, and none is implied:
// the time is the server's local time, so it is read as local.
const UI3 = /^(.+?)[ _]+(\d{4})-(\d{2})-(\d{2})[ _]+(\d{1,2})[.\-](\d{2})[.\-](\d{2})(?:[ _]*([AP])\.?M\.?)?(?:[ _]*\(\d+\))?\.bvr$/i

/**
 * Turns a 12-hour clock reading into a 24-hour one. Noon and midnight are the
 * two the naive arithmetic gets wrong, and they are exactly the hours a
 * surveillance clip is most likely to be named for.
 */
function hour24 (h, meridiem) {
  if (!meridiem) return h
  const pm = meridiem.toUpperCase() === 'P'
  if (h === 12) return pm ? 12 : 0
  return pm ? h + 12 : h
}

function assemble (camera, y, mo, d, h, mi, s, isUtc) {
  const parts = [Number(y), Number(mo) - 1, Number(d), h, Number(mi), Number(s)]
  const startUtc = isUtc ? Date.UTC(...parts) : new Date(...parts).getTime()
  return {
    camera,
    startUtc: Number.isFinite(startUtc) ? startUtc : 0,
    isUtc,
    matched: true
  }
}

export function parseBvrName (fileName) {
  const name = String(fileName || '')
  const base = name.replace(/\.bvr$/i, '')

  const m = CLIP.exec(name)
  if (m) {
    const [, camera, y, mo, d, h, mi, s, z] = m
    return assemble(camera, y, mo, d, Number(h), mi, s, z.toUpperCase() === 'Z')
  }

  const u = UI3.exec(name)
  if (u) {
    const [, camera, y, mo, d, h, mi, s, meridiem] = u
    const hh = hour24(Number(h), meridiem)
    // A 12-hour reading only goes to 12, and a 24-hour one only to 23. Anything
    // past that is a name that merely looked like a date.
    if (hh <= 23) return assemble(camera.trim(), y, mo, d, hh, mi, s, false)
  }

  return { camera: base, startUtc: 0, isUtc: false, matched: false }
}

/** A camera name as configured, best-effort: Blue Iris lower-cases the file. */
export function displayCamera (camera) {
  return String(camera || '').replace(/[_-]+/g, ' ').trim() || 'Unknown'
}

/**
 * The calendar day a clip belongs to, in the viewer's own time zone, as a plain
 * integer so that two clips can be compared without building a key string for
 * each one. A listing of six figures is regrouped on every keystroke in the
 * filter box, and at that rate the difference between an integer compare and a
 * string allocation is the difference between instant and not.
 *
 * -1 is "no date at all", which sorts before every real day and so lands at the
 * end of a newest-first listing, where clips whose names say nothing belong.
 */
export function dayIndex (utcMs) {
  if (!utcMs) return -1
  const d = new Date(utcMs)
  return d.getFullYear() * 512 + d.getMonth() * 32 + d.getDate()
}

export function dayLabel (utcMs) {
  if (!utcMs) return 'Date unknown'
  const d = new Date(utcMs)
  const today = new Date()
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return 'Today'
  const yesterday = new Date(today.getTime() - 86400000)
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}

export const SORTS = [
  { value: 'time-desc', label: 'Newest first' },
  { value: 'time-asc', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
  { value: 'camera', label: 'Camera, then time' },
  { value: 'size-desc', label: 'Largest first' }
]

/** Whether a sort orders clips by time, and so wants day headings. */
export const isTimeSort = (sort) => sort === 'time-desc' || sort === 'time-asc'

/** Whether a sort needs metadata the file name cannot supply. */
export const needsFileSize = (sort) => sort === 'size-desc'

// One collator, built once. `localeCompare` with options behind it has to
// resolve those options on every call, and a six-figure listing is a couple of
// million calls -- two seconds of frozen page, against a couple of hundred
// milliseconds for the same comparisons through a collator that already exists.
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
const byText = new Intl.Collator().compare

/**
 * Orders a listing. Sorts in place -- the caller owns the array, and copying a
 * six-figure listing on every sort is a cost with nothing to show for it.
 */
export function sortClips (clips, sort) {
  const byTime = (a, b) => (a.startUtc || 0) - (b.startUtc || 0)
  switch (sort) {
    case 'time-asc': clips.sort(byTime); break
    case 'name': clips.sort((a, b) => byName(a.name, b.name)); break
    case 'camera': clips.sort((a, b) => byText(a.camera, b.camera) || byTime(b, a)); break
    // A size nobody has read yet is -1, which lands these last rather than
    // pretending they are empty files.
    case 'size-desc': clips.sort((a, b) => b.size - a.size); break
    default: clips.sort((a, b) => byTime(b, a))
  }
  return clips
}
