/**
 * Generate the PWA / home-screen icons from the app artwork (`npm run icons:pwa`).
 *
 * ONE source of truth: `assets/app-icon.png`. Every size below is derived from
 * it, so re-cutting the artwork means replacing that file and re-running this —
 * a hand-exported set drifts the moment one size is regenerated and the others
 * are not.
 *
 * No image dependency; `scripts/lib/png.ts` reads and writes the format and
 * `node:zlib` does the compression, the same way `scripts/lib/glb.ts` reads
 * GLBs rather than importing a loader.
 *
 * WHAT "FIT THE FRAME" MEANS HERE. The artwork arrives as a rounded-square mark
 * on a transparent field, and that field is not tight — measured on the current
 * source, 1254x1254 with the mark inset. Scaling the file as-is leaves the mark
 * floating inside a margin that the platform then adds its OWN margin to, and
 * the icon reads small on a home screen next to everything else. So the
 * transparent border is trimmed away first (`opaqueBounds`), and the trimmed
 * mark is what gets scaled — the mark itself ends up flush with the icon frame.
 *
 * Then two different safe areas, because the platforms crop differently:
 *
 *   `any` (192/512)  — the trimmed mark scaled to the FULL canvas. Its own
 *                      rounded corners stay, the corners outside them stay
 *                      transparent. This is the browser-tab favicon and what a
 *                      desktop install shows; neither re-masks.
 *
 *   `maskable` (512) — opaque background, mark inset to 75%. Android crops a
 *                      maskable icon to a shape of its own choosing (circle,
 *                      squircle, teardrop) and only guarantees the middle 80%,
 *                      so a mark drawn to the edge loses its corners. The
 *                      background is SAMPLED from the mark's own border ring,
 *                      so whatever the mask keeps still looks like one tile.
 *
 *   `apple-touch`    — opaque background, mark at full size. iOS ignores the
 *      (180)           manifest for Add to Home Screen, applies its own
 *                      superellipse mask, and renders transparency as BLACK —
 *                      hence opaque, and hence the mark's own rounded corners
 *                      being filled rather than left clear.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  canvas,
  composite,
  crop,
  decodePng,
  encodePng,
  opaqueBounds,
  resize,
  type Raster,
} from './lib/png'

const SOURCE = path.resolve('assets/app-icon.png')
const OUT_DIR = path.resolve('public/icons')

/**
 * Average colour of the opaque pixels in the outer ring of the mark.
 *
 * Sampled rather than hard-coded so re-cutting the artwork cannot leave a
 * background from the previous one behind. The RING specifically: the mark's
 * outer edge is what a platform mask cuts through, so matching it is what makes
 * a crop invisible. Averaged with alpha weighting, so the anti-aliased pixels
 * on the rounded corner do not drag it toward the transparent field.
 */
function borderColor(mark: Raster, ringFraction = 0.06): [number, number, number] {
  const ring = Math.max(1, Math.round(Math.min(mark.width, mark.height) * ringFraction))
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (let y = 0; y < mark.height; y++) {
    for (let x = 0; x < mark.width; x++) {
      const inRing =
        x < ring || y < ring || x >= mark.width - ring || y >= mark.height - ring
      if (!inRing) continue
      const i = (y * mark.width + x) * 4
      const alpha = mark.data[i + 3]
      if (alpha < 250) continue // skip the anti-aliased corner falloff
      r += mark.data[i] * alpha
      g += mark.data[i + 1] * alpha
      b += mark.data[i + 2] * alpha
      a += alpha
    }
  }
  if (a === 0) return [23, 26, 33] // --panel, if the mark has no opaque border
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a)]
}

/** The trimmed mark, squared up so a non-square source is centred, not stretched. */
function squared(mark: Raster): Raster {
  if (mark.width === mark.height) return mark
  const side = Math.max(mark.width, mark.height)
  const out = canvas(side)
  composite(out, mark, Math.round((side - mark.width) / 2), Math.round((side - mark.height) / 2))
  return out
}

function render(
  mark: Raster,
  size: number,
  opts: { background?: [number, number, number]; inset: number },
): Raster {
  const inner = Math.round(size * opts.inset)
  const scaled = resize(mark, inner, inner)
  const out = canvas(size, opts.background)
  const offset = Math.round((size - inner) / 2)
  composite(out, scaled, offset, offset)
  return out
}

if (!fs.existsSync(SOURCE)) {
  console.error(`icons:pwa needs the artwork at ${path.relative(process.cwd(), SOURCE)}`)
  process.exit(1)
}

const source = decodePng(SOURCE)
const bounds = opaqueBounds(source)
if (!bounds) {
  console.error('icons:pwa: the source artwork is fully transparent')
  process.exit(1)
}
const mark = squared(crop(source, bounds))
const background = borderColor(mark)

const trimmedPct = (
  100 -
  (bounds.w * bounds.h * 100) / (source.width * source.height)
).toFixed(1)
console.log(
  `  source ${source.width}x${source.height} → mark ${bounds.w}x${bounds.h} ` +
    `at (${bounds.x}, ${bounds.y}); trimmed ${trimmedPct}% transparent border`,
)
console.log(
  `  sampled border colour rgb(${background.join(', ')}) for the opaque tiles`,
)

const TARGETS: {
  file: string
  size: number
  inset: number
  background?: [number, number, number]
}[] = [
  { file: 'icon-192.png', size: 192, inset: 1 },
  { file: 'icon-512.png', size: 512, inset: 1 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.75, background },
  // iOS ignores the web manifest's icons for Add to Home Screen and uses this.
  { file: 'apple-touch-icon.png', size: 180, inset: 1, background },
]

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const target of TARGETS) {
  const png = encodePng(
    render(mark, target.size, { background: target.background, inset: target.inset }),
  )
  fs.writeFileSync(path.join(OUT_DIR, target.file), png)
  console.log(
    `  wrote ${target.file}  ${target.size}x${target.size}  ` +
      `inset ${Math.round(target.inset * 100)}%  ${png.length} bytes`,
  )
}
console.log(`\nicons:pwa wrote ${TARGETS.length} files to public/icons`)
