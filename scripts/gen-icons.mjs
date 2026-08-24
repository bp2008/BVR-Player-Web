// Generates the PWA icon PNGs with no image dependencies: rasterise into an
// RGBA buffer, then emit a minimal PNG (IHDR / IDAT / IEND) using node:zlib.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng (rgba, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const lerp = (a, b, t) => a + (b - a) * t
const mixColor = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

/** Signed distance to a rounded rectangle centred on the origin. */
function sdRoundRect (x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - (halfW - r)
  const qy = Math.abs(y) - (halfH - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function insideTriangle (x, y, p) {
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)
  const d1 = sign(x, y, p[0][0], p[0][1], p[1][0], p[1][1])
  const d2 = sign(x, y, p[1][0], p[1][1], p[2][0], p[2][1])
  const d3 = sign(x, y, p[2][0], p[2][1], p[0][0], p[0][1])
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

const BG_TOP = [0x1a, 0x27, 0x40]
const BG_BOTTOM = [0x08, 0x0e, 0x18]
const MARK_TOP = [0x8a, 0xc8, 0xff]
const MARK_BOTTOM = [0x3f, 0x8d, 0xf0]

/**
 * @param size    output edge length in pixels
 * @param bleed   true for the maskable variant: square background, inset mark
 */
function renderIcon (size, bleed) {
  const SS = 4 // supersampling factor per axis
  const rgba = new Uint8Array(size * size * 4)
  const corner = bleed ? 0 : 0.225
  const triScale = bleed ? 0.72 : 1
  const tri = [
    [-0.155 * triScale, -0.235 * triScale],
    [-0.155 * triScale, 0.235 * triScale],
    [0.235 * triScale, 0]
  ]

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Normalised coordinates in [-0.5, 0.5].
          const nx = (px + (sx + 0.5) / SS) / size - 0.5
          const ny = (py + (sy + 0.5) / SS) / size - 0.5
          const inShape = bleed || sdRoundRect(nx, ny, 0.5, 0.5, corner) <= 0
          if (!inShape) continue
          const t = ny + 0.5
          let color = mixColor(BG_TOP, BG_BOTTOM, t)
          if (insideTriangle(nx, ny, tri)) {
            color = mixColor(MARK_TOP, MARK_BOTTOM, t)
          }
          r += color[0]
          g += color[1]
          b += color[2]
          a += 255
        }
      }
      const n = SS * SS
      const o = (py * size + px) * 4
      const cover = a / (255 * n)
      rgba[o] = cover > 0 ? Math.round(r / (n * cover)) : 0
      rgba[o + 1] = cover > 0 ? Math.round(g / (n * cover)) : 0
      rgba[o + 2] = cover > 0 ? Math.round(b / (n * cover)) : 0
      rgba[o + 3] = Math.round(a / n)
    }
  }
  return encodePng(rgba, size, size)
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a2740"/>
      <stop offset="1" stop-color="#080e18"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8ac8ff"/>
      <stop offset="1" stop-color="#3f8df0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" ry="115" fill="url(#bg)"/>
  <path d="M176 135 L176 377 L376 256 Z" fill="url(#mark)"/>
</svg>
`

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'icon.svg'), SVG)
for (const size of [192, 512]) {
  writeFileSync(resolve(OUT_DIR, `icon-${size}.png`), renderIcon(size, false))
}
writeFileSync(resolve(OUT_DIR, 'icon-maskable-512.png'), renderIcon(512, true))
console.log(`icons written to ${OUT_DIR}`)
