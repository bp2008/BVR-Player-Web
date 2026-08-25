/** Formats a media time in ms as h:mm:ss.mmm (hours omitted when zero). */
export function formatTime (ms, showMs = true) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const total = Math.floor(ms)
  const millis = total % 1000
  const secs = Math.floor(total / 1000) % 60
  const mins = Math.floor(total / 60000) % 60
  const hours = Math.floor(total / 3600000)
  const pad = (v, n = 2) => String(v).padStart(n, '0')
  const head = hours > 0 ? `${hours}:${pad(mins)}` : `${mins}`
  return showMs ? `${head}:${pad(secs)}.${pad(millis, 3)}` : `${head}:${pad(secs)}`
}

/**
 * Reads a media time typed by hand back into milliseconds, or null.
 *
 * It accepts everything formatTime writes -- `1:23`, `1:23.456`, `2:03:04.500`
 * -- plus the shorthands anyone typing one reaches for anyway: a bare count of
 * seconds, and a leading field that runs past its usual range, so `90:00` is
 * ninety minutes. Null rather than zero for anything unreadable: a value being
 * typed is unreadable for most of the keystrokes it takes to enter, and
 * snapping the playhead to the start of the file on each of them would make the
 * field unusable.
 */
export function parseTime (text) {
  if (typeof text !== 'string') return null
  const s = text.trim()
  if (!/^\d{1,3}(:\d{1,2}){0,2}([.,]\d{1,3})?$/.test(s)) return null
  const [whole, frac] = s.split(/[.,]/)
  let ms = 0
  for (const part of whole.split(':')) ms = ms * 60 + Number(part)
  ms *= 1000
  if (frac) ms += Number(frac.padEnd(3, '0'))
  return ms
}

/** Formats a Unix-ms timestamp in the viewer's local time zone. */
export function formatUtc (utcMs, showMs = true) {
  if (!utcMs) return ''
  const d = new Date(utcMs)
  const pad = (v, n = 2) => String(v).padStart(n, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return showMs ? `${date} ${time}.${pad(d.getMilliseconds(), 3)}` : `${date} ${time}`
}

export function formatBytes (n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
