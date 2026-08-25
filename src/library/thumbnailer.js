import { BlobReader } from '../bvr/blobReader.js'
import { parseFileHeader } from '../bvr/parseFileHeader.js'
import { findFirstKeys } from '../bvr/probe.js'
import { findLastFrame } from '../bvr/tail.js'
import { describeVideoCodec } from '../bvr/codec.js'
import { STREAM_MAIN, STREAM_SUB } from '../bvr/constants.js'
import { audioCodecLabel } from '../player/audioCodecs.js'

/**
 * One poster frame and a summary line per clip, without playing anything.
 *
 * The cost is deliberately fixed rather than proportional to clip length: the
 * file header, a walk of the opening frames to the first key frame, that one key
 * frame's bytes, and a backwards read from the end for the duration. A few
 * hundred kilobytes whether the recording is thirty seconds or two hours.
 *
 * Everything here is worker-safe -- Blob, WebCodecs and OffscreenCanvas only, no
 * DOM -- because this is the module the thumbnail worker loads.
 */

// A whole key frame has to be read, not just its front: a partial payload
// decodes into a partial picture -- the top slices only -- which is what a
// half-black thumbnail is. Parameter sets do sit at the front, so configuring
// the decoder needs far less, but the picture needs the lot. The cap is a guard
// against an absurd frame header rather than an expected limit; a 4K key frame
// is a couple of megabytes.
const MAX_KEY_BYTES = 8 << 20

export const THUMB_WIDTH = 384
export const THUMB_HEIGHT = 288

const hasOffscreen = () => typeof OffscreenCanvas === 'function'

/** The sub stream first: it is smaller, so it decodes faster and scales better. */
function preferredStream (keys, seen, header) {
  if (seen[STREAM_SUB] && keys[STREAM_SUB]) return STREAM_SUB
  if (seen[STREAM_MAIN] && keys[STREAM_MAIN]) return STREAM_MAIN
  if (keys[STREAM_SUB]) return STREAM_SUB
  if (keys[STREAM_MAIN]) return STREAM_MAIN
  return header.hasSubHeader ? STREAM_SUB : STREAM_MAIN
}

/** Decodes a single key frame into something drawable, or null. */
async function decodeKeyFrame (bytes, codec) {
  if (codec.kind === 'image') {
    try {
      return await createImageBitmap(new Blob([bytes], { type: codec.mime }))
    } catch {
      return null
    }
  }
  if (codec.kind !== 'video' || typeof VideoDecoder === 'undefined') return null

  try {
    const support = await VideoDecoder.isConfigSupported(codec.config)
    if (!support || !support.supported) return null
  } catch {
    return null
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (frame) => {
      if (settled) { if (frame) frame.close(); return }
      settled = true
      try { decoder.close() } catch { /* already torn down */ }
      resolve(frame || null)
    }
    let decoder
    try {
      decoder = new VideoDecoder({
        output: (frame) => finish(frame),
        error: () => finish(null)
      })
      decoder.configure(codec.config)
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: bytes }))
      // A decoder holds the picture until it is told no more input is coming.
      decoder.flush().then(() => finish(null)).catch(() => finish(null))
    } catch {
      finish(null)
    }
  })
}

/**
 * Resamples a frame down to `w` x `h`.
 *
 * `drawImage` scaling is one bilinear step whatever the ratio, so taking 1920
 * pixels down to 384 in a single draw samples one source pixel in five and
 * throws the rest away -- which is why the result reads as nearest-neighbour.
 * `createImageBitmap`'s resize does the job properly and in native code, so it
 * is both the better picture and the cheaper one; halving repeatedly is the
 * fallback where it is unavailable, each step averaging four pixels into one.
 */
async function resample (frame, w, h) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(frame, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high'
      })
    } catch { /* no resize support here; halve instead */ }
  }

  const sw = frame.displayWidth || frame.width || 0
  const sh = frame.displayHeight || frame.height || 0
  let src = frame
  let cw = sw
  let ch = sh
  // Stop halving once one more step would undershoot; the last draw covers the
  // remainder, and from under 2x a single bilinear step is already correct.
  while (cw > w * 2 && ch > h * 2) {
    const nw = Math.max(w, cw >> 1)
    const nh = Math.max(h, ch >> 1)
    const step = makeCanvas(nw, nh)
    const sctx = step.getContext('2d', { alpha: false })
    sctx.imageSmoothingEnabled = true
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(src, 0, 0, cw, ch, 0, 0, nw, nh)
    src = step
    cw = nw
    ch = nh
  }
  return src
}

