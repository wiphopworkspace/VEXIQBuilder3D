/*
 * Headless part-hole audit + measured-hole generator.
 *
 * Usage:
 *   npx tsx scripts/audit-part-holes.ts                 # audit all GLB parts
 *   npx tsx scripts/audit-part-holes.ts --emit          # + write src/data/measuredPartHoles.ts
 *   npx tsx scripts/audit-part-holes.ts <id-substring>  # verbose audit of matching parts
 *
 * Technique (HANDOFF.md "Measuring Parts"): parse each converted GLB directly
 * (no WebGL), recenter on the bbox center (the frame ScenePart renders in and
 * all snap overrides are authored in), then for each of the 3 local axes cast
 * a fine grid of axis-parallel lines through the part. A line that crosses
 * ZERO triangles travels through open air; flood-filling the open cells and
 * dropping border-connected clusters leaves the interior through-holes.
 * Pin-sized clusters become measured hole centers, which are compared against
 * the part's resolved snap points (getSnapPointResolution).
 *
 * Detection sees THROUGH-holes only: blind sockets (Smart Motor mounts,
 * standoff ends) never zero the crossing count, so single-sided snap points
 * are reported as "blind (unverifiable)" rather than wrong.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARTS } from '../src/data/parts'
import { getSnapPointResolution } from '../src/data/snapOverrides'
import type { PartDefinition, SnapPointDefinition } from '../src/types/assembly'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES = 0.025 // sampling grid resolution (world units)
const BUCKET = 0.12 // triangle bucket cell size
const MATCH_TOL = 0.09 // in-plane snap<->detected match tolerance
// Pin-sized through-hole classification (in-plane extents, world units).
// Measured on the converted GLBs, a beam pin hole spans ~0.15-0.17.
const HOLE_MIN_EXTENT = 0.125
const HOLE_MAX_EXTENT = 0.34
const DETECT_MIN_EXTENT = 0.08 // smaller clusters still reported, never emitted
// A ring sample is only trusted for face measurement when the material there is
// no thicker than a plausible beam/plate wall — this rejects samples that land
// on a perpendicular rising leg (L-brackets) whose top face is far away.
const MAX_WALL_THICKNESS = 0.7

// ---------------------------------------------------------------------------
// GLB parsing (12-byte header + JSON/BIN chunks), world-transformed triangles
// ---------------------------------------------------------------------------

type Mesh = { verts: Float64Array; tris: Uint32Array }

function parseGLB(file: string): { json: any; bin: Buffer } {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb')
  let off = 12
  let json: any = null
  let bin: Buffer | null = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004e4942) bin = data
    off += 8 + len
  }
  if (!json || !bin) throw new Error('missing chunk')
  return { json, bin }
}

function matMul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}

function trsMatrix(n: any): number[] {
  if (n.matrix) return n.matrix
  const t = n.translation ?? [0, 0, 0]
  const q = n.rotation ?? [0, 0, 0, 1]
  const s = n.scale ?? [1, 1, 1]
  const [x, y, z, w] = q
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]
}

function readAccessorIndices(json: any, bin: Buffer, index: number): number[] {
  const acc = json.accessors[index]
  const bv = json.bufferViews[acc.bufferView]
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const out: number[] = new Array(acc.count)
  if (acc.componentType === 5123) {
    for (let i = 0; i < acc.count; i++) out[i] = bin.readUInt16LE(start + i * 2)
  } else if (acc.componentType === 5125) {
    for (let i = 0; i < acc.count; i++) out[i] = bin.readUInt32LE(start + i * 4)
  } else if (acc.componentType === 5121) {
    for (let i = 0; i < acc.count; i++) out[i] = bin.readUInt8(start + i)
  } else {
    throw new Error(`unsupported index componentType ${acc.componentType}`)
  }
  return out
}

function loadMesh(file: string): Mesh {
  const { json, bin } = parseGLB(file)
  const verts: number[] = []
  const tris: number[] = []
  const visit = (nodeIndex: number, parent: number[]) => {
    const node = json.nodes[nodeIndex]
    const m = matMul(parent, trsMatrix(node))
    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) continue
        const posIndex = prim.attributes?.POSITION
        if (posIndex == null) continue
        const acc = json.accessors[posIndex]
        const bv = json.bufferViews[acc.bufferView]
        const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
        const stride = bv.byteStride ?? 12
        const base = verts.length / 3
        for (let i = 0; i < acc.count; i++) {
          const b = start + i * stride
          const x = bin.readFloatLE(b)
          const y = bin.readFloatLE(b + 4)
          const z = bin.readFloatLE(b + 8)
          verts.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          )
        }
        if (prim.indices != null) {
          for (const ix of readAccessorIndices(json, bin, prim.indices)) {
            tris.push(base + ix)
          }
        } else {
          for (let i = 0; i < acc.count; i++) tris.push(base + i)
        }
      }
    }
    for (const c of node.children ?? []) visit(c, m)
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const scene = json.scenes[json.scene ?? 0]
  for (const n of scene.nodes) visit(n, identity)

  // Recenter on the bbox center — the same frame ScenePart's GLBModel renders
  // in, so detected coordinates line up with authored snap metadata.
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < verts.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const c = verts[i + k]
      if (c < min[k]) min[k] = c
      if (c > max[k]) max[k] = c
    }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  for (let i = 0; i < verts.length; i += 3)
    for (let k = 0; k < 3; k++) verts[i + k] -= center[k]
  return { verts: Float64Array.from(verts), tris: Uint32Array.from(tris) }
}

// ---------------------------------------------------------------------------
// Through-hole detection along one axis (raycast parity + flood fill)
// ---------------------------------------------------------------------------

export type DetectedHole = {
  axis: 0 | 1 | 2
  u: number // in-plane center, first plane axis (ascending axis order)
  v: number // in-plane center, second plane axis
  extentU: number
  extentV: number
  cells: number
  faceMin: number // outer material face along the hole axis (from ring samples)
  faceMax: number
  pinSized: boolean
}

function detectHolesAlongAxis(mesh: Mesh, axis: 0 | 1 | 2): DetectedHole[] {
  const { verts, tris } = mesh
  const plane = [0, 1, 2].filter((i) => i !== axis) as [number, number]
  const [ua, va] = plane

  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  let minW = Infinity
  let maxW = -Infinity
  for (let i = 0; i < verts.length; i += 3) {
    const u = verts[i + ua]
    const v = verts[i + va]
    const w = verts[i + axis]
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
    if (w < minW) minW = w
    if (w > maxW) maxW = w
  }
  const sizeU = maxU - minU
  const sizeV = maxV - minV
  if (!(sizeU > RES * 2 && sizeV > RES * 2)) return []

  // Project triangles; skip ray-parallel (degenerate-in-plane) walls.
  const triCount = tris.length / 3
  const t2d: number[][] = []
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[t * 3] * 3
    const i1 = tris[t * 3 + 1] * 3
    const i2 = tris[t * 3 + 2] * 3
    const ax = verts[i0 + ua]
    const ay = verts[i0 + va]
    const bx = verts[i1 + ua]
    const by = verts[i1 + va]
    const cx = verts[i2 + ua]
    const cy = verts[i2 + va]
    const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(det) < 1e-10) continue
    const aw = verts[i0 + axis]
    const bw = verts[i1 + axis]
    const cw = verts[i2 + axis]
    t2d.push([
      ax, ay, bx, by, cx, cy,
      Math.min(ax, bx, cx), Math.min(ay, by, cy),
      Math.max(ax, bx, cx), Math.max(ay, by, cy),
      det, aw, bw, cw,
    ])
  }

  // Bucket triangles by 2D bbox so each sample only tests nearby triangles.
  const bu = Math.max(1, Math.ceil(sizeU / BUCKET))
  const bv = Math.max(1, Math.ceil(sizeV / BUCKET))
  const buckets: number[][] = Array.from({ length: bu * bv }, () => [])
  const bIndex = (u: number, v: number) => {
    let iu = Math.floor((u - minU) / BUCKET)
    let iv = Math.floor((v - minV) / BUCKET)
    if (iu < 0) iu = 0
    if (iu >= bu) iu = bu - 1
    if (iv < 0) iv = 0
    if (iv >= bv) iv = bv - 1
    return iv * bu + iu
  }
  for (let t = 0; t < t2d.length; t++) {
    const tri = t2d[t]
    const iu0 = Math.max(0, Math.floor((tri[6] - minU) / BUCKET))
    const iv0 = Math.max(0, Math.floor((tri[7] - minV) / BUCKET))
    const iu1 = Math.min(bu - 1, Math.floor((tri[8] - minU) / BUCKET))
    const iv1 = Math.min(bv - 1, Math.floor((tri[9] - minV) / BUCKET))
    for (let iv = iv0; iv <= iv1; iv++)
      for (let iu = iu0; iu <= iu1; iu++) buckets[iv * bu + iu].push(t)
  }

  const contains = (tri: number[], px: number, py: number): boolean => {
    if (px < tri[6] || px > tri[8] || py < tri[7] || py > tri[9]) return false
    const [ax, ay, bx, by, cx, cy] = tri
    const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx)
    const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
  }

  // Sample grid, centered in the bbox. Tiny irrational jitter keeps samples off
  // exact mesh edges (a point exactly on a shared edge counts both triangles).
  const nu = Math.max(2, Math.floor(sizeU / RES))
  const nv = Math.max(2, Math.floor(sizeV / RES))
  const startU = minU + (sizeU - (nu - 1) * RES) / 2 + 1.234e-4
  const startV = minV + (sizeV - (nv - 1) * RES) / 2 + 2.345e-4
  const open = new Uint8Array(nu * nv)
  for (let jv = 0; jv < nv; jv++) {
    const pv = startV + jv * RES
    for (let ju = 0; ju < nu; ju++) {
      const pu = startU + ju * RES
      let crossings = 0
      for (const t of buckets[bIndex(pu, pv)]) {
        if (contains(t2d[t], pu, pv)) crossings++
      }
      if (crossings === 0) open[jv * nu + ju] = 1
    }
  }

  // Flood fill open cells (4-connected); drop border-connected exterior air.
  const cluster = new Int32Array(nu * nv).fill(-1)
  const clusters: Array<{
    cells: number[]
    border: boolean
  }> = []
  const stack: number[] = []
  for (let seed = 0; seed < nu * nv; seed++) {
    if (!open[seed] || cluster[seed] !== -1) continue
    const id = clusters.length
    const c = { cells: [] as number[], border: false }
    clusters.push(c)
    cluster[seed] = id
    stack.push(seed)
    while (stack.length) {
      const cell = stack.pop()!
      c.cells.push(cell)
      const ju = cell % nu
      const jv = (cell / nu) | 0
      if (ju === 0 || ju === nu - 1 || jv === 0 || jv === nv - 1) c.border = true
      const neighbors = [cell - 1, cell + 1, cell - nu, cell + nu]
      if (ju === 0) neighbors[0] = -1
      if (ju === nu - 1) neighbors[1] = -1
      for (const n of neighbors) {
        if (n < 0 || n >= nu * nv) continue
        if (open[n] && cluster[n] === -1) {
          cluster[n] = id
          stack.push(n)
        }
      }
    }
  }

  // Material faces along the axis around the hole. VEX IQ beams are ribbed:
  // thin web (±0.039), a boss ring around each hole (±0.09), and the outer
  // envelope rails (±0.12) — and the calibrated hole convention places the
  // receiving faces on the OUTER envelope. Sample a disc of rings around the
  // hole and take the widest span among samples whose local material is
  // wall-thin (rejects samples landing on perpendicular rising legs).
  const faceRange = (cu: number, cv: number, holeR: number): [number, number] => {
    const samples: Array<[number, number]> = []
    for (const ringR of [
      holeR + RES * 1.5,
      holeR + 0.08,
      holeR + 0.11,
      holeR + 0.14,
      holeR + 0.17,
    ]) {
      for (let s = 0; s < 16; s++) {
        const angle = (s / 16) * Math.PI * 2 + ringR // ringR de-phases the rings
        const pu = cu + Math.cos(angle) * ringR
        const pv = cv + Math.sin(angle) * ringR
        let lo = Infinity
        let hi = -Infinity
        for (const t of buckets[bIndex(pu, pv)]) {
          const tri = t2d[t]
          if (!contains(tri, pu, pv)) continue
          // Interpolate the axis coordinate at (pu, pv) barycentrically.
          const [ax, ay, bx, by, cx, cy, , , , , det, aw, bw, cw] = tri
          const w0 = ((bx - pu) * (cy - pv) - (by - pv) * (cx - pu)) / det
          const w1 = ((cx - pu) * (ay - pv) - (cy - pv) * (ax - pu)) / det
          const w2 = 1 - w0 - w1
          const w = w0 * aw + w1 * bw + w2 * cw
          if (w < lo) lo = w
          if (w > hi) hi = w
        }
        if (lo !== Infinity) samples.push([lo, hi])
      }
    }
    const thin = samples.filter(([lo, hi]) => hi - lo <= MAX_WALL_THICKNESS)
    const usable = thin.length > 0 ? thin : samples
    if (usable.length === 0) return [minW, maxW]
    let lo = Infinity
    let hi = -Infinity
    for (const [slo, shi] of usable) {
      if (slo < lo) lo = slo
      if (shi > hi) hi = shi
    }
    return [lo, hi]
  }

  const out: DetectedHole[] = []
  for (const c of clusters) {
    if (c.border || c.cells.length < 3) continue
    let cMinU = Infinity
    let cMaxU = -Infinity
    let cMinV = Infinity
    let cMaxV = -Infinity
    let sumU = 0
    let sumV = 0
    for (const cell of c.cells) {
      const pu = startU + (cell % nu) * RES
      const pv = startV + ((cell / nu) | 0) * RES
      if (pu < cMinU) cMinU = pu
      if (pu > cMaxU) cMaxU = pu
      if (pv < cMinV) cMinV = pv
      if (pv > cMaxV) cMaxV = pv
      sumU += pu
      sumV += pv
    }
    const extentU = cMaxU - cMinU + RES
    const extentV = cMaxV - cMinV + RES
    if (extentU < DETECT_MIN_EXTENT || extentV < DETECT_MIN_EXTENT) continue
    if (extentU > HOLE_MAX_EXTENT || extentV > HOLE_MAX_EXTENT) continue
    const cu = sumU / c.cells.length
    const cv = sumV / c.cells.length
    const [faceMin, faceMax] = faceRange(cu, cv, Math.max(extentU, extentV) / 2)
    const pinSized =
      extentU >= HOLE_MIN_EXTENT &&
      extentV >= HOLE_MIN_EXTENT &&
      Math.max(extentU, extentV) / Math.min(extentU, extentV) < 1.8
    out.push({
      axis,
      u: round3(cu),
      v: round3(cv),
      extentU: round3(extentU),
      extentV: round3(extentV),
      cells: c.cells.length,
      faceMin: round3(faceMin),
      faceMax: round3(faceMax),
      pinSized,
    })
  }
  return out
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Snap-point side: resolved hole groups (front/back faces -> physical center)
// ---------------------------------------------------------------------------

type SnapHoleGroup = {
  key: string
  axis: 0 | 1 | 2
  u: number
  v: number
  along: number
  blind: boolean // single-sided socket — through-ray parity can't verify it
  ids: string[]
}

function dominantAxis(p: SnapPointDefinition): 0 | 1 | 2 {
  const a = p.axis ?? p.normal ?? [0, 0, 1]
  const abs = a.map(Math.abs)
  return abs.indexOf(Math.max(...abs)) as 0 | 1 | 2
}

function snapHoleGroups(snaps: SnapPointDefinition[]): SnapHoleGroup[] {
  const holes = snaps.filter((p) => p.type === 'hole')
  const byGroup = new Map<string, SnapPointDefinition[]>()
  for (const p of holes) {
    const key = p.occupancyGroup ?? p.id
    const list = byGroup.get(key)
    if (list) list.push(p)
    else byGroup.set(key, [p])
  }
  const out: SnapHoleGroup[] = []
  for (const [key, members] of byGroup) {
    const axis = dominantAxis(members[0])
    const plane = [0, 1, 2].filter((i) => i !== axis) as [number, number]
    let su = 0
    let sv = 0
    let sw = 0
    for (const m of members) {
      su += m.position[plane[0]]
      sv += m.position[plane[1]]
      sw += m.position[axis]
    }
    out.push({
      key,
      axis,
      u: su / members.length,
      v: sv / members.length,
      along: sw / members.length,
      blind: members.length === 1,
      ids: members.map((m) => m.id),
    })
  }
  return out
}

// In-plane centers of ALL snap points (any type), grouped, per axis — used by
// the supplemental-hole guard so a measured hole is never emitted on top of an
// existing snap feature (gear/wheel centers, axle bores, blind sockets, pegs).
function allSnapGroupCenters(
  snaps: SnapPointDefinition[],
): Array<{ axis: 0 | 1 | 2; u: number; v: number }> {
  const byGroup = new Map<string, SnapPointDefinition[]>()
  for (const p of snaps) {
    const key = `${p.type}:${p.occupancyGroup ?? p.id}`
    const list = byGroup.get(key)
    if (list) list.push(p)
    else byGroup.set(key, [p])
  }
  const out: Array<{ axis: 0 | 1 | 2; u: number; v: number }> = []
  for (const members of byGroup.values()) {
    const axis = dominantAxis(members[0])
    const plane = [0, 1, 2].filter((i) => i !== axis) as [number, number]
    let su = 0
    let sv = 0
    for (const m of members) {
      su += m.position[plane[0]]
      sv += m.position[plane[1]]
    }
    out.push({ axis, u: su / members.length, v: sv / members.length })
  }
  return out
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

type PartAudit = {
  id: string
  name: string
  category: string
  source: string
  snapGroups: number
  blindGroups: number
  detected: number
  pinSizedDetected: number
  matched: number
  // Detected pin-sized through-holes with no matching snap group.
  missing: DetectedHole[]
  // Two-sided snap hole groups with no detected through-hole nearby.
  extra: Array<{ key: string; axis: number; u: number; v: number }>
  maxErr: number
  error?: string
}

function auditPart(def: PartDefinition): { audit: PartAudit; holes: DetectedHole[] } {
  const resolution = getSnapPointResolution(def)
  const groups = snapHoleGroups(resolution.snapPoints)
  const base: PartAudit = {
    id: def.id,
    name: def.name,
    category: def.category,
    source: resolution.source,
    snapGroups: groups.length,
    blindGroups: groups.filter((g) => g.blind).length,
    detected: 0,
    pinSizedDetected: 0,
    matched: 0,
    missing: [],
    extra: [],
    maxErr: 0,
  }
  if (!def.modelPath || !def.hasConvertedModel) {
    return { audit: { ...base, error: 'no-glb' }, holes: [] }
  }
  const file = path.join(ROOT, 'public', decodeURI(def.modelPath))
  if (!fs.existsSync(file)) {
    return { audit: { ...base, error: 'glb-missing-on-disk' }, holes: [] }
  }
  let mesh: Mesh
  try {
    mesh = loadMesh(file)
  } catch (e) {
    return { audit: { ...base, error: `glb-parse: ${(e as Error).message}` }, holes: [] }
  }

  const holes: DetectedHole[] = []
  for (const axis of [0, 1, 2] as const) {
    holes.push(...detectHolesAlongAxis(mesh, axis))
  }
  base.detected = holes.length
  const pinHoles = holes.filter((h) => h.pinSized)
  base.pinSizedDetected = pinHoles.length

  // Greedy nearest matching per axis between detected pin holes and two-sided
  // snap groups (blind sockets are unverifiable by through-ray parity).
  const usedGroups = new Set<string>()
  for (const h of pinHoles) {
    let best: SnapHoleGroup | null = null
    let bestDist = Infinity
    for (const g of groups) {
      if (g.axis !== h.axis || usedGroups.has(g.key)) continue
      const d = Math.hypot(g.u - h.u, g.v - h.v)
      if (d < bestDist) {
        bestDist = d
        best = g
      }
    }
    if (best && bestDist <= MATCH_TOL) {
      usedGroups.add(best.key)
      base.matched++
      if (bestDist > base.maxErr) base.maxErr = round3(bestDist)
    } else {
      base.missing.push(h)
    }
  }
  for (const g of groups) {
    if (g.blind || usedGroups.has(g.key)) continue
    base.extra.push({ key: g.key, axis: g.axis, u: round3(g.u), v: round3(g.v) })
  }
  return { audit: base, holes }
}

// ---------------------------------------------------------------------------
// Measured-hole emission (src/data/measuredPartHoles.ts)
// ---------------------------------------------------------------------------

function emitTable(
  name: string,
  entries: Array<{ def: PartDefinition; holes: DetectedHole[] }>,
): string[] {
  const lines: string[] = []
  lines.push(`export const ${name}: Record<string, MeasuredHole[]> = {`)
  for (const { def, holes } of entries) {
    const sorted = [...holes].sort(
      (a, b) => a.axis - b.axis || a.v - b.v || a.u - b.u,
    )
    lines.push(`  '${def.id}': [`)
    for (const h of sorted) {
      lines.push(
        `    { axis: ${h.axis}, u: ${h.u}, v: ${h.v}, faceMin: ${h.faceMin}, faceMax: ${h.faceMax} },`,
      )
    }
    lines.push('  ],')
  }
  lines.push('}')
  return lines
}

function emitMeasuredHoles(
  fullSets: Array<{ def: PartDefinition; holes: DetectedHole[] }>,
  supplementalSets: Array<{ def: PartDefinition; holes: DetectedHole[] }>,
): string {
  const lines: string[] = []
  lines.push('// AUTO-GENERATED by `npx tsx scripts/audit-part-holes.ts --emit`.')
  lines.push('// Do not hand-edit — rerun the script to refresh.')
  lines.push('//')
  lines.push('// Pin-sized THROUGH-holes measured from the converted GLBs by headless')
  lines.push('// raycasting (parity + flood fill; see HANDOFF.md "Measuring Parts").')
  lines.push('// Coordinates are in the bbox-recentered local frame ScenePart renders in.')
  lines.push('// Each entry becomes a two-sided `hole` snap pair (front/back faces sharing')
  lines.push('// one occupancy group) via makeMeasuredHoleSnaps() in snapOverrides.ts.')
  lines.push('//')
  lines.push('// Known technique limits: blind sockets and through-holes occluded by a')
  lines.push('// second wall along their axis (L-bracket legs) are NOT detected, and')
  lines.push("// sub-pin-size bores (axle cross-bores ~0.13) are deliberately excluded so")
  lines.push('// they never accept pins.')
  lines.push('')
  lines.push('export type MeasuredHole = {')
  lines.push('  // Local axis index the hole passes through (0=X, 1=Y, 2=Z).')
  lines.push('  axis: 0 | 1 | 2')
  lines.push('  // In-plane hole center on the two remaining axes, ascending axis order.')
  lines.push('  u: number')
  lines.push('  v: number')
  lines.push('  // Outer material faces along the hole axis (ring-sampled beside the hole).')
  lines.push('  faceMin: number')
  lines.push('  faceMax: number')
  lines.push('}')
  lines.push('')
  lines.push('// Full measured hole sets for parts with NO curated/fuzzy snap coverage.')
  lines.push(...emitTable('MEASURED_PART_HOLES', fullSets))
  lines.push('')
  lines.push('// Extra measured holes appended to parts whose primary metadata stays')
  lines.push('// (gear/wheel face holes, standoff cross-holes, extra electronics faces, …).')
  lines.push('// Guarded: never emitted within 0.12 of an existing same-axis snap feature.')
  lines.push(...emitTable('MEASURED_SUPPLEMENTAL_HOLES', supplementalSets))
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const emit = args.includes('--emit')
const filter = args.find((a) => !a.startsWith('--'))

const targets = PARTS.filter(
  (def) =>
    !filter ||
    def.id.toLowerCase().includes(filter.toLowerCase()) ||
    def.name.toLowerCase().includes(filter.toLowerCase()),
)

// A supplemental hole must sit clear of every existing same-axis snap feature
// so a measured hole never lands on a gear/wheel center bore, blind socket,
// or peg that the primary metadata already models.
const SUPPLEMENT_CLEARANCE = 0.12

console.log(`Auditing ${targets.length} part(s)...`)
const audits: PartAudit[] = []
const fullSets: Array<{ def: PartDefinition; holes: DetectedHole[] }> = []
const supplementalSets: Array<{ def: PartDefinition; holes: DetectedHole[] }> = []
const verboseHoles: Array<{ def: PartDefinition; holes: DetectedHole[] }> = []
let done = 0
for (const def of targets) {
  const { audit, holes } = auditPart(def)
  audits.push(audit)
  if (filter) verboseHoles.push({ def, holes })

  // Emission classifies against the resolution WITHOUT the measured layers,
  // so a regeneration never sees the previous generation's own output.
  const pinHoles = holes.filter((h) => h.pinSized)
  if (pinHoles.length > 0) {
    const base = getSnapPointResolution(def, { includeMeasured: false })
    if (base.source !== 'curated') {
      // No trusted coverage — the measured set becomes the part's hole set.
      fullSets.push({ def, holes: pinHoles })
    } else {
      // Trusted primary metadata — append only holes it does not model.
      const centers = allSnapGroupCenters(base.snapPoints)
      const unmatched = pinHoles.filter(
        (h) =>
          !centers.some(
            (c) =>
              c.axis === h.axis &&
              Math.hypot(c.u - h.u, c.v - h.v) <= SUPPLEMENT_CLEARANCE,
          ),
      )
      if (unmatched.length > 0) supplementalSets.push({ def, holes: unmatched })
    }
  }
  done++
  if (done % 50 === 0) console.log(`  ...${done}/${targets.length}`)
}

if (filter) {
  for (const a of audits) {
    console.log(JSON.stringify(a, null, 2))
  }
  for (const { def, holes } of verboseHoles) {
    console.log(`\nDetected holes for ${def.name} (${def.id}):`)
    for (const h of holes) {
      console.log(
        `  axis=${'XYZ'[h.axis]} u=${h.u} v=${h.v} extent=${h.extentU}x${h.extentV} cells=${h.cells} faces=[${h.faceMin}, ${h.faceMax}] ${h.pinSized ? 'PIN-SIZED' : 'small/other'}`,
      )
    }
  }
}

const withGlb = audits.filter((a) => !a.error)
const perfect = withGlb.filter(
  (a) => a.missing.length === 0 && a.extra.length === 0,
)
const withMissing = withGlb.filter((a) => a.missing.length > 0)
const withExtra = withGlb.filter((a) => a.extra.length > 0)

console.log('')
console.log('=== Hole audit summary ===')
console.log(`parts audited:            ${audits.length}`)
console.log(`with GLB mesh:            ${withGlb.length}`)
console.log(`no mesh / parse error:    ${audits.length - withGlb.length}`)
console.log(`fully consistent:         ${perfect.length}`)
console.log(`missing holes (detected through-hole, no snap): ${withMissing.length}`)
console.log(`extra snaps (two-sided snap, no through-hole):  ${withExtra.length}`)
console.log('')

const bySource = new Map<string, { n: number; missing: number }>()
for (const a of withGlb) {
  const s = bySource.get(a.source) ?? { n: 0, missing: 0 }
  s.n++
  s.missing += a.missing.length
  bySource.set(a.source, s)
}
console.log('By snap source:')
for (const [source, s] of bySource) {
  console.log(`  ${source.padEnd(18)} parts=${s.n}  missing-holes=${s.missing}`)
}
console.log('')

const worstMissing = [...withMissing]
  .sort((a, b) => b.missing.length - a.missing.length)
  .slice(0, 25)
console.log('Top parts by missing holes:')
for (const a of worstMissing) {
  console.log(
    `  ${a.missing.length.toString().padStart(3)} missing  [${a.source}] ${a.name} (${a.id})`,
  )
}
console.log('')
const worstExtra = [...withExtra]
  .sort((a, b) => b.extra.length - a.extra.length)
  .slice(0, 25)
console.log('Top parts by extra two-sided snaps (no matching through-hole):')
for (const a of worstExtra) {
  console.log(
    `  ${a.extra.length.toString().padStart(3)} extra    [${a.source}] ${a.name} (${a.id})`,
  )
}

const reportDir = path.join(ROOT, 'scripts')
const reportPath = path.join(reportDir, 'hole-audit-report.json')
fs.writeFileSync(reportPath, JSON.stringify(audits, null, 1))
console.log(`\nFull report: ${reportPath}`)

if (emit) {
  fullSets.sort((a, b) => a.def.id.localeCompare(b.def.id))
  supplementalSets.sort((a, b) => a.def.id.localeCompare(b.def.id))
  const outPath = path.join(ROOT, 'src', 'data', 'measuredPartHoles.ts')
  fs.writeFileSync(outPath, emitMeasuredHoles(fullSets, supplementalSets))
  const fullCount = fullSets.reduce((n, m) => n + m.holes.length, 0)
  const suppCount = supplementalSets.reduce((n, m) => n + m.holes.length, 0)
  console.log(
    `Emitted ${fullCount} full-set holes across ${fullSets.length} parts and ` +
      `${suppCount} supplemental holes across ${supplementalSets.length} parts -> ${outPath}`,
  )
}
