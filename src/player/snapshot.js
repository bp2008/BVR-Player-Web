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
 *
 * The two lossless formats are for the still that has to be exactly what was on
 * screen -- evidence, or a frame something else will measure -- at several times
 * the size. PNG is the one every program reads; lossless WebP is the same
 * picture, usually a good deal smaller, read by fewer of them.
 */

import { parseBvrName } from '../library/bvrName.js'
import { downloadBlob } from '../util/download.js'

export const SNAPSHOT_FORMATS = [
  { value: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossless: false },
  { value: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', lossless: false },
  { value: 'webp-lossless', label: 'WebP (lossless)', mime: 'image/webp', ext: 'webp', lossless: true },
  { value: 'png', label: 'PNG (lossless)', mime: 'image/png', ext: 'png', lossless: true }
]

export const DEFAULT_SNAPSHOT_QUALITY = 85

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export function snapshotFormat (value) {
  return SNAPSHOT_FORMATS.find((f) => f.value === value) || SNAPSHOT_FORMATS[0]
}

/** Whether a format has a quality to set at all. Lossless ones do not. */
export function formatHasQuality (value) {
  return !snapshotFormat(value).lossless
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

/**
 * Whether a WebP file's picture is stored losslessly, from its container.
 *
 * A WebP is a RIFF file: `RIFF`, a length, `WEBP`, then chunks of a four-byte
 * name, a little-endian length and a payload padded to an even size. The picture
 * is in `VP8L` when it is lossless and `VP8 ` when it is not. The chunks are
 * walked rather than read at a fixed offset because an extended (`VP8X`)
 * container carries the colour profile first, which puts the picture a couple of
 * kilobytes in -- and a canvas with anything drawn on it does produce one.
 */
function webpIsLossless (bytes) {
  if (bytes.length < 16 || bytes.slice(0, 4) !== 'RIFF' || bytes.slice(8, 12) !== 'WEBP') return false
  let at = 12
  while (at + 8 <= bytes.length) {
    const name = bytes.slice(at, at + 4)
    if (name === 'VP8L') return true
    if (name === 'VP8 ') return false
    let size = 0
    for (let i = 3; i >= 0; i--) size = size * 256 + bytes.charCodeAt(at + 4 + i)
    at += 8 + size + (size & 1)
  }
  return false
}

/**
 * Whether this browser's canvas can encode *lossless* WebP.
 *
 * There is no way to ask for it: the canvas API has one quality argument, and
 * the encoders that have lossless switch to it at quality 1. An encoder that
 * does not takes the same call and writes a quality-100 lossy file, which looks
 * right and is not -- so, as with WebP itself, the answer is tested rather than
 * assumed. One pixel is enough: what decides the encoder's mode is the quality,
 * not the picture.
 */
let losslessWebpChecked = null
export function canEncodeLosslessWebp () {
  if (losslessWebpChecked !== null) return losslessWebpChecked
  losslessWebpChecked = false
  try {
    if (!canEncodeWebp()) return losslessWebpChecked
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    const url = probe.toDataURL('image/webp', 1)
    losslessWebpChecked = webpIsLossless(atob(url.slice(url.indexOf(',') + 1)))
  } catch {
    losslessWebpChecked = false
  }
  return losslessWebpChecked
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
  let wanted = snapshotFormat(format)
  // A browser that cannot write lossless WebP takes the same call and writes a
  // quality-100 lossy file, which is not what was asked for. PNG is the
  // substitution that keeps the promise the format made, at a cost in size.
  if (wanted.lossless && wanted.mime === 'image/webp' && !canEncodeLosslessWebp()) {
    wanted = snapshotFormat('png')
  }
  const q = clampQuality(quality) / 100
  // PNG ignores the argument; WebP encoders take quality 1 as the request for
  // lossless. The fallback keeps the settled quality either way, so a lossless
  // still that has to become a JPEG does not also become a quality-100 one.
  let blob = await toBlob(canvas, wanted.mime, wanted.lossless ? 1 : q)
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