function makeCanvas (w, h) {
  return hasOffscreen()
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
}

/** Fits a frame into the thumbnail box, applying the header's orientation. */
async function paint (frame, header, maxW, maxH) {
  const sw = frame.displayWidth || frame.width || 0
  const sh = frame.displayHeight || frame.height || 0
  if (!sw || !sh) return null

  const rotation = ((header.rotation % 360) + 360) % 360
  const swap = rotation === 90 || rotation === 270
  const dispW = swap ? sh : sw
  const dispH = swap ? sw : sh
  const scale = Math.min(maxW / dispW, maxH / dispH, 1)
  const w = Math.max(1, Math.round(dispW * scale))
  const h = Math.max(1, Math.round(dispH * scale))

  // The resample works in source orientation; rotation is applied afterwards to
  // the already-small picture, so the expensive step happens exactly once.
  const rw = swap ? h : w
  const rh = swap ? w : h
  const small = scale < 1 ? await resample(frame, rw, rh) : frame

  const canvas = makeCanvas(w, h)
  const ctx = canvas.getContext('2d', { alpha: false })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.translate(w / 2, h / 2)
  if (rotation) ctx.rotate((rotation * Math.PI) / 180)
  if (header.flipH) ctx.scale(-1, 1)
  ctx.drawImage(small, -rw / 2, -rh / 2, rw, rh)
  if (small !== frame && small.close) small.close()
  return { canvas, width: w, height: h }
}

async function encode (canvas) {
  // WebP is a third the size of JPEG at this quality and is universal wherever
  // WebCodecs is; JPEG covers anything that says otherwise.
  for (const type of ['image/webp', 'image/jpeg']) {
    try {
      const blob = canvas.convertToBlob
        ? await canvas.convertToBlob({ type, quality: 0.72 })
        : await new Promise((resolve) => canvas.toBlob(resolve, type, 0.72))
      if (blob && blob.size > 0) return blob
    } catch { /* try the next encoding */ }
  }
  return null
}

/**
 * Reads everything the folder browser shows for one clip.
 *
 * A failure to produce a picture is not a failure of the whole job -- a clip in
 * a codec this device cannot decode still has a name, a size, a duration and a
 * resolution worth listing, so `thumbnail` simply comes back null.
 */
export async function describeClip (blob, { maxWidth = THUMB_WIDTH, maxHeight = THUMB_HEIGHT } = {}) {
  const reader = new BlobReader(blob, 512 << 10)
  try {
    const header = await parseFileHeader(reader)
    const { keys, seen } = await findFirstKeys(reader, header)
    const si = preferredStream(keys, seen, header)
    const bmih = header.bmih[si] || header.bmih[0]
    const key = keys[si] || keys[si === STREAM_SUB ? STREAM_MAIN : STREAM_SUB]

    let keyBytes = null
    if (key) keyBytes = await reader.readCopy(key.offset, Math.min(key.size, MAX_KEY_BYTES))
    const codec = describeVideoCodec(bmih ? bmih.fourcc : '', keyBytes, bmih)

    const last = await findLastFrame(reader, header)
    const info = {
      width: codec.width,
      height: codec.height,
      codecLabel: codec.label,
      fourcc: bmih ? bmih.fourcc : '',
      decodable: codec.kind !== 'unsupported',
      hasAudio: header.hasAudio,
      audioLabel: header.hasAudio ? audioCodecLabel(header.wfx) : '',
      dualStream: !!header.hasSubHeader,
      switchingMode: !!header.switchingMode,
      rotation: header.rotation,
      fps: header.fps,
      startUtc: header.startUtc || 0,
      // The first frame's timestamp is the recording's origin, so the last
      // frame's is the length outright (spec 9.3).
      durationMs: last ? Math.max(0, last.ts) : 0,
      endUtc: last ? last.utc : 0,
      truncated: false
    }

    let thumbnail = null
    if (keyBytes) {
      const frame = await decodeKeyFrame(keyBytes, codec)
      if (frame) {
        const painted = await paint(frame, header, maxWidth, maxHeight)
        frame.close()
        if (painted) {
          const encoded = await encode(painted.canvas)
          if (encoded) thumbnail = { blob: encoded, width: painted.width, height: painted.height }
        }
      }
    }
    return { info, thumbnail }
  } finally {
    reader.release()
  }
}
