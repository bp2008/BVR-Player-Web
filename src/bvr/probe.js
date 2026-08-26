import { ScanReader } from './scanReader.js'
import { describeVideoCodec } from './codec.js'
import {
  FLAG_ISAUDIO, FLAG_ISHEADER, FLAG_ISKEY, FLAG_ISMETADATA, FLAG_SUBSTREAM,
  FLAG_STREAMFLAGS, FRAME_HEADER_SIZE, SIGNATURE, STREAM_MAIN, STREAM_SUB
} from './constants.js'

// A recording opens on a key frame, so in practice both streams reveal
// themselves within the first few tens of kilobytes. These bounds only matter
// for oddly shaped files: keep looking until every stream seen so far has
// produced a key frame and there has been room for a second stream to appear,
// then give up entirely once the budget is spent.
const PROBE_SETTLE = 1 << 20
const PROBE_BUDGET = 16 << 20

// Parameter sets live at the front of a key frame; this is far more than enough.
const KEY_SAMPLE = 64 << 10

const STREAM_NAMES = ['main', 'sub']

/**
 * Walks frames from the start until the first key frame of each stream is known.
 *
 * Exported because a thumbnail wants exactly this and nothing else -- one key
 * frame, without the decoder-support interrogation the full probe performs.
 */
export async function findFirstKeys (reader, header) {
  const fileSize = reader.size
  const scan = new ScanReader(reader.blob, { chunkSize: 1 << 20, depth: 2 })
  const keys = [null, null]
  const seen = [false, false]
  let pos = header.firstFrameOffset
  const stopAt = Math.min(fileSize, pos + PROBE_BUDGET)
  const settleAt = pos + PROBE_SETTLE

  // A pared-back copy of the indexer's frame walk rather than shared code: the
  // indexer's version runs once per frame across the whole file, and wrapping it
  // in a generator to serve both callers would put a generator resume in that
  // loop for the sake of the few hundred frames read here.
  try {
    while (pos + FRAME_HEADER_SIZE <= fileSize && pos < stopAt) {
      const need = Math.min(32, fileSize - pos)
      let at = scan.offsetOf(pos, need)
      if (at < 0) {
        await scan.seek(pos)
        at = scan.offsetOf(pos, need)
        if (at < 0) break
      }
      const view = scan.view
      if (view.getUint32(at, true) !== SIGNATURE) break

      const flags = view.getUint16(at + 4, true)
      const postbytes = view.getUint16(at + 6, true)
      const datasize = view.getUint32(at + 12, true)
      const payloadPos = pos + FRAME_HEADER_SIZE + postbytes
      const next = payloadPos + datasize
      if (next > fileSize) break

      if (!(flags & (FLAG_ISHEADER | FLAG_ISMETADATA | FLAG_ISAUDIO))) {
        const si = (flags & FLAG_STREAMFLAGS) === FLAG_SUBSTREAM ? STREAM_SUB : STREAM_MAIN
        seen[si] = true
        if ((flags & FLAG_ISKEY) && !keys[si]) keys[si] = { offset: payloadPos, size: datasize }
      }

      pos = next

      const settled = (!seen[0] || keys[0]) && (!seen[1] || keys[1]) &&
        (seen[0] || seen[1]) && pos >= settleAt
      if (settled) break
    }
  } finally {
    scan.release()
  }
  return { keys, seen }
}

/**
 * Whether this device can decode what a codec description names.
 *
 * Exported because the MP4 layer reaches the same question from the other
 * direction -- it reads the codec out of a sample entry rather than out of a key
 * frame -- and the verdict, and the wording of a refusal, should not depend on
 * which container asked.
 */
