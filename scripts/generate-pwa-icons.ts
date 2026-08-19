/**
 * Generate the PWA / home-screen icons (`npm run icons:pwa`).
 *
 * Written rather than drawn, and drawn in Node rather than pulled from a design
 * tool, for the same reason every other asset in this repo is generated: the
 * icon has to exist at four sizes with two different safe areas, and a
 * hand-exported set drifts the moment one of them is re-cut. Re-run this and
 * every size is rebuilt from the same 60 lines.
 *
 * No image dependency. PNG is a signature, three chunks and a zlib stream, and
 * `node:zlib` is already there — adding a raster library to draw a bar and
 * three circles would be the larger cost. Shapes are rendered at 4x and box-
 * downsampled, which is where the smooth edges come from.
 *
 * The mark is a VEX IQ beam: the accent-blue bar with three holes punched
 * through it. It reads at 48px on a home screen, which a wireframe robot or a
 * 3D render does not.
 *
 * Two safe areas, because the platforms crop differently:
 *  - `any` (192/512): rounded square with transparent corners — used as the
 *    browser tab favicon and by desktop installs, which do not re-mask.
 *  - `maskable` (512) and `apple-touch-icon` (180): FULL BLEED opaque, content
 *    inside the middle 80%. Android applies its own mask and iOS composites
 *    onto an opaque tile and rounds it; either will clip whatever sits in the
 *    corners, and iOS turns transparency black.
 */
import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.resolve('public/icons')

// Straight from styles.css: --panel, --accent, --bg.
const PANEL: RGB = [0x17, 0x1a, 0x21]
const ACCENT: RGB = [0x1f, 0x6f, 0xeb]

type RGB = [number, number, number]

/** Supersampling factor. 4x is the point where the hole edges stop stairstepping. */
const SS = 4

type Canvas = { size: number; px: Uint8ClampedArray }

function canvas(size: number): Canvas {
  return { size, px: new Uint8ClampedArray(size * size * 4) }
}

function setPx(c: Canvas, x: number, y: number, rgb: RGB, a = 255) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return
  const i = (y * c.size + x) * 4
  c.px[i] = rgb[0]
  c.px[i + 1] = rgb[1]
  c.px[i + 2] = rgb[2]
  c.px[i + 3] = a
}

/** Filled rounded rectangle in device pixels. */
function roundedRect(
  c: Canvas,
  x0: number,
  y0: number,
  w: number,
  h: number,
  r: number,
  rgb: RGB,
) {
  const x1 = x0 + w
  const y1 = y0 + h
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      // Distance into the corner boxes; outside the radius means outside the shape.
      const dx = Math.max(x0 + r - x, x - (x1 - r), 0)
      const dy = Math.max(y0 + r - y, y - (y1 - r), 0)
      if (dx * dx + dy * dy <= r * r) setPx(c, x, y, rgb)
    }
  }
}

function circle(c: Canvas, cx: number, cy: number, r: number, rgb: RGB) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) setPx(c, x, y, rgb)
    }
  }
}

/** Box-downsample an SSxSS supersampled canvas to its final size. */
function downsample(src: Canvas, size: number): Canvas {
  const out = canvas(size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * src.size + (x * SS + sx)) * 4
          const alpha = src.px[i + 3]
          // Premultiply, so a transparent neighbour does not darken the edge.
          r += src.px[i] * alpha
          g += src.px[i + 1] * alpha
          b += src.px[i + 2] * alpha
          a += alpha
        }
      }
      const n = SS * SS
      const o = (y * size + x) * 4
      out.px[o] = a > 0 ? r / a : 0
      out.px[o + 1] = a > 0 ? g / a : 0
      out.px[o + 2] = a > 0 ? b / a : 0
      out.px[o + 3] = a / n
    }
  }
  return out
}

/**
 * The mark. `fullBleed` fills every pixel (maskable / apple-touch) instead of
 * rounding the tile, and shrinks the beam into the middle 80% so a platform
 * mask cannot crop a hole in half.
 */
function drawIcon(size: number, fullBleed: boolean): Canvas {
  const s = size * SS
  const c = canvas(s)

  if (fullBleed) {
    roundedRect(c, 0, 0, s, s, 0, PANEL)
  } else {
    roundedRect(c, 0, 0, s, s, s * 0.22, PANEL)
  }

  // Beam: 3 holes at VEX's own 0.5-pitch spacing, so the hole-to-hole gap and
  // the end margins are in the proportions of a real 1x3 beam.
  const inset = fullBleed ? 0.2 : 0.14
  const beamW = s * (1 - inset * 2)
  const beamH = beamW / 3
  const x0 = (s - beamW) / 2
  const y0 = (s - beamH) / 2
  roundedRect(c, x0, y0, beamW, beamH, beamH * 0.28, ACCENT)

  const holeR = beamH * 0.26
  for (let i = 0; i < 3; i++) {
    circle(c, x0 + beamW * ((i + 0.5) / 3), y0 + beamH / 2, holeR, PANEL)
  }

  return downsample(c, size)
}

// --------------------------------------------------------------- PNG writer
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

function encodePng(c: Canvas): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(c.size, 0)
  ihdr.writeUInt32BE(c.size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // One filter byte (0 = None) per scanline, then the raw RGBA row.
  const stride = c.size * 4
  const raw = Buffer.alloc((stride + 1) * c.size)
  for (let y = 0; y < c.size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(c.px.buffer, y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    )
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------------- output
const TARGETS: { file: string; size: number; fullBleed: boolean }[] = [
  { file: 'icon-192.png', size: 192, fullBleed: false },
  { file: 'icon-512.png', size: 512, fullBleed: false },
  { file: 'icon-maskable-512.png', size: 512, fullBleed: true },
  // iOS ignores the web manifest's icons for Add to Home Screen and uses this.
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true },
]

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const t of TARGETS) {
  const png = encodePng(drawIcon(t.size, t.fullBleed))
  fs.writeFileSync(path.join(OUT_DIR, t.file), png)
  console.log(`  wrote ${t.file}  ${t.size}x${t.size}  ${png.length} bytes`)
}
console.log(`\nicons:pwa wrote ${TARGETS.length} files to public/icons`)
