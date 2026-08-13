/**
 * Find every molded MALE peg in the catalog straight from the converted GLB
 * meshes, and report the ones no snap point covers.
 *
 * Why this exists: the peg table (`MOLDED_PEGS` in
 * `src/data/snapOverrides.ts`) was hand-entered from an earlier measurement
 * pass, and a part whose pegs were only partly transcribed looks completely
 * normal in the app — the markers that ARE there work, so nothing reports the
 * missing end. That is a silent hole in the metadata: the user cannot mate the
 * uncovered end at all. This script closes it by asking the mesh instead.
 *
 * A peg is defined here the way the plastic defines it:
 *
 *   A round protrusion at an outer extreme of the part, whose cross-section is
 *   pin-sized (so it can enter a beam hole), standing proud of the body wall by
 *   a meaningful distance.
 *
 * The shoulder — the plane where the peg meets the body, which is what the peg
 * table stores as `base` — is measured with the same rule the pin-contact
 * measurement uses (`measureEndpoint`): walking inward from the tip, the first
 * plane whose radius can no longer pass through a pin hole.
 *
 * Coordinates are in the bbox-recentred local frame `ScenePart.tsx` renders in,
 * which is the frame all snap metadata is authored in.
 *
 * Run:
 *   npm run audit:pegs                    parts with uncovered pegs
 *   npm run audit:pegs -- --all           every part that has any peg
 *   npm run audit:pegs -- 228-2500-277    filter to one part
 */
import path from 'node:path'
import { PARTS } from '../src/data/parts'
import { getSnapPoints } from '../src/data/snapOverrides'
import { PIN_FIT } from '../src/data/snapCalibration'
import { measureEndpoint } from './measure-pin-contacts'
import { recentredVertices, type Vec } from './lib/glb'
import type { PartDefinition, SnapPointDefinition } from '../src/types/assembly'

/**
 * A VEX IQ pin/peg shaft is ~0.18 across in world units (hole pitch 0.5). The
 * window is wide enough for the flanged/finned variants and narrow enough to
 * reject a body corner or a beam end.
 */
const PEG_HALF_WIDTH_MIN = 0.055
const PEG_HALF_WIDTH_MAX = 0.125
/** A peg is round: its two in-plane half-widths agree. */
const PEG_ROUNDNESS_TOL = 0.035
/** Minimum stand-proud distance. Real pegs protrude ~0.24. */
const MIN_PROTRUSION = 0.1
/** Tip slab thickness — the flat end face of the peg. */
const TIP_SLAB = 0.015
/** Cluster cell size for separating pegs from each other (pitch is 0.5). */
const CLUSTER_CELL = 0.05
/** A declared endpoint this close to a measured peg is that peg. */
const MATCH_TOL = 0.06

export type MeasuredPeg = {
  axis: 0 | 1 | 2
  sign: 1 | -1
  /** Shoulder position — where the peg meets the body wall. */
  base: [number, number, number]
  /** Tip position. */
  tip: [number, number, number]
  protrusion: number
  radius: number
  support: number
}

/** Group tip-plane vertices into per-peg clusters via occupied-cell flood fill. */
function clusterTipVertices(
  tipVerts: Vec[],
  plane: [number, number],
): Vec[][] {
  const cells = new Map<string, Vec[]>()
  const key = (i: number, j: number) => `${i},${j}`
  for (const v of tipVerts) {
    const i = Math.floor(v[plane[0]] / CLUSTER_CELL)
    const j = Math.floor(v[plane[1]] / CLUSTER_CELL)
    const k = key(i, j)
    const bucket = cells.get(k)
    if (bucket) bucket.push(v)
    else cells.set(k, [v])
  }
  const seen = new Set<string>()
  const clusters: Vec[][] = []
  for (const start of cells.keys()) {
    if (seen.has(start)) continue
    seen.add(start)
    const queue = [start]
    const members: Vec[] = []
    while (queue.length) {
      const cur = queue.pop()!
      members.push(...cells.get(cur)!)
      const [ci, cj] = cur.split(',').map(Number)
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const nk = key(ci + di, cj + dj)
          if (cells.has(nk) && !seen.has(nk)) {
            seen.add(nk)
            queue.push(nk)
          }
        }
      }
    }
    clusters.push(members)
  }
  return clusters
}

