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

/**
 * Reads a wall-clock date and time back into a Unix-ms timestamp, or null.
 *
 * The mirror of formatUtc, and in the same zone it writes in -- the viewer's
 * own. It accepts what formatUtc produces, `2026-08-25 17:00:00.000`, plus the
 * loosenings anyone editing one makes anyway: a `T` between the halves, a comma
 * for the decimal point, and the seconds or the milliseconds simply left off.
 *
 * Null rather than a guess for anything unreadable, and null too for a date
 * that does not exist -- 31 February, or an hour a daylight-saving jump skipped
 * over. A Date built from out-of-range fields rolls quietly forward into the
 * next real one, so the only way to tell is to read the fields back.
 */
export function parseClock (text) {
  if (typeof text !== 'string') return null
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?$/
    .exec(text.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
  const s = m[6] ? Number(m[6]) : 0
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  const date = new Date(y, mo - 1, d, h, mi, s, ms)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d ||
      date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s) return null
  return date.getTime()
}

export function formatBytes (n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
