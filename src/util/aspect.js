/**
 * Putting a picture back into the shape its recording claims.
 *
 * Blue Iris writes the resolution it asked each camera for into the file header
 * (spec 4.3), and cameras do not always oblige: a sub stream declared 640x480
 * and encoded 704x480 is ordinary output. The header's shape is the field of
 * view the recording claims, so it is the one everything is shown in -- on the
 * canvas during playback, and in whatever an export writes.
 *
 * The rule lives here rather than in either of those places because they have to
 * agree: an exported clip that plays at a different shape from the one the
 * player showed would be a worse bug than the one this exists to fix.
 */

// Encoders round to macroblocks, and re-shaping a picture that is already the
// right shape only costs sharpness.
const SLACK = 0.01

/** Whether a coded size disagrees with the reference enough to be worth fixing. */
export function needsCorrection (width, height, target) {
  if (!(target > 0) || !(width > 0) || !(height > 0)) return false
  return Math.abs(width / height - target) > target * SLACK
}

/**
 * The size a coded picture should be shown at, given a target aspect ratio.
 *
 * The short axis is stretched rather than the long one cropped. Cropping would
 * discard picture the recording does contain, and a mismatched surveillance
 * stream is squeezed rather than cropped in the first place -- undoing the
 * squeeze is exactly what restores it.
 */
export function correctedSize (width, height, target) {
  if (!needsCorrection(width, height, target)) return { width, height }
  return width / height < target
    ? { width: height * target, height }
    : { width, height: width / target }
}

/** Same, rounded to whole pixels, which is what anything outside a canvas wants. */
export function displaySize (width, height, target) {
  const out = correctedSize(width, height, target)
  return { width: Math.round(out.width), height: Math.round(out.height) }
}

function gcd (a, b) {
  while (b) { const t = a % b; a = b; b = t }
  return a
}

/**
 * The MP4 `pasp` pixel aspect ratio that makes a coded picture display in the
 * reference shape, or null when the pixels are already square enough to leave
 * unsaid.
 *
 * `reference` is kept as the header's two integers rather than reduced to a
 * ratio first, because the spacings are then exact: a 704x480 stream under a
 * 1600x1200 header comes out 10:11, which is the textbook NTSC D1 value, where
 * going through a float would have produced whatever six-figure pair the
 * rounding happened to land on.
 */
export function pixelAspect (width, height, reference) {
  if (!reference) return null
  if (!needsCorrection(width, height, reference.width / reference.height)) return null
  const h = reference.width * height
  const v = reference.height * width
  if (!(h > 0) || !(v > 0)) return null
  const g = gcd(h, v) || 1
  const hSpacing = h / g
  const vSpacing = v / g
  // The box's fields are 32-bit; a ratio that will not fit is a ratio no player
  // was going to honour anyway.
  if (hSpacing > 0xffffffff || vSpacing > 0xffffffff) return null
  if (hSpacing === vSpacing) return null
  return { hSpacing, vSpacing }
}
