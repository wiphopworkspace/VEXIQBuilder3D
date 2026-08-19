/**
 * Tracked PWA / offline regression check (`npm run verify:pwa`).
 *
 * Runs against `dist/`, because every one of these defects is invisible in the
 * source and only exists in the built output: an unsubstituted placeholder, a
 * precache list that names files Rollup did not emit, a manifest whose urls are
 * correct at the domain root and wrong under /VEXIQBuilder3D/.
 *
 *  1. sw.js exists, has no leftover placeholders, and its cache names are
 *     build-scoped (shell) and build-independent (models).
 *  2. The precache list is exactly the emitted JS/CSS plus the document, with
 *     the SAME base prefix index.html was built with.
 *  3. Every cache lookup passes `ignoreVary: true`. This one is a scar: without
 *     it the shell caches perfectly and the app still comes up BLANK offline,
 *     because `Vary: Origin` plus Vite's `crossorigin` module scripts means the
 *     browser's own request never matches the stored entry.
 *  4. The manifest parses, declares what an install needs, and uses RELATIVE
 *     urls so one file is correct at both bases.
 *  5. The icons exist and are real PNGs at the sizes the manifest claims —
 *     read out of the IHDR, not trusted from the filename.
 *  6. index.html links the manifest and the apple-touch-icon, and no longer
 *     links the Vite starter favicon that was never written into public/.
 *
 * Run `npm run build` first. Run with: npx tsx scripts/verify-pwa.ts
 */
import fs from 'node:fs'
import path from 'node:path'

const DIST = path.resolve('dist')
let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('verify:pwa needs a build — run `npm run build` first.')
  process.exit(1)
}

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
const swPath = path.join(DIST, 'sw.js')

// ------------------------------------------------------- 1. worker identity
console.log('\n[1] Service worker is built, not templated')
check('dist/sw.js exists', fs.existsSync(swPath))
const sw = fs.existsSync(swPath) ? fs.readFileSync(swPath, 'utf8') : ''
check(
  'no unsubstituted placeholders',
  !/__BUILD_ID__|__PRECACHE__/.test(sw.replace(/^[\s\S]*?\*\//, '')),
  'a placeholder survived into the emitted worker',
)
const buildId = sw.match(/const BUILD = '([0-9a-f]+)'/)?.[1]
check('build id is a 12-char hash', buildId?.length === 12, buildId)
check(
  'shell cache is scoped to the build',
  /const SHELL_CACHE = `vexiq-shell-\$\{BUILD\}`/.test(sw),
  'a shell cache that outlives its build serves stale HTML for ever',
)
check(
  'model cache is NOT scoped to the build',
  /const MODEL_CACHE = 'vexiq-models-v\d+'/.test(sw),
  'a build-scoped model cache would wipe a class’s offline parts on every deploy',
)

// -------------------------------------------------------- 2. precache list
console.log('\n[2] Precache list matches what Rollup emitted')
const precacheJson = sw.match(/const PRECACHE = (\[[\s\S]*?\n\])/)?.[1]
let precache: string[] = []
try {
  precache = JSON.parse(precacheJson ?? '[]')
} catch {
  /* reported by the check below */
}
check('precache list parses', precache.length > 0, precacheJson?.slice(0, 80))

// The base the document was actually built with, read back off its own script tag.
const scriptSrc = html.match(/<script[^>]+src="([^"]+)"/)?.[1] ?? ''
const base = scriptSrc.slice(0, scriptSrc.indexOf('assets/'))
check('index.html reveals its base', base.length > 0, `script src ${scriptSrc}`)
check(
  'every precache entry carries that base',
  precache.every((u) => u.startsWith(base)),
  `base ${base}, first entry ${precache[0]}`,
)
check(
  'the document is entry 0 (the offline navigation fallback)',
  precache[0] === base,
  precache[0],
)

const emitted = fs
  .readdirSync(path.join(DIST, 'assets'))
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => `${base}assets/${f}`)
  .sort()
