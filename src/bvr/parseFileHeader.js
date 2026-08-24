import {
  FLAG_SUBSTREAM, FLAG_MAINAVAILABLE, FLAG_ISHEADER, FLAG_FLIPH, SIGNATURE,
  FRAME_HEADER_SIZE, WAVE_FORMAT_PCM, fourccToString
} from './constants.js'

export class BvrFormatError extends Error {}

/** Parses the 16-byte frame header (+ optional 16-byte extension) at `off`. */
export function readFrameHeader (view, off) {
  const id = view.getUint32(off, true)
  if (id !== SIGNATURE) return null
  const flags = view.getUint16(off + 4, true)
  const postbytes = view.getUint16(off + 6, true)
  const timestamp = view.getUint32(off + 8, true)
  const datasize = view.getUint32(off + 12, true)
  let utc = 0
  let dio = 0
  let stateBits = 0
  if (postbytes >= 16 && off + 32 <= view.byteLength) {
    // getBigUint64 -> Number is exact: unix-ms fits comfortably in a double.
    utc = Number(view.getBigUint64(off + 16, true))
    dio = view.getUint32(off + 24, true)
    stateBits = view.getUint32(off + 28, true)
  }
  return { flags, postbytes, timestamp, datasize, utc, dio, stateBits }
}

function parseWaveFormatEx (view, off) {
  const wFormatTag = view.getUint16(off, true)
  const wfx = {
    wFormatTag,
    nChannels: view.getUint16(off + 2, true),
    nSamplesPerSec: view.getUint32(off + 4, true),
    nAvgBytesPerSec: view.getUint32(off + 8, true),
    nBlockAlign: view.getUint16(off + 12, true),
    wBitsPerSample: view.getUint16(off + 14, true),
    // Spec 4.2: cbSize is only meaningful when wFormatTag > WAVE_FORMAT_PCM.
    cbSize: wFormatTag > WAVE_FORMAT_PCM ? view.getUint16(off + 16, true) : 0
  }
  return wfx
}

function parseBitmapInfoHeader (view, off) {
  const biCompression = view.getUint32(off + 16, true)
  return {
    biSize: view.getUint32(off, true),
    biWidth: view.getInt32(off + 4, true),
    biHeight: view.getInt32(off + 8, true),
    biCompression,
    fourcc: fourccToString(biCompression),
    width: Math.abs(view.getInt32(off + 4, true)),
    height: Math.abs(view.getInt32(off + 8, true))
  }
}

function parseRect (view, off) {
  return {
    left: view.getInt32(off, true),
    top: view.getInt32(off + 4, true),
    right: view.getInt32(off + 8, true),
    bottom: view.getInt32(off + 12, true)
  }
}

/**
 * Reads and parses frame 0, the stream-configuration header (spec section 4).
 * Returns everything a player needs to set up decoders, plus the byte offset of
 * frame 1.
 */
export async function parseFileHeader (reader) {
  if (reader.size < FRAME_HEADER_SIZE) throw new BvrFormatError('File is too small to be a BVR recording.')
  const head = await reader.read(0, Math.min(reader.size, 64))
  const hdr = readFrameHeader(head, 0)
  if (!hdr) throw new BvrFormatError('Not a BVR file: the first four bytes are not "BLUE".')
  if (!(hdr.flags & FLAG_ISHEADER)) throw new BvrFormatError('Frame 0 is missing the ISHEADER flag.')

  const payloadOffset = FRAME_HEADER_SIZE + hdr.postbytes
  const frameSize = payloadOffset + hdr.datasize
  if (frameSize > reader.size) throw new BvrFormatError('The BVR header frame is truncated.')

  const view = await reader.read(0, frameSize)
  let p = payloadOffset
  const end = payloadOffset + hdr.datasize

  const wfx = parseWaveFormatEx(view, p)
  p += 18
  let audioExtradata = null
  if (wfx.cbSize > 0 && p + wfx.cbSize <= end) {
    audioExtradata = new Uint8Array(view.buffer.slice(view.byteOffset + p, view.byteOffset + p + wfx.cbSize))
    p += wfx.cbSize
  }

  const hasSub = !!(hdr.flags & FLAG_SUBSTREAM)
  const bmihMain = parseBitmapInfoHeader(view, p)
  p += 40
  let bmihSub = null
  if (hasSub) {
    bmihSub = parseBitmapInfoHeader(view, p)
    p += 40
  }

  // Spec 4.4 -- the extra block is optional and forward-extensible.
  let extra = end - p
  const aoi = [null, null]
  let mask = null
  if (extra >= 32) {
    aoi[0] = parseRect(view, p)
    aoi[1] = parseRect(view, p + 16)
    p += 32
    extra -= 32
  }
  if (extra >= 16) {
    const tag = view.getUint32(p, true)
    const len = view.getUint32(p + 4, true)
    if ((tag & 0xff00) === 0x1200 && 8 + len <= extra && len >= 8) {
      mask = {
        showMotionFlags: tag & 0xff,
        width: view.getUint32(p + 8, true),
        height: view.getUint32(p + 12, true),
        bits: new Uint8Array(view.buffer.slice(view.byteOffset + p + 16, view.byteOffset + p + 8 + len))
      }
    }
    // Skip regardless of whether the tag check passed (spec 4.4 step 2).
    p += 8 + len
  }

  const rotateBits = (hdr.flags >> 8) & 0x03
  const hasAudio = wfx.nSamplesPerSec * wfx.nBlockAlign !== 0

  return {
    frameInterval: hdr.timestamp,                     // microseconds
    fps: hdr.timestamp > 0 ? 1e6 / hdr.timestamp : 0, // nominal only
    startUtc: hdr.utc,
    flags: hdr.flags,
    rotation: rotateBits * 90,
    flipH: !!(hdr.flags & FLAG_FLIPH),
    hasSubHeader: hasSub,
    switchingMode: hasSub && !!(hdr.flags & FLAG_MAINAVAILABLE),
    wfx,
    audioExtradata,
    hasAudio,
    bmih: [bmihMain, bmihSub],
    aoi,
    mask,
    firstFrameOffset: frameSize
  }
}
