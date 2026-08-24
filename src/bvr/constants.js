// Frame flag bits (BVR spec section 3).
export const FLAG_ISKEY = 0x0001
export const FLAG_ISAUDIO = 0x0002
export const FLAG_ISMETADATA = 0x0004
export const FLAG_SUBSTREAM = 0x0010
export const FLAG_ISHEADER = 0x0020
export const FLAG_MARK = 0x0040
export const FLAG_MAINAVAILABLE = 0x0080
export const FLAG_STREAMFLAGS = FLAG_ISAUDIO | FLAG_ISMETADATA | FLAG_SUBSTREAM

// Header-frame orientation bits (spec section 3.1). Rotation is the 2-bit field
// at 0x0300, read as (flags >> 8) & 3.
export const FLAG_FLIPH = 0x0400

// 'BLUE' read as a little-endian uint32.
export const SIGNATURE = 0x45554c42

export const FRAME_HEADER_SIZE = 16

// wfx.wFormatTag values we understand (spec section 4.2).
export const WAVE_FORMAT_PCM = 1
export const WAVE_FORMAT_MULAW = 7
export const WAVE_FORMAT_FLAC = 0xf1ac

export const STREAM_MAIN = 0
export const STREAM_SUB = 1

export function fourccToString (v) {
  return String.fromCharCode(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
}
