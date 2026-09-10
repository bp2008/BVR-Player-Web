import { readFrameHeader } from './parseFileHeader.js'
import {
  FLAG_ISAUDIO, FLAG_ISMETADATA, FLAG_ISHEADER, FLAG_SUBSTREAM, FLAG_STREAMFLAGS,
  FRAME_HEADER_SIZE, SIGNATURE
} from './constants.js'

/**
 * The frame chain, walked once and reported to a sink.
 *
 * A BVR file is a singly linked list whose links are its payloads: the header at
 * `pos` gives the size of the data after it, and only that says where the next
 * header begins. Every part of this player that wants to know what is in a file
 * -- the full index built on open, the streaming index that covers a stretch at
 * a time, and any future reader -- is walking that same chain, and the walk is
 * the one place where a misread field turns into frames landing at the wrong
 * offsets. So it lives here once.
 *
 * The sink takes primitives rather than a record per frame. At a few hundred
 * thousand frames an hour, a frame object -- and the BigInt a `getBigUint64`
 * would mint for the UTC field -- are worth not allocating, and the header is
 * therefore read field by field here rather than through `readFrameHeader`.
 * That function is still what validates a *candidate* during resynchronisation,
 * where one allocation per hunt is nothing.
 */

// Longest structure read in one go: the 16-byte header plus its extension.
const HEADER_SPAN = 32

/**
 * Walks frames from `from` until `to` (exclusive) or end of file.
 *
 * `scan` is a `ScanReader` positioned by this function; its chunk size and depth
 * are what decide how much of the file is outstanding at once, which is the only
 * knob that matters when the bytes are arriving over a network.
 *
 * Returns where it stopped and why, so a caller resuming later starts exactly
 * where this left off.
 */
export async function walkFrames (scan, {
  from,
  to = Infinity,
  fileSize,
  reader,
  sink,
  shouldStop = null,
  onProgress = null,
  progressStep = 0,
  yieldToUi = null
} = {}) {
  let pos = from
  let frames = 0
  let resyncs = 0
  let truncated = false
  let nextProgress = progressStep ? pos + progressStep : Infinity

  while (pos + FRAME_HEADER_SIZE <= fileSize && pos < to) {
    if (shouldStop && shouldStop()) break

    const need = Math.min(HEADER_SPAN, fileSize - pos)
    let at = scan.offsetOf(pos, need)
    if (at < 0) {
      await scan.seek(pos)
      at = scan.offsetOf(pos, need)
      if (at < 0) break
    }

    const view = scan.view
    if (view.getUint32(at, true) !== SIGNATURE) {
      const found = await resync(reader, fileSize, pos)
      if (found < 0) { truncated = true; break }
      resyncs++
      pos = found
      continue
    }
    const flags = view.getUint16(at + 4, true)
    const postbytes = view.getUint16(at + 6, true)
    const timestamp = view.getUint32(at + 8, true)
    const datasize = view.getUint32(at + 12, true)

    const payloadPos = pos + FRAME_HEADER_SIZE + postbytes
    const next = payloadPos + datasize
    if (next > fileSize) { truncated = true; break }

    let utc = 0
    let dio = 0
    let stateBits = 0
    if (postbytes >= 16 && at + HEADER_SPAN <= view.byteLength) {
      // Split 64-bit read: unix-ms sits far below 2^53, so this stays exact.
      utc = view.getUint32(at + 20, true) * 4294967296 + view.getUint32(at + 16, true)
      dio = view.getUint32(at + 24, true)
      stateBits = view.getUint32(at + 28, true)
    }

    if (flags & FLAG_ISHEADER) {
      // Extra header frames are not expected mid-file; skip per spec section 9.4.
    } else if (flags & FLAG_ISMETADATA) {
      sink.metadata(payloadPos, datasize, flags >> 8, timestamp, utc)
    } else if (flags & FLAG_ISAUDIO) {
      sink.audio(payloadPos, datasize, timestamp)
    } else {
      const si = (flags & FLAG_STREAMFLAGS) === FLAG_SUBSTREAM ? 1 : 0
      // On a video frame the union at offset 28 is `state_bits`, never the
      // audio power float (spec 2.1), so it is safe to keep as an integer.
      sink.video(si, payloadPos, datasize, timestamp, utc, flags, dio, stateBits)
    }

    frames++
    pos = next

    if (pos >= nextProgress) {
      nextProgress = pos + progressStep
      if (onProgress) onProgress(pos)
      if (yieldToUi) await yieldToUi()
    }
  }

  return { pos, frames, resyncs, truncated }
}

