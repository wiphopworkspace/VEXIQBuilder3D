/**
 * Measure the REAL seating plane of every RECEIVING pin hole in the catalog,
 * straight from the converted GLB meshes.
 *
 * This is the receiver-side twin of `measure-pin-contacts.ts`. That script
 * answers "where does the connector stop?"; this one answers "what does it stop
 * AGAINST?" — and until 2026-08-03 the app simply assumed the answer was the
 * part's outer skin.
 *
 * The defect that motivated it: `makeBeamGridOverrides` put every beam/plate
 * hole's `facePosition` at `beamFaceOffset(depth) = depth / 2`, i.e. on the
 * OUTER SURFACE of the beam. But a real VEX IQ beam hole sits at the bottom of
 * a moulded pocket: measured on `2x2 Beam (228-2500-017)`, the material ring a
 * pin collar lands on is at |z| = 0.0900 while the raised rib skin is at
 * |z| = 0.1201 — the seat is 0.0301 further in. Every pin therefore floated
 * 0.0301 (0.76 mm) proud of the beam, and two beams joined through a 1x1 pin
 * ended 0.070 apart instead of the measured 0.010.
 *
 * The rule, and the reason this is a measurement rather than a constant:
 *
 *   A connector's collar cannot enter the hole (collar radius 0.125 vs hole
 *   radius 0.083). So the plane it lands on is the OUTERMOST material in the
 *   annulus between those two radii about the hole axis. That is the seat,
 *   whatever produced it — a moulded pocket, a flat face, or a raised boss.
 *
 * Only material within `MAX_SEAT_RECESS` of the authored face counts: past
 * that we would be measuring a different feature (the far wall of a box, a hub,
 * a neighbouring rib) rather than this hole's seat. A hole with no confident
 * ring keeps its authored face and is reported as unmeasured, never seated on a
 * guess.
 *
 * Coordinates are in the bbox-recentred local frame `ScenePart.tsx` renders in.
 * `seatOffset` is relative to the hole's MARKER (`mateFrame.position`), not to
 * its `facePosition`, so re-running the script after the correction is applied
 * reproduces the same numbers instead of collapsing them to zero.
 *
 * Run:
 *   npm run measure:holes              audit table (authored face vs measured)
 *   npm run measure:holes -- --emit    regenerate src/data/measuredHoleSeats.ts
 *   npm run measure:holes -- 228-2500-017    filter to one part
 */
import fs from 'node:fs'
import path from 'node:path'
import { PARTS } from '../src/data/parts'
import { getSnapPointResolution } from '../src/data/snapOverrides'
import { PIN_FIT } from '../src/data/snapCalibration'
import { recentredVertices, type Vec } from './lib/glb'
import type { PartDefinition, SnapPointDefinition, Vec3 } from '../src/types/assembly'

/** Just clear of the bore wall, so bore vertices are not read as a seat. */
const RADIAL_EPS = 0.004
/** A collar cannot land outside its own radius. */
const R_INNER = PIN_FIT.holeRadius + RADIAL_EPS
const R_OUTER = PIN_FIT.collarRadius
/**
 * How far in from the authored face a seat may be and still belong to THIS
 * hole. A quarter of a beam thickness: deeper than any moulded pocket in the
 * catalog, shallower than the far side of the thinnest receiver.
 */
const MAX_SEAT_RECESS = 0.06
/** Material slightly proud of the authored face is a boss, not an error. */
const SKIN_TOLERANCE = 0.006
/** Vertices that must agree on the plane before it counts as measured. */
const MIN_SUPPORT = 6
/** Vertices this close to the extreme count as the same plane. */
const PLANE_TOLERANCE = 0.004
/** Holes within this of the part's modal seat share the per-part default. */
const UNIFORM_TOLERANCE = 0.002

export type HoleSeatMeasurement = {
  partId: string
  partNumber: string | null
  snapId: string
  /** Signed axial distance from the marker along the OUTWARD normal. */
  seatOffset: number
  /** Mesh vertices supporting that plane. */
  support: number
}

function axisIndexOf(snap: SnapPointDefinition): number {
  const axis = (snap.mateFrame?.axis ?? snap.axis ?? snap.normal ?? [0, 0, -1]) as Vec3
  return axis.findIndex((c) => Math.abs(c) > 0.9)
}

/**
 * Measure one receiving hole. `outward` is the direction a pin comes FROM, so
 * the seat is the material with the largest outward coordinate inside the
 * collar annulus.
 */
