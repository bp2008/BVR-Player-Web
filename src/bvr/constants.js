// Frame flag bits (BVR spec section 3).
export const FLAG_ISKEY = 0x0001
export const FLAG_ISAUDIO = 0x0002
export const FLAG_ISMETADATA = 0x0004
export const FLAG_ISDISCONTINUITY = 0x0008
export const FLAG_SUBSTREAM = 0x0010
export const FLAG_ISHEADER = 0x0020
export const FLAG_MARK = 0x0040
export const FLAG_MAINAVAILABLE = 0x0080
export const FLAG_STREAMFLAGS = FLAG_ISAUDIO | FLAG_ISMETADATA | FLAG_SUBSTREAM

// Header-frame orientation bits (spec section 3.1). Rotation is the 2-bit field
// at 0x0300, read as (flags >> 8) & 3.
export const FLAG_FLIPH = 0x0400

// Per-frame camera state (spec section 2.3). Overlay objects carry the same bit
// layout in their `stateflags` as the "Require ..." conditions.
export const STATE_TRIGGERED = 0x1
export const STATE_OVERLAY = 0x2
export const STATE_RECORDING = 0x4
export const STATE_ALERTED = 0x8

export const STATE_BIT_NAMES = [
  [STATE_TRIGGERED, 'triggered'],
  [STATE_OVERLAY, 'overlay'],
  [STATE_RECORDING, 'recording'],
  [STATE_ALERTED, 'alerted']
]

// Motion-mask flag byte, the low 8 bits of the extra block's tag (spec 4.4).
export const MASK_HIGHLIGHT = 0x01
export const MASK_RECTANGLES = 0x02
export const MASK_BLACKOUT = 0x04
export const MASK_TRIGGERED_ONLY = 0x08
export const MASK_OBSCURE = 0x10

export const MASK_FLAG_NAMES = [
  [MASK_HIGHLIGHT, 'highlight'],
  [MASK_RECTANGLES, 'rectangles'],
  [MASK_BLACKOUT, 'blackout'],
  [MASK_TRIGGERED_ONLY, 'triggered only'],
  [MASK_OBSCURE, 'obscure']
]

// 'BLUE' read as a little-endian uint32.
export const SIGNATURE = 0x45554c42

export const FRAME_HEADER_SIZE = 16

// wfx.wFormatTag values we understand (spec section 4.2). A-law never appears in
// a BVR file; it is here because an MP4 audio track may carry it, and describing
// it with the same tag keeps one audio path rather than two.
export const WAVE_FORMAT_PCM = 1
export const WAVE_FORMAT_ALAW = 6
export const WAVE_FORMAT_MULAW = 7
export const WAVE_FORMAT_FLAC = 0xf1ac

export const STREAM_MAIN = 0
export const STREAM_SUB = 1

export function fourccToString (v) {
  return String.fromCharCode(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
}