const precachedAssets = precache.slice(1).sort()
check(
  `all ${emitted.length} emitted js/css files are precached`,
  emitted.length > 0 &&
    emitted.length === precachedAssets.length &&
    emitted.every((f, i) => f === precachedAssets[i]),
  `emitted ${emitted.length}, precached ${precachedAssets.length}`,
)
check(
  'no precache entry names a file that does not exist',
  precache
    .slice(1)
    .every((u) => fs.existsSync(path.join(DIST, u.slice(base.length)))),
)

// --------------------------------------------------------- 3. the Vary scar
console.log('\n[3] Every cache lookup ignores Vary')
const lookups = sw.match(/(?:caches|cache)\.match\([\s\S]*?\)/g) ?? []
check('the worker does look things up', lookups.length >= 5, `${lookups.length} found`)
const missing = lookups.filter((l) => !l.includes('ignoreVary: true'))
check(
  'no cache lookup omits ignoreVary',
  missing.length === 0,
  missing.join(' | ').slice(0, 200),
)

// ------------------------------------------------------------- 4. manifest
console.log('\n[4] Web app manifest')
const manifestPath = path.join(DIST, 'manifest.webmanifest')
check('manifest exists', fs.existsSync(manifestPath))
let manifest: Record<string, unknown> = {}
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch (e) {
  check('manifest parses', false, String(e))
}
for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
  check(`declares ${key}`, manifest[key] !== undefined)
}
check(
  'start_url and scope are RELATIVE',
  manifest.start_url === './' && manifest.scope === './',
  `start_url ${manifest.start_url}, scope ${manifest.scope} — an absolute url here is correct at one base and broken at the other`,
)
const icons = (manifest.icons ?? []) as { src: string; sizes: string; purpose?: string }[]
check(
  'every icon src is relative',
  icons.every((i) => i.src.startsWith('./')),
  icons.map((i) => i.src).join(' '),
)
check(
  'a maskable icon is declared',
  icons.some((i) => i.purpose === 'maskable'),
  'Android crops a non-maskable icon into its own shape',
)

// ---------------------------------------------------------------- 5. icons
console.log('\n[5] Icons are real PNGs at the declared sizes')
/** Read width/height straight out of the PNG IHDR. */
function pngSize(file: string): { w: number; h: number } | null {
  const buf = fs.readFileSync(file)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) return null
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}
for (const icon of icons) {
  const file = path.join(DIST, icon.src.replace('./', ''))
  const size = fs.existsSync(file) ? pngSize(file) : null
  const [w, h] = icon.sizes.split('x').map(Number)
  check(
    `${icon.src} is a ${icon.sizes} PNG`,
    !!size && size.w === w && size.h === h,
    size ? `${size.w}x${size.h}` : 'missing or not a PNG',
  )
}
const apple = path.join(DIST, 'icons/apple-touch-icon.png')
const appleSize = fs.existsSync(apple) ? pngSize(apple) : null
check(
  'apple-touch-icon.png is a 180x180 PNG',
  !!appleSize && appleSize.w === 180 && appleSize.h === 180,
  appleSize ? `${appleSize.w}x${appleSize.h}` : 'missing — iOS ignores the manifest icons for Add to Home Screen',
)

// ----------------------------------------------------------- 6. index.html
console.log('\n[6] Document wiring')
check(
  'links the manifest with the base applied',
  html.includes(`href="${base}manifest.webmanifest"`),
  base,
)
check(
  'links the apple-touch-icon with the base applied',
  html.includes(`href="${base}icons/apple-touch-icon.png"`),
)
check('declares a theme-color', /name="theme-color"/.test(html))
check(
  'nothing still LINKS the Vite starter favicon that was never in the repo',
  !/(?:href|src)="[^"]*vite\.svg"/.test(html),
  'a link to a file that does not exist is a 404 on every load',
)

console.log(
  failures === 0
    ? '\nverify:pwa PASS'
    : `\nverify:pwa FAIL — ${failures} check(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
