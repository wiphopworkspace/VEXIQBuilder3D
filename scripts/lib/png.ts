/**
 * Minimal PNG read/write, for the icon pipeline.
 *
 * `node:zlib` already ships the hard part; what is left is chunk walking, the
 * five scanline filters, and a CRC — about 150 lines against a raster
 * dependency, its transitive tree, and a native build step on a Windows
 * machine. The same reasoning as `scripts/lib/glb.ts`: this repo reads the
 * formats it needs rather than importing a reader for each one.
 *
 * Deliberately partial. It handles what the icon source actually is — 8-bit,
 * non-interlaced, colour type 0/2/3/4/6 — and throws with a specific message on
 * anything else, instead of decoding it half-right. A 16-bit or interlaced PNG
 * is a real thing; silently mangling one is worse than refusing it.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import fs from 'node:fs'

export type Raster = {
  width: number
  height: number
  /** RGBA, 8 bits per channel, row-major, NOT premultiplied. */
  data: Uint8ClampedArray
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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

/** Paeth predictor, straight from the PNG spec. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(file: string): Raster {
  const buf = fs.readFileSync(file)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`${file} is not a PNG`)
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  let palette: Buffer | null = null
  let transparency: Buffer | null = null

  let offset = 8
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') transparency = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    offset += 12 + length
  }

  if (bitDepth !== 8) {
    throw new Error(`${file}: only 8-bit PNGs are supported (got ${bitDepth})`)
  }
  if (interlace !== 0) {
    throw new Error(`${file}: interlaced PNGs are not supported`)
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`${file}: unsupported colour type ${colorType}`)
  if (colorType === 3 && !palette) throw new Error(`${file}: indexed PNG with no PLTE`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)

  // Un-filter in place, row by row: every filter refers to the raw byte to the
  // left and to the ALREADY-UNFILTERED byte above.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const value = raw[rowStart + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft =
        y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      let out: number
      switch (filter) {
        case 0:
          out = value
          break
        case 1:
          out = value + left
          break
        case 2:
          out = value + up
          break
        case 3:
          out = value + ((left + up) >> 1)
          break
        case 4:
          out = value + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`${file}: unknown scanline filter ${filter} on row ${y}`)
      }
      pixels[y * stride + x] = out & 0xff
    }
  }

  // Expand whatever it was into straight RGBA.
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * channels
    const d = i * 4
    if (colorType === 6) {
      data[d] = pixels[s]
      data[d + 1] = pixels[s + 1]
      data[d + 2] = pixels[s + 2]
      data[d + 3] = pixels[s + 3]
    } else if (colorType === 2) {
      data[d] = pixels[s]
      data[d + 1] = pixels[s + 1]
      data[d + 2] = pixels[s + 2]
      data[d + 3] = 255
    } else if (colorType === 0) {
      data[d] = data[d + 1] = data[d + 2] = pixels[s]
      data[d + 3] = 255
    } else if (colorType === 4) {
      data[d] = data[d + 1] = data[d + 2] = pixels[s]
      data[d + 3] = pixels[s + 1]
    } else {
      const index = pixels[s]
      data[d] = palette![index * 3]
      data[d + 1] = palette![index * 3 + 1]
      data[d + 2] = palette![index * 3 + 2]
      data[d + 3] = transparency && index < transparency.length ? transparency[index] : 255
    }
  }

  return { width, height, data }
}

export function encodePng(raster: Raster): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(raster.width, 0)
  ihdr.writeUInt32BE(raster.height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // ADAPTIVE filtering, the standard minimum-sum-of-absolute-differences
  // heuristic: try all five filters on each row and keep the one whose output
  // bytes are closest to zero, which is what deflate compresses best. Measured
  // on the app artwork: 512x512 goes 274 kB -> 218 kB, the 192 favicon
  // 44.1 kB -> 37.7 kB. Not dramatic on a gradient-heavy source, but the 192 is
  // fetched on every page load and this is thirty lines with no dependency.
  const bpp = 4
  const stride = raster.width * bpp
  const source = Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.length)
  const rawBuf = Buffer.alloc((stride + 1) * raster.height)
  const candidate = Buffer.alloc(stride)
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < raster.height; y++) {
    const row = source.subarray(y * stride, (y + 1) * stride)
    let bestFilter = 0
    let bestScore = Infinity
    let bestRow = Buffer.alloc(stride)

    for (let filter = 0; filter < 5; filter++) {
      let score = 0
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? row[x - bpp] : 0
        const up = previous[x]
        const upLeft = x >= bpp ? previous[x - bpp] : 0
        let value: number
        switch (filter) {
          case 0:
            value = row[x]
            break
          case 1:
            value = row[x] - left
            break
          case 2:
            value = row[x] - up
            break
          case 3:
            value = row[x] - ((left + up) >> 1)
            break
          default:
            value = row[x] - paeth(left, up, upLeft)
        }
        candidate[x] = value & 0xff
        // Signed magnitude: a byte of 0xff is -1, i.e. a very good prediction.
        score += candidate[x] < 128 ? candidate[x] : 256 - candidate[x]
      }
      if (score < bestScore) {
        bestScore = score
        bestFilter = filter
        candidate.copy(bestRow)
      }
    }

    rawBuf[y * (stride + 1)] = bestFilter
    bestRow.copy(rawBuf, y * (stride + 1) + 1)
    previous = Buffer.from(row)
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawBuf, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Tight bounding box of pixels with alpha above `threshold`, or null if none. */
export function opaqueBounds(
  raster: Raster,
  threshold = 8,
): { x: number; y: number; w: number; h: number } | null {
  let minX = raster.width
  let minY = raster.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (raster.data[(y * raster.width + x) * 4 + 3] <= threshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

export function crop(
  raster: Raster,
  box: { x: number; y: number; w: number; h: number },
): Raster {
  const out = new Uint8ClampedArray(box.w * box.h * 4)
  for (let y = 0; y < box.h; y++) {
    const from = ((box.y + y) * raster.width + box.x) * 4
    out.set(raster.data.subarray(from, from + box.w * 4), y * box.w * 4)
  }
  return { width: box.w, height: box.h, data: out }
}

/**
 * Area-average resample to an exact size.
 *
 * Alpha-weighted, which is the difference between a clean edge and a dark
 * halo: averaging the colour of a transparent pixel (whose RGB is arbitrary)
 * into its opaque neighbours is what produces the grey fringe you see around
 * naively downscaled logos.
 */
export function resize(raster: Raster, width: number, height: number): Raster {
  const out = new Uint8ClampedArray(width * height * 4)
  const scaleX = raster.width / width
  const scaleY = raster.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * scaleY))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * scaleX))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < Math.min(y1, raster.height); sy++) {
        for (let sx = x0; sx < Math.min(x1, raster.width); sx++) {
          const i = (sy * raster.width + sx) * 4
          const alpha = raster.data[i + 3]
          r += raster.data[i] * alpha
          g += raster.data[i + 1] * alpha
          b += raster.data[i + 2] * alpha
          a += alpha
          n += 1
        }
      }
      const o = (y * width + x) * 4
      out[o] = a > 0 ? r / a : 0
      out[o + 1] = a > 0 ? g / a : 0
      out[o + 2] = a > 0 ? b / a : 0
      out[o + 3] = n > 0 ? a / n : 0
    }
  }
  return { width, height, data: out }
}

/** New opaque canvas filled with `rgb`. */
export function canvas(size: number, rgb?: [number, number, number]): Raster {
  const data = new Uint8ClampedArray(size * size * 4)
  if (rgb) {
    for (let i = 0; i < size * size; i++) {
      data[i * 4] = rgb[0]
      data[i * 4 + 1] = rgb[1]
      data[i * 4 + 2] = rgb[2]
      data[i * 4 + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

/** Source-over composite of `src` onto `dst` at (dx, dy). */
export function composite(dst: Raster, src: Raster, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y
    if (ty < 0 || ty >= dst.height) continue
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x
      if (tx < 0 || tx >= dst.width) continue
      const s = (y * src.width + x) * 4
      const d = (ty * dst.width + tx) * 4
      const sa = src.data[s + 3] / 255
      if (sa <= 0) continue
      const da = dst.data[d + 3] / 255
      const outA = sa + da * (1 - sa)
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] =
          outA > 0
            ? (src.data[s + c] * sa + dst.data[d + c] * da * (1 - sa)) / outA
            : 0
      }
      dst.data[d + 3] = outA * 255
    }
  }
}