/** Every peg-shaped protrusion on a part's six outer extremes. */
export function measurePegs(verts: Vec[]): MeasuredPeg[] {
  const out: MeasuredPeg[] = []
  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis++) {
    for (const sign of [1, -1] as const) {
      const extreme = Math.max(...verts.map((v) => sign * v[axis]))
      const tipVerts = verts.filter((v) => sign * v[axis] >= extreme - TIP_SLAB)
      const plane = [0, 1, 2].filter((k) => k !== axis) as [number, number]
      for (const cluster of clusterTipVertices(tipVerts, plane)) {
        const half: number[] = []
        const centre: Vec = [0, 0, 0]
        centre[axis] = sign * extreme
        for (const p of plane) {
          const lo = Math.min(...cluster.map((v) => v[p]))
          const hi = Math.max(...cluster.map((v) => v[p]))
          half.push((hi - lo) / 2)
          centre[p] = (lo + hi) / 2
        }
        if (half.some((h) => h < PEG_HALF_WIDTH_MIN || h > PEG_HALF_WIDTH_MAX)) continue
        if (Math.abs(half[0] - half[1]) > PEG_ROUNDNESS_TOL) continue

        // Outward axis = the direction the peg travels INTO a receiving hole,
        // which is exactly the axis `measureEndpoint` expects.
        const outward: Vec = [0, 0, 0]
        outward[axis] = sign
        const m = measureEndpoint(verts, centre, outward)
        if (!m) continue
        // `centre` sits on the tip plane, so the shoulder reads as a negative
        // offset: how far back down the peg the body wall is.
        const protrusion = -m.shoulderOffset
        if (protrusion < MIN_PROTRUSION) continue
        const base: [number, number, number] = [...centre] as [number, number, number]
        base[axis] = centre[axis] + m.shoulderOffset * sign
        out.push({
          axis,
          sign,
          base,
          tip: [...centre] as [number, number, number],
          protrusion,
          radius: Math.max(half[0], half[1]),
          support: m.support,
        })
      }
    }
  }
  return out
}

/** Declared endpoints that can plug INTO something (pegs, pins, shafts). */
function insertEndpoints(def: PartDefinition): SnapPointDefinition[] {
  return getSnapPoints(def).filter((s) => s.role === 'insert')
}

function nearestEndpoint(
  peg: MeasuredPeg,
  snaps: SnapPointDefinition[],
): { snap: SnapPointDefinition; dist: number } | null {
  let best: { snap: SnapPointDefinition; dist: number } | null = null
  for (const snap of snaps) {
    const axisVec = snap.mateFrame?.axis ?? snap.axis ?? snap.normal
    // Only an endpoint pointing the same way out of the part can be this peg.
    if (!axisVec || Math.round(axisVec[peg.axis]) !== peg.sign) continue
    // An endpoint may sit on the peg's shoulder (`seatFrame` — where the
    // measurement lands) or keep its visual marker elsewhere on the shaft
    // (`position`/`mateFrame`, as the standoffs and multi-station pins do).
    // Either one identifies the peg, so take whichever is closest.
    const candidates = [
      snap.seatFrame?.position ?? snap.seatPosition,
      snap.mateFrame?.position,
      snap.position,
    ].filter(Boolean) as Array<readonly number[]>
    for (const p of candidates) {
      const dist = Math.hypot(
        p[0] - peg.base[0],
        p[1] - peg.base[1],
        p[2] - peg.base[2],
      )
      if (!best || dist < best.dist) best = { snap, dist }
    }
  }
  return best
}

export type PegAuditRow = {
  def: PartDefinition
  pegs: Array<{
    peg: MeasuredPeg
    match: { snap: SnapPointDefinition; dist: number } | null
  }>
  uncovered: number
}

