/**
 * generate-parts-manifest.ts
 *
 * Scans the local STEP folders and generates `src/data/generatedStepParts.ts`,
 * a typed array of PartDefinition objects the app uses to populate the parts
 * library.
 *
 * STEP files are NEVER parsed/rendered in the browser — this script only reads
 * filenames to build metadata and links each part to:
 *   - its source STEP path (metadata only)
 *   - a matching GLB path (rendered if a converted file exists)
 *   - an expected thumbnail path
 *
 * Two STEP source collections are scanned, each paired with its GLB folder.
 *
 * Run with:  npm run generate:parts
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PartCategory, SourceCollection } from '../src/types/assembly'
import { ldcadVexReferenceByPartNumber } from '../src/data/ldcadVexReference'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(PROJECT_ROOT, 'public')

const OUTPUT_FILE = path.join(
  PROJECT_ROOT,
  'src',
  'data',
  'generatedStepParts.ts',
)

const THUMB_WEB_BASE = '/models/thumbnails'
const STEP_EXTENSIONS = new Set(['.step', '.stp'])

const COLOR_OPTIONS = ['#9aa3b2', '#3a3f4b', '#1f6feb', '#222831']
const DEFAULT_COLOR = COLOR_OPTIONS[0]

// Each STEP collection and the GLB folder its conversions live in.
type Source = {
  collection: SourceCollection
  stepDir: string
  stepWebBase: string
  glbDir: string
  glbWebBase: string
}

const SOURCES: Source[] = [
  {
    collection: 'control',
    stepDir: path.join(PUBLIC, 'models', 'VEX-IQ-All-Control-STEP'),
    stepWebBase: '/models/VEX-IQ-All-Control-STEP',
    glbDir: path.join(PUBLIC, 'models', 'VEX-IQ-All-Control-GLB'),
    glbWebBase: '/models/VEX-IQ-All-Control-GLB',
  },
  {
    collection: 'all-parts-2024-11-08',
    stepDir: path.join(PUBLIC, 'models', 'VEX-IQ-All-Parts-2024-11-08'),
    stepWebBase: '/models/VEX-IQ-All-Parts-2024-11-08',
    glbDir: path.join(PUBLIC, 'models', 'VEX-IQ-All-Parts-GLB'),
    glbWebBase: '/models/VEX-IQ-All-Parts-GLB',
  },
]

// ---------------------------------------------------------------------------
// Name normalization & matching
// ---------------------------------------------------------------------------

/**
 * Normalize a file/part name for fuzzy comparison: lower-case, drop the
 * extension, and remove spaces, underscores, hyphens, parentheses and any
 * other non-alphanumeric characters (which also collapses repeated separators).
 *
 *   "Beam 2x6.step"  -> "beam2x6"
 *   "Beam_2x6.glb"   -> "beam2x6"
 *   "beam-2x6.GLB"   -> "beam2x6"
 *   "BEAM 2X6.glb"   -> "beam2x6"
 */
export function normalizeAssetName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

// Matches a VEX part code such as "228-2500-213".
const CODE_RE = /(\d{3}-\d{3,4}-\d+)/

function extractCode(name: string): string | null {
  const m = name.match(CODE_RE)
  return m ? m[1] : null
}