/**
 * Corruption recovery (spec section 10): hunt forward from just after `from` for
 * the next `BLUE` whose frame is complete and is itself followed by a plausible
 * frame.
 *
 * `BLUE` occurs inside compressed payloads often enough that the completeness
 * test alone is not enough, so the follower is checked too -- the stricter of
 * the two tests the spec offers.
 */
export async function resync (reader, fileSize, from, window = 1 << 20) {
  const WINDOW = window
  let at = from + 1
  while (at + FRAME_HEADER_SIZE <= fileSize) {
    const len = Math.min(WINDOW, fileSize - at)
    // Own copy: the nested look-ahead read below would invalidate a shared view.
    const bytes = await reader.readCopy(at, len)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i + FRAME_HEADER_SIZE <= len; i++) {
      if (view.getUint32(i, true) !== SIGNATURE) continue
      const hdr = readFrameHeader(view, i)
      const abs = at + i
      const end = abs + FRAME_HEADER_SIZE + hdr.postbytes + hdr.datasize
      if (end > fileSize) continue
      if (end === fileSize) return abs
      const nextView = await reader.read(end, 4)
      if (nextView.getUint32(0, true) === SIGNATURE) return abs
    }
    at += Math.max(1, len - FRAME_HEADER_SIZE)
  }
  return -1
}

/**
 * The first frame at or after `from`, for a reader that is starting in the
 * middle of a file rather than recovering from damage.
 *
 * Seeking into a stretch that has never been indexed lands on a byte offset
 * estimated from the clock, which is almost never a frame boundary -- so the
 * same signature hunt that recovers from corruption is also what makes
 * random access possible at all. The only difference is that `from` itself is a
 * candidate here, where a resynchronising reader has already rejected it.
 */
export async function findFrameFrom (reader, fileSize, from, window = 256 << 10) {
  let at = Math.max(0, Math.floor(from))
  // A smaller hunting window than the corruption path uses. Landing on a frame
  // boundary by chance is vanishingly unlikely, so this runs on essentially
  // every random-access probe -- and over a network the window is what each
  // probe costs. One block is more than a frame is long in all but the largest
  // key frames, and the loop simply takes another window when it is not.
  //
  // `from` itself is a candidate, which is the only thing separating this from
  // `resync`. Testing it with its own short read first would look cheaper and is
  // not: a window starting at `from` and a window starting at `from + 1` are
  // different windows to a block cache, so the pair costs two fetches to answer
  // what one window answers on its own.
  while (at + FRAME_HEADER_SIZE <= fileSize) {
    const len = Math.min(window, fileSize - at)
    const bytes = await reader.readCopy(at, len)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i + FRAME_HEADER_SIZE <= len; i++) {
      if (view.getUint32(i, true) !== SIGNATURE) continue
      const hdr = readFrameHeader(view, i)
      const abs = at + i
      const end = abs + FRAME_HEADER_SIZE + hdr.postbytes + hdr.datasize
      if (end > fileSize) continue
      if (end === fileSize) return abs
      // The follower is what separates a real header from the same four bytes
      // occurring inside a slice; it is usually inside the window already.
      if (end + 4 <= at + len) {
        if (view.getUint32(end - at, true) === SIGNATURE) return abs
        continue
      }
      const nextView = await reader.read(end, 4)
      if (nextView.getUint32(0, true) === SIGNATURE) return abs
    }
    at += Math.max(1, len - FRAME_HEADER_SIZE)
  }
  return -1
}