export function measureHoleSeat(
  verts: Vec[],
  snap: SnapPointDefinition,
): { seatOffset: number; support: number } | null {
  const ai = axisIndexOf(snap)
  if (ai < 0) return null
  const axis = (snap.mateFrame?.axis ?? snap.axis ?? snap.normal ?? [0, 0, -1]) as Vec3
  const inwardSign = Math.sign(axis[ai])
  const marker = (snap.mateFrame?.position ?? snap.position) as Vec3
  const plane = [0, 1, 2].filter((k) => k !== ai) as [number, number]

  const ring: number[] = []
  for (const v of verts) {
    const du = v[plane[0]] - marker[plane[0]]
    const dv = v[plane[1]] - marker[plane[1]]
    const r = Math.hypot(du, dv)
    if (r < R_INNER || r > R_OUTER) continue
    const t = -inwardSign * (v[ai] - marker[ai])
    if (t > SKIN_TOLERANCE || t < -MAX_SEAT_RECESS) continue
    ring.push(t)
  }
  if (!ring.length) return null
  const seatOffset = Math.max(...ring)
  const support = ring.filter((t) => seatOffset - t < PLANE_TOLERANCE).length
  if (support < MIN_SUPPORT) return null
  return { seatOffset, support }
}

function isReceivingHole(snap: SnapPointDefinition): boolean {
  return snap.type === 'hole' && snap.role === 'receive'
}

type Row = {
  def: PartDefinition
  snap: SnapPointDefinition
  measured: { seatOffset: number; support: number } | null
}

export function auditHoleSeats(filter?: string): Row[] {
  const rows: Row[] = []
  for (const def of PARTS) {
    if (filter) {
      const hay = `${def.id} ${def.name} ${def.partNumber ?? ''}`.toLowerCase()
      if (!hay.includes(filter.toLowerCase())) continue
    }
    // Resolve WITHOUT this table applied would be ideal, but the offsets are
    // measured from the MARKER, which no layer here moves — so the resolved
    // snaps are a fixed point and plain resolution is safe to measure from.
    const snaps = getSnapPointResolution(def).snapPoints.filter(isReceivingHole)
    if (!snaps.length) continue
    const verts = recentredVertices(def)
    for (const snap of snaps) {
      rows.push({
        def,
        snap,
        measured: verts ? measureHoleSeat(verts, snap) : null,
      })
    }
  }
  return rows
}

/** Per-part modal seat plus the holes that genuinely differ from it. */
function compress(rows: Row[]): Map<
  string,
  { seatOffset: number; bySnapId: Record<string, number>; measured: number; total: number }
