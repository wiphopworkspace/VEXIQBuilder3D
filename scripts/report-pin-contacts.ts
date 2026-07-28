/**
 * Pin & receiver contact-metadata inventory (`npm run report:pins`).
 *
 * Walks the REAL catalog metadata — never file names — and reports every
 * endpoint that takes part in the pin insertion system, with the mechanical
 * contact description the seating solver will actually use.
 *
 * Exits non-zero when a PRODUCTION pin endpoint or pin receiver is missing
 * required contact metadata, so CI fails on an incomplete part rather than
 * shipping an endpoint that silently seats on its visual marker.
 *
 *   npm run report:pins            summary + any incomplete endpoints
 *   npm run report:pins -- --full  every endpoint, one row each
 *   npm run report:pins -- <text>  filter to matching part ids/names
 */
import { PARTS } from '../src/data/parts'
import {
  contactFramesForPart,
  type MechanicalContactFrame,
} from '../src/data/contactFrames'
import type { PartDefinition } from '../src/types/assembly'

const args = process.argv.slice(2)
const full = args.includes('--full')
const filter = args.find((a) => !a.startsWith('--'))?.toLowerCase()

type Row = {
  part: PartDefinition
  frame: MechanicalContactFrame
}

const rows: Row[] = []
for (const part of PARTS) {
  if (
    filter &&
    !`${part.id} ${part.name} ${part.partNumber ?? ''}`
      .toLowerCase()
      .includes(filter)
  ) {
    continue
  }
  for (const frame of contactFramesForPart(part)) rows.push({ part, frame })
}

const pinRows = rows.filter((r) => r.frame.role === 'insert')
const recvRows = rows.filter((r) => r.frame.role === 'receive')

const fmt = (n: number) => (n < 0 ? '' : ' ') + n.toFixed(4)
const vec = (v: [number, number, number]) =>
  `[${v.map((n) => n.toFixed(3)).join(',')}]`

function describe(r: Row): string {
  const f = r.frame
  return [
    (r.part.partNumber ?? r.part.id).padEnd(16),
    f.snapId.padEnd(14),
    (f.pinFamily ?? f.receiverFamily ?? '-').padEnd(22),
    f.role.padEnd(8),
    f.contactPlaneSource.padEnd(13),
    `depth=${fmt(f.seatedDepth)}`,
    `roll=${f.allowedRollStepDeg === 360 ? 'fixed' : `${f.allowedRollStepDeg}°`}`.padEnd(11),
    `axis=${vec(f.insertionAxis)}`.padEnd(24),
    `offset=${fmt(f.calibratedSeatOffset)}`,
    f.mechanical ? 'mechanical' : 'NON-MECHANICAL',
    f.calibrationComplete ? 'complete' : `INCOMPLETE(${f.issues.join('; ')})`,
  ].join(' ')
}

console.log('=========== VEX IQ pin / receiver contact inventory ===========\n')
console.log(`parts scanned:          ${PARTS.length}`)
console.log(`pin-side endpoints:     ${pinRows.length}`)
console.log(`receiver endpoints:     ${recvRows.length}`)

function tally<T extends string>(list: Row[], pick: (f: MechanicalContactFrame) => T | undefined) {
  const map = new Map<string, number>()
  for (const r of list) {
    const k = pick(r.frame) ?? '(none)'
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

console.log('\n-- pin connector families --')
for (const [k, v] of tally(pinRows, (f) => f.pinFamily)) {
  console.log(`   ${k.padEnd(26)} ${String(v).padStart(5)}`)
}
console.log('\n-- receiver families --')
for (const [k, v] of tally(recvRows, (f) => f.receiverFamily)) {
  console.log(`   ${k.padEnd(26)} ${String(v).padStart(5)}`)
}
console.log('\n-- contact-plane provenance --')
for (const [k, v] of tally(rows, (f) => f.contactPlaneSource)) {
  console.log(`   ${k.padEnd(26)} ${String(v).padStart(5)}`)
}

if (full) {
  console.log('\n-- every endpoint --')
  for (const r of rows) console.log(describe(r))
}

// A non-mechanical endpoint is a DATA ERROR here: `resolveSnapPoints` already
// filters declared non-mechanical volumes out of every non-authored layer, so
// one surviving to this report means a region no longer covers its feature.
const nonMechanical = rows.filter((r) => !r.frame.mechanical)
const incomplete = rows.filter(
  (r) => !r.frame.calibrationComplete && r.frame.mechanical,
)

/**
 * What counts as a PRODUCTION endpoint for the gate.
 *
 * Review-gated fallbacks (`approximate` / `boundsInferred` /
 * `generatedFallback`) are excluded on purpose: their contact plane is a
 * declared placeholder, they are already blocked from Basic-Mode Auto Snap by
 * `lowConfidenceSnap`, and failing on them would either force fabricated
 * geometry or permanently red CI. They still appear in the report.
 *
 * A missing `receivingDepth` on a through-hole is likewise not blocking — the
 * hole's contact plane is its face and the depth is only advisory. The gate
 * fires on the three things that make the SOLVER guess: no insertion axis, no
 * compatibility list, or an inserting endpoint with no seat frame (which would
 * silently seat the part on its visual marker).
 */
const blocking = incomplete.filter(
  (r) =>
    !r.frame.reviewGated &&
    r.frame.issues.some(
      (i) =>
        i.includes('insertion axis') ||
        i.includes('compatibleWith') ||
        i.includes('seat frame'),
    ),
)

if (nonMechanical.length > 0) {
  console.log(
    `\n!! ${nonMechanical.length} endpoint(s) resolved INSIDE a non-mechanical region:`,
  )
  for (const r of nonMechanical) console.log(`   ${describe(r)}`)
}

const reviewGated = incomplete.filter((r) => r.frame.reviewGated)
const productionIncomplete = incomplete.filter((r) => !r.frame.reviewGated)

console.log(
  `\nproduction endpoints:   ${rows.filter((r) => !r.frame.reviewGated).length}`,
)
console.log(`review-gated endpoints: ${rows.filter((r) => r.frame.reviewGated).length}`)

if (productionIncomplete.length > 0) {
  console.log(
    `\n-- ${productionIncomplete.length} PRODUCTION endpoint(s) with incomplete metadata --`,
  )
  for (const r of productionIncomplete.slice(0, 60)) console.log(`   ${describe(r)}`)
  if (productionIncomplete.length > 60) {
    console.log(`   … and ${productionIncomplete.length - 60} more`)
  }
}
if (reviewGated.length > 0 && full) {
  console.log(
    `\n-- ${reviewGated.length} review-gated endpoint(s) (not blocking) --`,
  )
  for (const r of reviewGated.slice(0, 40)) console.log(`   ${describe(r)}`)
}

const failures = blocking.length + nonMechanical.length
if (failures > 0) {
  console.log(
    `\nFAIL: ${blocking.length} endpoint(s) missing required contact metadata, ` +
      `${nonMechanical.length} inside a non-mechanical region.`,
  )
  process.exit(1)
}
console.log(
  `\nOK: every production pin endpoint and pin receiver carries the required ` +
    `mechanical contact metadata (${rows.length} endpoints).`,
)