/** The base name with any trailing "(228-2500-213)" code group removed. */
function stripCode(baseName: string): string {
  return baseName.replace(/\s*\(\s*\d{3}-\d{3,4}-\d+\s*\)\s*/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Category & geometry inference
// ---------------------------------------------------------------------------

/** Guess a part category from the file/folder name keywords. */
function guessCategory(text: string): PartCategory {
  const t = text.toLowerCase()
  const has = (...keys: string[]) => keys.some((k) => t.includes(k))

  // Order matters: more specific keywords are checked first.
  if (has('beam', 'crossbar')) return 'Beams'
  if (has('pin')) return 'Pins' // includes "connector pin", "idler pin"
  if (has('connector', 'angle', 'corner', 'gusset')) return 'Connectors'
  if (has('axle', 'shaft')) return 'Axles'
  if (has('gear', 'sprocket')) return 'Gears'
  if (has('wheel', 'tire', 'tyre', 'omni')) return 'Wheels'
  if (
    has(
      'motor',
      'brain',
      'controller',
      'battery',
      'radio',
      'sensor',
      'bumper',
      'touch',
      'distance',
      'optical',
      'gyro',
      'inertial',
      'cable',
      'wire',
    )
  ) {
    return 'Electronics'
  }
  if (has('plate', 'panel')) return 'Plates'
  if (has('field', 'game', 'element')) return 'Game Elements'
  return 'Misc'
}

/** Map a part to its procedural placeholder kind (string emitted into the file). */
function proceduralForPart(text: string, category: PartCategory): string {
  if (category === 'Electronics') {
    return text.toLowerCase().includes('motor') ? 'motor' : 'brain'
  }
  switch (category) {
    case 'Beams':
      return 'beam'
    case 'Pins':
      return 'pin'
    case 'Axles':
      return 'axle'
    case 'Gears':
      return 'gear'
    case 'Wheels':
      return 'wheel'
    case 'Connectors':
      return 'connector'
    case 'Plates':
      return 'plate'
    default:
      return 'box'
  }
}

/** Infer beam hole count from patterns like "2x6", "1x10", "Beam 6", "12x". */
function inferHoleCount(text: string): number {
  const t = text.toLowerCase()
  const grid = t.match(/(\d+)\s*x\s*(\d+)/)
  if (grid) return Math.max(parseInt(grid[1], 10), parseInt(grid[2], 10))
  const beamN = t.match(/beam\s*(\d+)/)
  if (beamN) return parseInt(beamN[1], 10)
  const pitch = t.match(/(\d+)\s*x\s*pitch/)
  if (pitch) return parseInt(pitch[1], 10)
  return 6
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'part'
  )
}

/** A clean, human-readable display name (code prefix/suffix removed). */
function cleanName(rawName: string): string {
  return (
    stripCode(rawName)
      // Leading "228-2540 " or "228-2500-063 " part-number prefix.
      .replace(/^\s*\d{3}[-\s]\d{3,4}(?:[-\s]\d+)?\s+/, '')
      .replace(/[_]+/g, ' ')
      // Leading separators left behind after stripping a prefix.
      .replace(/^[\s\-–—]+/, '')
      .replace(/\s+/g, ' ')
      .trim() || rawName
  )
}

function displayNameFor(rawName: string, refName?: string): string {
  const current = cleanName(rawName)
  if (!refName) return current
  if (isCodeOnly(rawName) || current === rawName.match(CODE_RE)?.[1]) {
    return cleanName(refName.replace(/^VEX\s+/i, ''))
  }
  return current
}

/** True when the file name is essentially just a VEX part number. */
function isCodeOnly(baseName: string): boolean {
  return /^[0-9][0-9\s-]*$/.test(baseName.trim())
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

type StepFile = {
  source: Source
  absPath: string
  relPath: string // POSIX, relative to the step dir
  baseName: string // filename without extension
  folderName: string // immediate parent folder name (often descriptive)
}

async function collectStepFiles(source: Source): Promise<StepFile[]> {
  const out: StepFile[] = []

  async function walk(current: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (STEP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const relPath = path
          .relative(source.stepDir, abs)
          .split(path.sep)
          .join('/')
        const baseName = path.basename(entry.name, path.extname(entry.name))
        const folderName = path.basename(path.dirname(abs))
        out.push({ source, absPath: abs, relPath, baseName, folderName })
      }
    }
  }

  await walk(source.stepDir)
  out.sort((a, b) => a.baseName.localeCompare(b.baseName))
  return out
}

/** Index every GLB in a folder by normalized name and by part code. */
async function buildGlbIndex(source: Source): Promise<Map<string, string>> {
  const index = new Map<string, string>()

  async function walk(current: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (path.extname(entry.name).toLowerCase() === '.glb') {
        const rel = path.relative(source.glbDir, abs).split(path.sep).join('/')
        const webPath = `${source.glbWebBase}/${rel}`
        const base = path.basename(entry.name, path.extname(entry.name))
        index.set(normalizeAssetName(base), webPath)
        const code = extractCode(base)
        if (code) index.set(normalizeAssetName(code), webPath)
      }
    }
  }

  await walk(source.glbDir)
  return index
}