> {
  const byPart = new Map<string, Row[]>()
  for (const r of rows) {
    const key = r.def.partNumber ?? r.def.id
    if (!byPart.has(key)) byPart.set(key, [])
    byPart.get(key)!.push(r)
  }
  const out = new Map<
    string,
    { seatOffset: number; bySnapId: Record<string, number>; measured: number; total: number }
  >()
  for (const [key, partRows] of byPart) {
    const measured = partRows.filter((r) => r.measured)
    if (!measured.length) continue
    const counts = new Map<number, number>()
    for (const r of measured) {
      const v = round(r.measured!.seatOffset)
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    const modal = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
    const bySnapId: Record<string, number> = {}
    for (const r of measured) {
      const v = round(r.measured!.seatOffset)
      if (Math.abs(v - modal) > UNIFORM_TOLERANCE) bySnapId[r.snap.id] = v
    }
    out.set(key, {
      seatOffset: modal,
      bySnapId,
      measured: measured.length,
      total: partRows.length,
    })
  }
  return out
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}

function fmt(n: number | null | undefined, w = 9) {
  if (n == null || Number.isNaN(n)) return '—'.padStart(w)
  return ((n >= 0 ? '+' : '') + n.toFixed(4)).padStart(w)
}

function emit(rows: Row[]) {
  const table = compress(rows)
  const lines: string[] = []
  lines.push('// AUTO-GENERATED by `npm run measure:holes -- --emit`.')
  lines.push('// Do not hand-edit — rerun the script to refresh.')
  lines.push('//')
  lines.push('// The REAL seating plane of every receiving pin hole, measured from the')
  lines.push('// converted GLB meshes: the outermost material in the collar annulus about')
  lines.push('// the hole axis — the surface a connector actually lands on. A VEX IQ hole')
  lines.push('// sits at the bottom of a moulded pocket, so this is typically ~0.030 INSIDE')
  lines.push("// the part's outer skin, which is where the authored metadata used to put it.")
  lines.push('//')
  lines.push('// `seatOffset` is the signed axial distance from the hole MARKER')
  lines.push('// (`mateFrame.position`) along its OUTWARD normal. Negative = recessed into')
  lines.push('// the part. Holes absent from this table had no confident ring of material')
  lines.push('// near their face and keep their authored face plane.')
  lines.push('')
  lines.push('export type MeasuredHoleSeats = {')
  lines.push('  /** Seat offset shared by most of the part’s holes. */')
  lines.push('  seatOffset: number')
  lines.push('  /** Holes whose measured seat differs from that default. */')
  lines.push('  bySnapId?: Record<string, number>')
  lines.push('}')
  lines.push('')
  lines.push('export const MEASURED_HOLE_SEATS: Record<string, MeasuredHoleSeats> = {')
  for (const key of [...table.keys()].sort()) {
    const entry = table.get(key)!
    const ids = Object.keys(entry.bySnapId).sort()
    if (!ids.length) {
      lines.push(`  ${JSON.stringify(key)}: { seatOffset: ${entry.seatOffset.toFixed(4)} },`)
      continue
    }
    lines.push(`  ${JSON.stringify(key)}: {`)
    lines.push(`    seatOffset: ${entry.seatOffset.toFixed(4)},`)
    lines.push('    bySnapId: {')
    for (const id of ids) {
      lines.push(`      ${JSON.stringify(id)}: ${entry.bySnapId[id].toFixed(4)},`)
    }
    lines.push('    },')
    lines.push('  },')
  }
  lines.push('}')
  lines.push('')
  fs.writeFileSync('src/data/measuredHoleSeats.ts', lines.join('\n'))
  const overrides = [...table.values()].reduce(
    (n, e) => n + Object.keys(e.bySnapId).length,
    0,
  )
  console.log(
    `emitted src/data/measuredHoleSeats.ts — ${table.size} parts, ` +
      `${rows.filter((r) => r.measured).length}/${rows.length} holes measured, ` +
      `${overrides} per-hole exceptions`,
  )
}

function main() {
  const args = process.argv.slice(2)
  const filter = args.find((a) => !a.startsWith('--'))
  const rows = auditHoleSeats(filter)

  if (args.includes('--emit')) {
    emit(rows)
    return
  }

  console.log('\n=== receiving-hole seat audit (authored face vs measured mesh) ===\n')
  console.log(
    'part'.padEnd(20) +
      'hole'.padEnd(18) +
      'authored'.padStart(9) +
      'measured'.padStart(10) +
      'delta'.padStart(10) +
      'support'.padStart(9),
  )
  let moved = 0
  let unmeasured = 0
  for (const r of rows) {
    const key = r.def.partNumber ?? r.def.id
    if (!r.measured) {
      unmeasured++
      continue
    }
    // The authored face expressed in the same marker-relative terms.
    const ai = axisIndexOf(r.snap)
    const axis = (r.snap.mateFrame?.axis ?? r.snap.axis ?? [0, 0, -1]) as Vec3
    const marker = (r.snap.mateFrame?.position ?? r.snap.position) as Vec3
    const face = (r.snap.facePosition ?? marker) as Vec3
    const authored = -Math.sign(axis[ai]) * (face[ai] - marker[ai])
    const delta = r.measured.seatOffset - authored
    if (Math.abs(delta) > 0.002) moved++
    if (filter) {
      console.log(
        key.padEnd(20) +
          r.snap.id.padEnd(18) +
          fmt(authored) +
          fmt(r.measured.seatOffset, 10) +
          fmt(delta, 10) +
          String(r.measured.support).padStart(9) +
          (Math.abs(delta) > 0.002 ? '  <-- MOVES' : ''),
      )
    }
  }
  const table = compress(rows)
  if (!filter) {
    console.log(
      'part'.padEnd(20) + 'name'.padEnd(44) + 'seat'.padStart(9) + 'holes'.padStart(8) + 'exceptions'.padStart(12),
    )
    for (const key of [...table.keys()].sort()) {
      const e = table.get(key)!
      const name = PARTS.find((p) => (p.partNumber ?? p.id) === key)?.name ?? ''
      console.log(
        key.padEnd(20) +
          name.slice(0, 43).padEnd(44) +
          fmt(e.seatOffset) +
          String(e.measured).padStart(8) +
          String(Object.keys(e.bySnapId).length).padStart(12),
      )
    }
  }
  console.log(
    `\n${rows.length} receiving holes; ${moved} would move by > 0.002; ` +
      `${unmeasured} have no confident seat ring (authored face kept).`,
  )
}

if (path.basename(process.argv[1] ?? '') === 'measure-hole-seats.ts') main()
