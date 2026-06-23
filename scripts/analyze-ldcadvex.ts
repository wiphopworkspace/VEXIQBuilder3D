/**
 * Analyze the local LDCadVEX reference library and emit lightweight metadata.
 *
 * This does not copy geometry into the app. It reads text catalog/part files to
 * extract taxonomy, VEX part numbers, reference file names, and convention
 * hints that help the app classify generated STEP/GLB parts.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PartCategory } from '../src/types/assembly'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const LDCAD_ROOT = path.join(PROJECT_ROOT, 'LDCadVEX')
const LIBRARY_ROOT = path.join(LDCAD_ROOT, 'Library')
const PARTS_LIST = path.join(LIBRARY_ROOT, 'Parts.lst')
const PARTS_DIR = path.join(LIBRARY_ROOT, 'parts')
const SUBPARTS_DIR = path.join(PARTS_DIR, 's')
const OUTPUT_FILE = path.join(
  PROJECT_ROOT,
  'src',
  'data',
  'ldcadVexReference.ts',
)

const PART_NUMBER_RE = /(\d{3}-\d{3,4}-\d+)/

type PartReference = {
  partNumber?: string
  fileName: string
  displayName?: string
  category?: PartCategory
  sourceDatPath?: string
  notes?: string[]
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function extractPartNumber(value: string): string | undefined {
  return value.match(PART_NUMBER_RE)?.[1]
}

function inferCategory(displayName: string, fileName: string): PartCategory {
  const t = `${displayName} ${fileName}`.toLowerCase()
  const has = (...keys: string[]) => keys.some((key) => t.includes(key))

  if (has('beam', 'crossbar', 'plaque')) return 'Beams'
  if (has('pin')) return 'Pins'
  if (has('connector', 'corner', 'gusset', 'tab', 'standoff')) {
    return 'Connectors'
  }
  if (has('axle', 'shaft', 'spacer', 'washer', 'bush')) return 'Axles'
  if (has('gear', 'sprocket', 'rack', 'differential')) return 'Gears'
  if (has('wheel', 'tire', 'tyre', 'hub', 'flywheel')) return 'Wheels'
  if (
    has(
      'motor',
      'brain',
      'controller',
      'battery',
      'radio',
      'sensor',
      'led',
      'lamp',
      'switch',
      'plug',
      'cable',
      'wire',
    )
  ) {
    return 'Electronics'
  }
  if (has('plate', 'panel', 'sheet', 'tile')) return 'Plates'
  if (has('challenge', 'field', 'game', 'element', 'ball', 'ring', 'pipe')) {
    return 'Game Elements'
  }
  return 'Misc'
}

function notesFor(displayName: string, fileName: string): string[] {
  const t = `${displayName} ${fileName}`.toLowerCase()
  const notes = new Set<string>()

  if (t.includes('pin')) {
    notes.add('pin family')
    notes.add('cap/shoulder behavior')
  }
  if (t.includes('1x1') && t.includes('pin')) {
    notes.add('two-ended pin')
  }
  if (t.includes('beam')) {
    notes.add('beam holes repeat at 16 LDraw units')
  }
  if (t.includes('axle') || t.includes('shaft')) {
    notes.add('axle center-axis mating')
  }
  if (t.includes('gear') || t.includes('wheel') || t.includes('sprocket')) {
    notes.add('center bore axis mating')
  }
  if (t.includes('vexpinhole')) {
    notes.add('pin hole passes through part thickness')
  }
  if (t.includes('vexaxlehole')) {
    notes.add('axle hole passes through part thickness')
  }

  return Array.from(notes)
}

function parsePartsListLine(line: string): PartReference | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const match = trimmed.match(/^(\S+\.dat)\s+(.+)$/i)
  if (!match) return null

  const fileName = match[1]
  const displayName = normalizeWhitespace(match[2])
  const category = inferCategory(displayName, fileName)
  const sourceDatPath = `LDCadVEX/Library/parts/${fileName}`

  return {
    partNumber: extractPartNumber(fileName),
    fileName,
    displayName,
    category,
    sourceDatPath,
    notes: notesFor(displayName, fileName),
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function listDatFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dat'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function toGeneratedTs(
  references: PartReference[],
  topLevelDatFiles: string[],
  subpartDatFiles: string[],
): string {
  const knownPinDatFiles = uniqueSorted(
    [
      ...references
        .filter((ref) => ref.category === 'Pins')
        .map((ref) => ref.fileName),
      ...subpartDatFiles.filter((name) => name.toLowerCase().includes('pin')),
    ],
  )
  const knownHoleDatFiles = uniqueSorted(
    subpartDatFiles.filter((name) => name.toLowerCase().includes('hole')),
  )
  const knownAxleHoleDatFiles = uniqueSorted(
    subpartDatFiles.filter((name) => name.toLowerCase().includes('axlehole')),
  )
  const knownBeamDatFiles = uniqueSorted(
    references
      .filter((ref) => ref.category === 'Beams')
      .map((ref) => ref.fileName),
  )
  const byPartNumber = new Map<string, PartReference>()
  for (const ref of references) {
    if (!ref.partNumber) continue
    const existing = byPartNumber.get(ref.partNumber)
    const exactBase = `${ref.partNumber}.dat`
    if (
      !existing ||
      ref.fileName.toLowerCase() === exactBase.toLowerCase()
    ) {
      byPartNumber.set(ref.partNumber, ref)
    }
  }
  const byPartNumberEntries = Array.from(byPartNumber.entries())
  const byFileNameEntries = references.map((ref) => [
    ref.fileName.toLowerCase(),
    ref,
  ] as const)

  return `// AUTO-GENERATED by scripts/analyze-ldcadvex.ts
// Do not edit by hand. Re-run \`npm run analyze:ldcadvex\` after updating
// the local LDCadVEX reference folder.
import type { PartCategory } from '../types/assembly'

export type LdcadVexPartReference = {
  partNumber?: string
  fileName: string
  displayName?: string
  category?: PartCategory
  sourceDatPath?: string
  notes?: string[]
}

export const LDCAD_VEX_CONSTANTS = {
  // LDCadVEX/LDraw beam holes use a 16-unit module. The web app maps that
  // concept to its own world scale in snapCalibration.ts.
  ldrawHolePitch: 16,
  topLevelDatFileCount: ${topLevelDatFiles.length},
  subpartDatFileCount: ${subpartDatFiles.length},
  knownPinDatFiles: ${JSON.stringify(knownPinDatFiles, null, 2)},
  knownHoleDatFiles: ${JSON.stringify(knownHoleDatFiles, null, 2)},
  knownAxleHoleDatFiles: ${JSON.stringify(knownAxleHoleDatFiles, null, 2)},
  knownBeamDatFiles: ${JSON.stringify(knownBeamDatFiles, null, 2)},
} as const

export const ldcadVexReferences: LdcadVexPartReference[] = ${JSON.stringify(
    references,
    null,
    2,
  )}

export const ldcadVexReferenceByPartNumber: Record<string, LdcadVexPartReference> = Object.fromEntries(
  ${JSON.stringify(byPartNumberEntries.map(([key, ref]) => [key, ref]), null, 2)},
)

export const ldcadVexReferenceByFileName: Record<string, LdcadVexPartReference> = Object.fromEntries(
  ${JSON.stringify(byFileNameEntries.map(([key, ref]) => [key, ref]), null, 2)},
)
`
}

async function main() {
  const partsListText = await fs.readFile(PARTS_LIST, 'utf8')
  const refs = partsListText
    .split(/\r?\n/)
    .map(parsePartsListLine)
    .filter((ref): ref is PartReference => ref !== null)

  const topLevelDatFiles = await listDatFiles(PARTS_DIR)
  const subpartDatFiles = await listDatFiles(SUBPARTS_DIR)
  const topLevelSet = new Set(topLevelDatFiles.map((name) => name.toLowerCase()))

  const references = refs
    .map((ref) => ({
      ...ref,
      sourceDatPath: topLevelSet.has(ref.fileName.toLowerCase())
        ? ref.sourceDatPath
        : undefined,
    }))
    .filter((ref) => ref.sourceDatPath || ref.partNumber || ref.displayName)
    .sort((a, b) => a.fileName.localeCompare(b.fileName))

  if (!(await exists(PARTS_DIR))) {
    throw new Error(`Missing LDCadVEX parts directory: ${PARTS_DIR}`)
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true })
  await fs.writeFile(
    OUTPUT_FILE,
    toGeneratedTs(references, topLevelDatFiles, subpartDatFiles),
    'utf8',
  )

  console.log(
    `[analyze:ldcadvex] Wrote ${references.length} references to ${path.relative(
      PROJECT_ROOT,
      OUTPUT_FILE,
    )}`,
  )
  console.log(
    `[analyze:ldcadvex] ${topLevelDatFiles.length} top-level .dat, ${subpartDatFiles.length} subpart .dat`,
  )
}

main().catch((err) => {
  console.error('[analyze:ldcadvex] Failed:', err)
  process.exit(1)
})
