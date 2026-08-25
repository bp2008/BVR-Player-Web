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
 */

// <camera>.<YYYYMMDD>_<HHMMSS>[Z][ suffix ].bvr -- the trailing Z marks UTC,
// and Blue Iris appends its own suffixes to continuation clips.
const CLIP = /^(.+?)\.(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(Z?)(?:[._-][^.]*)?\.bvr$/i

export function parseBvrName (fileName) {
  const name = String(fileName || '')
  const base = name.replace(/\.bvr$/i, '')
  const m = CLIP.exec(name)
  if (!m) return { camera: base, startUtc: 0, isUtc: false, matched: false }

  const [, camera, y, mo, d, h, mi, s, z] = m
  const isUtc = z.toUpperCase() === 'Z'
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)]
  const startUtc = isUtc ? Date.UTC(...parts) : new Date(...parts).getTime()
  return {
    camera,
    startUtc: Number.isFinite(startUtc) ? startUtc : 0,
    isUtc,
    matched: true
  }
}

/** A camera name as configured, best-effort: Blue Iris lower-cases the file. */
export function displayCamera (camera) {
  return String(camera || '').replace(/[_-]+/g, ' ').trim() || 'Unknown'
}

/**
 * Groups clips into calendar days in the viewer's own time zone, newest first,
 * which is how a day of recordings is actually read.
 */
export function groupByDay (clips) {
  const days = new Map()
  for (const clip of clips) {
    const when = clip.startUtc || 0
    const key = when ? dayKey(when) : 'unknown'
    let bucket = days.get(key)
    if (!bucket) {
      bucket = { key, startUtc: when, label: when ? dayLabel(when) : 'Date unknown', clips: [] }
      days.set(key, bucket)
    }
    bucket.clips.push(clip)
    if (when && when < bucket.startUtc) bucket.startUtc = when
  }
  return [...days.values()].sort((a, b) => b.startUtc - a.startUtc)
}

function dayKey (utcMs) {
  const d = new Date(utcMs)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function dayLabel (utcMs) {
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

export function sortClips (clips, sort) {
  const out = [...clips]
  const byTime = (a, b) => (a.startUtc || 0) - (b.startUtc || 0)
  switch (sort) {
    case 'time-asc': out.sort(byTime); break
    case 'name': out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); break
    case 'camera': out.sort((a, b) => a.camera.localeCompare(b.camera) || byTime(b, a)); break
    case 'size-desc': out.sort((a, b) => b.size - a.size); break
    default: out.sort((a, b) => byTime(b, a))
  }
  return out
}