export async function checkCodecSupport (codec) {
  if (codec.kind === 'image') return { supported: true, reason: '' }
  if (codec.kind === 'unsupported') {
    return { supported: false, reason: `${codec.label} is not a format browsers can decode.` }
  }
  if (typeof VideoDecoder === 'undefined') {
    return { supported: false, reason: 'This browser has no WebCodecs support (VideoDecoder).' }
  }
  try {
    const res = await VideoDecoder.isConfigSupported(codec.config)
    if (res && res.supported) return { supported: true, reason: '' }
    return { supported: false, reason: `This device cannot decode ${codec.label}.` }
  } catch (e) {
    const why = e && e.message ? ` (${e.message})` : ''
    return { supported: false, reason: `This device cannot decode ${codec.label}${why}.` }
  }
}

/** Reads a stream's first key frame and decides whether it can be played here. */
async function describeStream (reader, header, si, key) {
  // Spec 4.3: a sub-only file may carry no second BITMAPINFOHEADER at all.
  const bmih = header.bmih[si] || header.bmih[0]
  let keyBytes = null
  if (key) keyBytes = await reader.readCopy(key.offset, Math.min(key.size, KEY_SAMPLE))
  const codec = describeVideoCodec(bmih?.fourcc || '', keyBytes, bmih)
  const { supported, reason } = await checkCodecSupport(codec)
  return {
    name: STREAM_NAMES[si],
    present: true,
    hasKeyFrame: !!key,
    fourcc: bmih?.fourcc || '',
    // What the pictures are, from the bitstream where it could be read.
    width: codec.width,
    height: codec.height,
    // What the header says they are. The two disagree more often than not on a
    // Blue Iris sub stream, and the difference is the whole of §"Match stream
    // shapes" -- see BvrPlayer._targetAspect.
    declaredWidth: codec.declaredWidth,
    declaredHeight: codec.declaredHeight,
    codec,
    supported,
    reason
  }
}

/** Rolls per-stream verdicts up into the one the UI and the caller act on. */
export function summarizeProbe (streams) {
  const present = streams.filter(Boolean)
  const playable = present.filter((s) => s.supported)
  let summary = ''
  if (!present.length) summary = 'This file contains no video frames.'
  else if (!playable.length) {
    // One message per distinct complaint, so a two-stream file does not repeat itself.
    summary = [...new Set(present.map((s) => s.reason))].join(' ')
  }
  return {
    streams,
    anyPresent: present.length > 0,
    anySupported: playable.length > 0,
    someUnsupported: playable.length > 0 && playable.length < present.length,
    // Only a verdict read off a real key frame is firm enough to refuse a file
    // on. Without one the codec string is a guess, and a file whose opening
    // frames are corrupt deserves the indexer's resynchronisation before any
    // conclusion is drawn.
    decided: present.length > 0 && present.every((s) => s.hasKeyFrame),
    summary
  }
}

/**
 * Works out what each video stream is, and whether this device can decode it,
 * from the first key frames alone.
 *
 * This runs before the index scan on purpose. Indexing reads every byte of the
 * file, and on a machine with no HEVC decoder there is nothing to be gained by
 * reading a gigabyte before admitting the video will not play. Each stream is
 * judged on its own, so a file whose main stream is undecodable here can still
 * play from its sub stream.
 */
export async function probeVideoStreams (reader, header) {
  const { keys, seen } = await findFirstKeys(reader, header)
  const streams = [null, null]
  for (let si = 0; si < 2; si++) {
    if (seen[si]) streams[si] = await describeStream(reader, header, si, keys[si])
  }
  return summarizeProbe(streams)
}

/**
 * Judges a stream the opening probe never reached -- one whose frames begin
 * only well into the file. The finished index points straight at its first key
 * frame, so this costs a single short read.
 */
export async function probeIndexedStream (reader, header, index, si) {
  const s = index.streams[si]
  if (!s || s.count === 0) return null
  const ki = s.keys.length ? s.keys[0] : -1
  const key = ki >= 0 ? { offset: s.offset[ki], size: s.size[ki] } : null
  return describeStream(reader, header, si, key)
}