/** Find a matching GLB for a STEP file, trying full name, no-code, and code. */
function matchGlb(file: StepFile, index: Map<string, string>): string | null {
  const candidates = [
    normalizeAssetName(file.baseName),
    normalizeAssetName(stripCode(file.baseName)),
  ]
  const code = extractCode(file.baseName)
  if (code) candidates.push(normalizeAssetName(code))

  for (const key of candidates) {
    if (key && index.has(key)) return index.get(key)!
  }
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const records: string[] = []
  const usedIds = new Set<string>()
  let total = 0
  let converted = 0
  const perCollection: Record<string, number> = {}

  for (const source of SOURCES) {
    const files = await collectStepFiles(source)
    const glbIndex = await buildGlbIndex(source)
    perCollection[source.collection] = files.length

    for (const file of files) {
      total++
      // Prefer the descriptive folder name when the file is just a part number.
      const rawName =
        isCodeOnly(file.baseName) && file.folderName !== '.'
          ? file.folderName
          : file.baseName
      const partNumber = extractCode(file.baseName)
      const ldcadRef = partNumber
        ? ldcadVexReferenceByPartNumber[partNumber]
        : undefined
      const displayName = displayNameFor(rawName, ldcadRef?.displayName)
      const searchText = `${file.relPath} ${displayName}`
      const category = ldcadRef?.category ?? guessCategory(searchText)
      const procedural = proceduralForPart(searchText, category)
      const holeCount = inferHoleCount(searchText)

      // Unique id (slug of full base name keeps part codes for uniqueness).
      let id = slugify(file.baseName)
      let suffix = 2
      while (usedIds.has(id)) id = `${slugify(file.baseName)}-${suffix++}`
      usedIds.add(id)

      const glbWebPath = matchGlb(file, glbIndex)
      const hasConvertedModel = glbWebPath != null
      if (hasConvertedModel) converted++
      const modelPath =
        glbWebPath ?? `${source.glbWebBase}/${file.baseName}.glb`
      const sourceStepPath = `${source.stepWebBase}/${file.relPath}`
      const thumbnailPath = `${THUMB_WEB_BASE}/${file.baseName}.png`

      records.push(
        [
          '  {',
          `    id: ${JSON.stringify(id)},`,
          `    name: ${JSON.stringify(displayName)},`,
          `    category: ${JSON.stringify(category)},`,
          `    sourceCollection: ${JSON.stringify(source.collection)},`,
          partNumber ? `    partNumber: ${JSON.stringify(partNumber)},` : '',
          ldcadRef?.fileName
            ? `    ldcadVexFileName: ${JSON.stringify(ldcadRef.fileName)},`
            : '',
          `    sourceStepPath: ${JSON.stringify(sourceStepPath)},`,
          `    modelPath: ${JSON.stringify(modelPath)},`,
          `    thumbnailPath: ${JSON.stringify(thumbnailPath)},`,
          `    hasConvertedModel: ${hasConvertedModel},`,
          `    procedural: ${JSON.stringify(procedural)},`,
          category === 'Beams' || category === 'Axles'
            ? `    length: ${holeCount},`
            : '',
          `    colorOptions: ${JSON.stringify(COLOR_OPTIONS)},`,
          `    defaultColor: ${JSON.stringify(DEFAULT_COLOR)},`,
          `    snapPoints: generateSnapPoints(${JSON.stringify(
            category,
          )}, ${JSON.stringify(procedural)}, ${holeCount}),`,
          '  },',
        ].filter(Boolean).join('\n'),
      )
    }
  }

  if (total === 0) {
    console.warn(
      '[generate:parts] No STEP files found in either source folder.\n' +
        '  Expected:\n' +
        SOURCES.map((s) => `    ${s.stepDir}`).join('\n'),
    )
  }

  const header = `// AUTO-GENERATED by scripts/generate-parts-manifest.ts
// Do not edit by hand. Re-run \`npm run generate:parts\` after adding or
// converting STEP/GLB files. STEP files are listed here as metadata only and
// are never parsed in the browser.
import type { PartDefinition } from '../types/assembly'
import { generateSnapPoints } from '../utils/snapPointGenerator'

export const generatedStepParts: PartDefinition[] = [
`
  const body = records.join('\n')
  const footer = '\n]\n'

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true })
  await fs.writeFile(OUTPUT_FILE, header + body + footer, 'utf8')

  console.log(
    `[generate:parts] Wrote ${total} part(s) to ${path.relative(
      PROJECT_ROOT,
      OUTPUT_FILE,
    )}`,
  )
  for (const [collection, count] of Object.entries(perCollection)) {
    console.log(`[generate:parts]   ${collection}: ${count} part(s)`)
  }
  console.log(
    `[generate:parts] ${converted} with GLB, ${total - converted} placeholder-only.`,
  )
}

main().catch((err) => {
  console.error('[generate:parts] Failed:', err)
  process.exit(1)
})
