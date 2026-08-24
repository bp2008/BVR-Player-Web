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