export function auditPegs(filter?: string): PegAuditRow[] {
  const rows: PegAuditRow[] = []
  for (const def of PARTS) {
    if (filter) {
      const hay = `${def.id} ${def.name} ${def.partNumber ?? ''}`.toLowerCase()
      if (!hay.includes(filter.toLowerCase())) continue
    }
    const verts = recentredVertices(def)
    if (!verts || verts.length === 0) continue
    const pegs = measurePegs(verts)
    if (!pegs.length) continue
    const snaps = insertEndpoints(def)
    const entries = pegs.map((peg) => {
      const near = nearestEndpoint(peg, snaps)
      return { peg, match: near && near.dist <= MATCH_TOL ? near : null }
    })
    rows.push({
      def,
      pegs: entries,
      uncovered: entries.filter((e) => !e.match).length,
    })
  }
  return rows
}

function fmtVec(v: [number, number, number]) {
  return `[${v.map((n) => n.toFixed(3)).join(', ')}]`
}

/**
 * The peg table stores `base` on the BODY WALL, while the measurement lands on
 * the peg's collar face — the raised ring the receiving part actually stops
 * against, which stands 0.035 proud of the wall (verified on the 228-2500-277
 * radius profile: body to 0.750, collar r=0.125 to 0.785, then the 0.083 shaft).
 * Both describe the same peg and the seat is re-derived from the mesh either
 * way, so new rows step back to the wall to match every existing row.
 */
const COLLAR_HEIGHT = 0.035

/** Ready-to-paste `MOLDED_PEGS` rows for the pegs no endpoint covers. */
function emitMissing(rows: PegAuditRow[]) {
  for (const row of rows) {
    if (!row.uncovered) continue
    const entries = row.pegs
      .filter((p) => !p.match)
      .map(({ peg }) => {
        const base = [...peg.base] as [number, number, number]
        base[peg.axis] -= peg.sign * COLLAR_HEIGHT
        const nums = base.map((n) => Number(n.toFixed(3)) + 0)
        return `{ axis: '${'xyz'[peg.axis]}', sign: ${peg.sign}, base: [${nums.join(', ')}] }`
      })
    console.log(
      `  '${row.def.partNumber}': [${entries.join(', ')}], // ${row.def.name}`,
    )
  }
}

function main() {
  const args = process.argv.slice(2)
  const showAll = args.includes('--all')
  const filter = args.find((a) => !a.startsWith('--'))
  const rows = auditPegs(filter)
  if (args.includes('--emit-missing')) {
    emitMissing(rows)
    return
  }
  const shown = showAll || filter ? rows : rows.filter((r) => r.uncovered > 0)

  console.log('\n=== molded peg audit (mesh protrusions vs declared endpoints) ===\n')
  for (const row of shown) {
    const key = row.def.partNumber ?? row.def.id
    console.log(
      `${key.padEnd(16)} ${row.def.name}` +
        (row.uncovered ? `   <-- ${row.uncovered} UNCOVERED` : ''),
    )
    for (const { peg, match } of row.pegs) {
      const dir = `${peg.sign > 0 ? '+' : '-'}${'XYZ'[peg.axis]}`
      console.log(
        `    ${dir}  base ${fmtVec(peg.base).padEnd(26)}` +
          ` out ${peg.protrusion.toFixed(3)}  r ${peg.radius.toFixed(3)}  n=${String(
            peg.support,
          ).padStart(4)}  ` +
          (match
            ? `covered by ${match.snap.id} (${match.snap.type}, d=${match.dist.toFixed(3)})`
            : 'NO SNAP POINT'),
      )
    }
  }
  const totalPegs = rows.reduce((n, r) => n + r.pegs.length, 0)
  const totalUncovered = rows.reduce((n, r) => n + r.uncovered, 0)
  console.log(
    `\n${rows.length} parts carry pegs; ${totalPegs} pegs measured; ` +
      `${totalUncovered} have no snap point ` +
      `(${rows.filter((r) => r.uncovered > 0).length} parts affected).`,
  )
  console.log(
    `hole radius used for the shoulder rule: ${PIN_FIT.holeRadius} ` +
      `(+${PIN_FIT.fitTolerance} tolerance)`,
  )
}

if (path.basename(process.argv[1] ?? '') === 'audit-connector-pegs.ts') main()
