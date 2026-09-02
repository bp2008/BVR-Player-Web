/**
 * Saving the frame on screen as a still image.
 *
 * The picture itself comes from `Renderer.snapshot()`, which draws the current
 * frame at the size it is presented in. Everything here is what happens to that
 * canvas afterwards: which format it is encoded in, what the file is called, and
 * where it goes.
 *
 * JPEG is the default because a surveillance still is a photograph and every
 * program that will ever be shown one can read it. WebP is offered because it is
 * roughly a third smaller at the same visual quality and the browser's encoder
 * is native code, so it costs nothing to use -- but it is not the default,
 * because "why will my photo viewer not open this" is a worse outcome than a
 * larger file.
 */

import { parseBvrName } from '../library/bvrName.js'
import { downloadBlob } from '../util/download.js'

export const SNAPSHOT_FORMATS = [
  { value: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg' },
  { value: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp' }
]

export const DEFAULT_SNAPSHOT_QUALITY = 85

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export function snapshotFormat (value) {
  return SNAPSHOT_FORMATS.find((f) => f.value === value) || SNAPSHOT_FORMATS[0]
}

export function clampQuality (value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_SNAPSHOT_QUALITY
  return clamp(n, 1, 100)
}

/**
 * Whether this browser's canvas can encode WebP.
 *
 * Tested rather than assumed, and tested on a single pixel so the answer costs
 * nothing. A canvas asked for a format it does not have quietly encodes PNG
 * instead, so without this the setting would appear to work and silently write
 * files several times the size.
 */
let webpChecked = null
export function canEncodeWebp () {
  if (webpChecked !== null) return webpChecked
  try {
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    webpChecked = probe.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    webpChecked = false
  }
  return webpChecked
}

function toBlob (canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, type, quality)
    } catch {
      resolve(null)
    }
  })
}

/**
 * Encodes a snapshot canvas, falling back to JPEG if the wanted format turns
 * out not to be available after all.
 */
export async function encodeSnapshot (canvas, { format = 'jpeg', quality = DEFAULT_SNAPSHOT_QUALITY } = {}) {
  if (!canvas) return null
  const wanted = snapshotFormat(format)
  const q = clampQuality(quality) / 100
  let blob = await toBlob(canvas, wanted.mime, q)
  if ((!blob || blob.type !== wanted.mime) && wanted.mime !== 'image/jpeg') {
    blob = await toBlob(canvas, 'image/jpeg', q)
  }
  if (!blob || blob.size === 0) return null
  return { blob, ext: MIME_EXT[blob.type] || wanted.ext }
}

const ILLEGAL_IN_NAME = '<>:"|?*/'

/**
 * Strips what a file name may not contain.
 *
 * Camera names come from the recording, so they are as free-form as whoever
 * configured Blue Iris made them, and a leading or trailing dot is its own kind
 * of trouble on Windows. 92 is the backslash, which the list above cannot carry
 * without becoming harder to read than it is worth.
 */
function safe (text) {
  let out = ''
  for (const ch of String(text || '')) {
    const code = ch.charCodeAt(0)
    const bad = code < 32 || code === 92 || ILLEGAL_IN_NAME.includes(ch)
    out += bad ? '_' : ch
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '') || 'snapshot'
}

const pad = (v, n = 2) => String(v).padStart(n, '0')

/**
 * A name for a still, built from the recording and the position within it.
 *
 * Blue Iris names its clips `<camera>.<YYYYMMDD>_<HHMMSS>Z.bvr`, and a still
 * pulled out of one is named the same way with the frame's own UTC in place of
 * the clip's start, down to the millisecond so that two frames of the same
 * second are two files. That keeps a folder of stills sorting alongside the
 * recordings they came from, and keeps the camera and the moment readable
 * without opening anything.
 *
 * Frames without a UTC post-byte (spec 3) fall back to the clip's name plus the
 * offset into it, which is the only thing left that identifies the frame.
 */
export function snapshotName ({ fileName, utcMs, timeMs, frameIndex }, ext = 'jpg') {
  const parsed = parseBvrName(fileName || '')
  const base = safe(String(fileName || 'snapshot').replace(/\.(bvr|mp4|m4v|mov)$/i, ''))

  if (utcMs > 0) {
    const d = new Date(utcMs)
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
      `.${pad(d.getUTCMilliseconds(), 3)}Z`
    return `${safe(parsed.camera) || base}.${stamp}.${ext}`
  }

  const total = Math.max(0, Math.round(timeMs || 0))
  const h = Math.floor(total / 3600000)
  const m = Math.floor(total / 60000) % 60
  const s = Math.floor(total / 1000) % 60
  const ms = total % 1000
  const offset = h > 0
    ? `${h}h${pad(m)}m${pad(s)}s${pad(ms, 3)}`
    : `${m}m${pad(s)}s${pad(ms, 3)}`
  return `${base}.${offset}.f${(frameIndex || 0) + 1}.${ext}`
}

/** Hands a still to the browser's downloader. */
export function downloadSnapshot (blob, name) {
  // A still is small enough that a short grace period before the revoke is
  // plenty.
  downloadBlob(blob, name, 20000)
}
