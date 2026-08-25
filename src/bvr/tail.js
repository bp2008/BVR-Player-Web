import {
  FLAG_ISAUDIO, FLAG_ISHEADER, FLAG_ISMETADATA, FRAME_HEADER_SIZE, SIGNATURE
} from './constants.js'
import { readFrameHeader } from './parseFileHeader.js'

/**
 * Finds the last complete video frame by reading backwards from the end of the
 * file (spec section 9.3).
 *
 * The player proper never needs this -- it scans the whole file and knows every
 * frame -- but the folder browser wants a clip's length for a few hundred files
 * at once, and reading them all end to end to get it would be absurd. Two short
 * reads per file settle it instead: the header frame at the front, and this.
 *
 * "BLUE" also occurs inside compressed payloads, so a candidate is accepted only
 * when its frame is complete and is itself followed by another signature or by
 * end of file -- the stricter of the two tests the spec offers.
 */

const WINDOW = 64 << 10
const OVERLAP = 64
// A frame at the very end is found in the first window; this only bounds how
// long a badly truncated tail is hunted through.
const MAX_SEARCH = 8 << 20

export async function findLastFrame (reader, header) {
  const size = reader.size
  const floor = Math.max(header ? header.firstFrameOffset : 0, size - MAX_SEARCH)
  let end = size

  while (end > floor) {
    const start = Math.max(floor, end - WINDOW)
    const length = end - start
    if (length < FRAME_HEADER_SIZE) break
    const bytes = await reader.readCopy(start, length)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    for (let i = length - FRAME_HEADER_SIZE; i >= 0; i--) {
      if (view.getUint32(i, true) !== SIGNATURE) continue
      const hdr = readFrameHeader(view, i)
      if (!hdr) continue
      const at = start + i
      const frameEnd = at + FRAME_HEADER_SIZE + hdr.postbytes + hdr.datasize
      if (frameEnd > size) continue
      if (frameEnd < size) {
        // Confirm the follower, which is what separates a real frame header
        // from the same four bytes occurring inside a slice.
        const next = await reader.read(frameEnd, 4)
        if (next.getUint32(0, true) !== SIGNATURE) continue
      }
      if (hdr.flags & (FLAG_ISAUDIO | FLAG_ISMETADATA | FLAG_ISHEADER)) continue
      return { offset: at, ts: hdr.timestamp, utc: hdr.utc, flags: hdr.flags }
    }
    end = start + OVERLAP
    if (start === floor) break
  }
  return null
}
