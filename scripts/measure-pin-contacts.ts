/**
 * Measure the REAL mechanical stopping surface of every pin-side endpoint in
 * the catalog, straight from the converted GLB meshes.
 *
 * The physical definition used here — and the reason this is a measurement
 * rather than a hand-tuned constant:
 *
 *   A pin-style connector enters a receiver until its cross-section can no
 *   longer pass through the hole. So, walking OUTWARD from the shaft tip along
 *   the insertion axis, the STOPPING SURFACE is the first plane at which the
 *   connector's radius about that axis exceeds the receiver's hole radius.
 *
 * That one rule finds every stopping-surface geometry the catalog contains
 * without assuming which kind it is: a connector-pin collar, a capped-pin cap
 * face, a standoff barrel end, a corner-connector body wall, a bushing flange.
 * It is also the rule that decides insertability, so it cannot disagree with
 * whether the part actually fits.
 *
 * Coordinates are in the bbox-recentred local frame `ScenePart.tsx` renders in,
 * which is the frame snap metadata is authored in.
 *
 * Run:
 *   npm run measure:pins              audit table (metadata vs measured)
 *   npm run measure:pins -- --emit    regenerate src/data/measuredPinContacts.ts
 *   npm run measure:pins -- 228-2500-060      filter to one part
 */
import fs from 'node:fs'
import path from 'node:path'
import { PARTS } from '../src/data/parts'
import { getSnapPoints } from '../src/data/snapOverrides'
import { contactPlaneOriginOf, isPinSideType } from '../src/data/contactFrames'
import { PIN_FIT } from '../src/data/snapCalibration'
import type { PartDefinition, SnapPointDefinition, Vec3 } from '../src/types/assembly'

// ---------------------------------------------------------------- GLB reader

type Vec = [number, number, number]

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

type Mat = number[]

function matMul(a: Mat, b: Mat): Mat {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}

function trsMatrix(n: any): Mat {
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

function applyMat(m: Mat, p: Vec): Vec {
  const [x, y, z] = p
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
}

function readPositions(json: any, bin: Buffer, accessorIndex: number): Vec[] {
  const acc = json.accessors[accessorIndex]
  const bv = json.bufferViews[acc.bufferView]
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = bv.byteStride ?? 3 * COMPONENT_BYTES[acc.componentType]
  const out: Vec[] = []
  for (let i = 0; i < acc.count; i++) {
    const b = start + i * stride
    out.push([bin.readFloatLE(b), bin.readFloatLE(b + 4), bin.readFloatLE(b + 8)])
  }
  return out
}

function collectVertices(json: any, bin: Buffer): Vec[] {
  const verts: Vec[] = []
  const visit = (nodeIndex: number, parent: Mat) => {
    const node = json.nodes[nodeIndex]
    const m = matMul(parent, trsMatrix(node))
    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.attributes.POSITION == null) continue
        for (const p of readPositions(json, bin, prim.attributes.POSITION)) {
          verts.push(applyMat(m, p))
        }
      }
    }
    for (const c of node.children ?? []) visit(c, m)
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const scene = json.scenes[json.scene ?? 0]
  for (const n of scene.nodes) visit(n, identity)
  return verts
}

/** Vertices re-centred exactly the way `ScenePart.tsx` re-centres the model. */
const vertexCache = new Map<string, Vec[] | null>()

function recentredVertices(def: PartDefinition): Vec[] | null {
  const key = def.id
  if (vertexCache.has(key)) return vertexCache.get(key)!
  const rel = def.modelPath?.replace(/^\//, '')
  const file = rel ? path.join('public', rel) : null
  if (!file || !fs.existsSync(decodeURI(file))) {
    vertexCache.set(key, null)
    return null
  }
  try {
    const { json, bin } = parseGLB(decodeURI(file))
    const verts = collectVertices(json, bin)
    const min: Vec = [Infinity, Infinity, Infinity]
    const max: Vec = [-Infinity, -Infinity, -Infinity]
    for (const v of verts)
      for (let i = 0; i < 3; i++) {
        if (v[i] < min[i]) min[i] = v[i]
        if (v[i] > max[i]) max[i] = v[i]
      }
    const c: Vec = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ]
    const out = verts.map((v): Vec => [v[0] - c[0], v[1] - c[1], v[2] - c[2]])
    vertexCache.set(key, out)
    return out
  } catch {
    vertexCache.set(key, null)
    return null
  }
}

// ------------------------------------------------------------- measurement

export type PinContactMeasurement = {
  partId: string
  partNumber: string | null
  snapId: string
  /** Axial distance from the endpoint's radial centre to the stopping plane. */
  shoulderOffset: number
  /** Axial distance from the radial centre to the shaft tip (insertable span). */
  tipOffset: number
  /** Largest radius of the insertable span — must clear the hole. */
  shaftRadius: number
  /** Radius at the stopping plane — the reason the part stops there. */
  shoulderRadius: number
  /** How many whole receiver layers the shaft can pass through. */
  usableLayers: number
  /** Vertices supporting the stopping plane (confidence). */
  support: number
}

function dot(a: Vec, b: Vec) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function normalize(v: Vec): Vec {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * Measure one pin-side endpoint.
 *
 * `axis` points the way the connector travels INTO the receiver, and `centre`
 * is the endpoint's radial centre. We build the axial coordinate
 * `t = (vertex - centre) · axis`, so the insertable shaft occupies the LARGEST
 * t values and the connector body the smallest. The stopping plane is the
 * greatest t at which the radius about the axis still exceeds the hole radius.
 */
export function measureEndpoint(
  verts: Vec[],
  centre: Vec,
  axisIn: Vec,
  holeRadius = PIN_FIT.holeRadius,
): PinContactMeasurement | null {
  const axis = normalize(axisIn)
  const rows: Array<{ t: number; r: number }> = []
  for (const v of verts) {
    const d: Vec = [v[0] - centre[0], v[1] - centre[1], v[2] - centre[2]]
    const t = dot(d, axis)
    const radial: Vec = [
      d[0] - axis[0] * t,
      d[1] - axis[1] * t,
      d[2] - axis[2] * t,
    ]
    rows.push({ t, r: Math.hypot(radial[0], radial[1], radial[2]) })
  }
  if (!rows.length) return null

  // Only material near this endpoint's axis matters. A generous radial window
  // (three hole radii) keeps the connector body while dropping far-away
  // features of multi-pin bodies.
  const near = rows.filter((x) => x.r <= holeRadius * 3)
  if (!near.length) return null

  const tipOffset = Math.max(...near.map((x) => x.t))
  // Material that cannot pass through the hole, with a small tolerance so
  // mesh noise on a snug shaft is not mistaken for a shoulder.
  const blocking = near.filter((x) => x.r > holeRadius + PIN_FIT.fitTolerance)
  if (!blocking.length) return null
  const shoulderOffset = Math.max(...blocking.map((x) => x.t))
  const support = blocking.filter(
    (x) => Math.abs(x.t - shoulderOffset) < 0.004,
  ).length
  const shoulderRadius = Math.max(
    ...blocking
      .filter((x) => Math.abs(x.t - shoulderOffset) < 0.004)
      .map((x) => x.r),
  )
  const shaftRows = near.filter((x) => x.t > shoulderOffset + 0.004)
  const shaftRadius = shaftRows.length
    ? Math.max(...shaftRows.map((x) => x.r))
    : 0
  const span = tipOffset - shoulderOffset
  return {
    partId: '',
    partNumber: null,
    snapId: '',
    shoulderOffset,
    tipOffset,
    shaftRadius,
    shoulderRadius,
    // A layer only counts when the shaft reaches at least 95% through it.
    usableLayers: Math.max(1, Math.floor(span / PIN_FIT.layerThickness + 0.05)),
    // An endpoint only inserts if real material of hole-passing width extends
    // past the stopping plane. Endpoints that fail this carry a pin snap the
    // mesh does not support and must be review-gated, never silently seated.
    insertable: shaftRadius > 0 && span >= PIN_FIT.layerThickness * 0.4,
    support,
  }
}

// ------------------------------------------------------------------ driver

type Row = {
  def: PartDefinition
  snap: SnapPointDefinition
  metadataOffset: number
  measured: PinContactMeasurement | null
}

export function auditPinContacts(filter?: string): Row[] {
  const rows: Row[] = []
  for (const def of PARTS) {
    if (filter) {
      const hay = `${def.id} ${def.name} ${def.partNumber ?? ''}`.toLowerCase()
      if (!hay.includes(filter.toLowerCase())) continue
    }
    const snaps = getSnapPoints(def).filter(
      (s) => isPinSideType(s.type) && s.role !== 'receive',
    )
    if (!snaps.length) continue
    const verts = recentredVertices(def)
    for (const snap of snaps) {
      const centre = (snap.mateFrame?.position ?? snap.position) as Vec
      const axis = (snap.mateFrame?.axis ?? snap.axis ?? snap.normal ?? [0, 0, 1]) as Vec
      const { origin } = contactPlaneOriginOf(snap)
      const a = normalize(axis)
      const metadataOffset =
        (origin[0] - centre[0]) * a[0] +
        (origin[1] - centre[1]) * a[1] +
        (origin[2] - centre[2]) * a[2]
      const measured = verts ? measureEndpoint(verts, centre, axis) : null
      if (measured) {
        measured.partId = def.id
        measured.partNumber = def.partNumber ?? null
        measured.snapId = snap.id
      }
      rows.push({ def, snap, metadataOffset, measured })
    }
  }
  return rows
}

function fmt(n: number | null | undefined, w = 8) {
  if (n == null || Number.isNaN(n)) return '—'.padStart(w)
  return (n >= 0 ? '+' : '') + n.toFixed(4).padStart(w - 1)
}

function main() {
  const args = process.argv.slice(2)
  const emit = args.includes('--emit')
  const filter = args.find((a) => !a.startsWith('--'))
  const rows = auditPinContacts(filter)

  if (emit) {
    const byPart = new Map<string, PinContactMeasurement[]>()
    for (const r of rows) {
      if (!r.measured) continue
      const key = r.def.partNumber ?? r.def.id
      if (!byPart.has(key)) byPart.set(key, [])
      byPart.get(key)!.push(r.measured)
    }
    const lines: string[] = []
    lines.push('// AUTO-GENERATED by `npm run measure:pins -- --emit`.')
    lines.push('// Do not hand-edit — rerun the script to refresh.')
    lines.push('//')
    lines.push('// The REAL mechanical stopping surface of every pin-side endpoint, measured')
    lines.push('// from the converted GLB meshes. `shoulderOffset` is the axial distance from')
    lines.push("// the endpoint's radial centre (its marker/mate frame) to the first plane")
    lines.push('// whose cross-section can no longer pass through a VEX IQ pin hole — i.e.')
    lines.push('// the surface that physically stops the connector against the receiving')
    lines.push('// part. Coordinates are in the bbox-recentred frame ScenePart renders in.')
    lines.push('')
    lines.push('export type MeasuredPinContact = {')
    lines.push('  snapId: string')
    lines.push('  /** Axial distance from the radial centre to the stopping plane. */')
    lines.push('  shoulderOffset: number')
    lines.push('  /** Axial distance from the radial centre to the shaft tip. */')
    lines.push('  tipOffset: number')
    lines.push('  /** Largest radius of the insertable span. */')
    lines.push('  shaftRadius: number')
    lines.push('  /** Radius at the stopping plane — why the connector stops there. */')
    lines.push('  shoulderRadius: number')
    lines.push('  /** Whole receiver layers the shaft can pass through. */')
    lines.push('  usableLayers: number')
    lines.push('  /**')
    lines.push('   * False when no hole-passing material extends past the stopping plane —')
    lines.push('   * the endpoint declares a pin the mesh does not have. Review-gated')
    lines.push('   * rather than seated on a guessed plane.')
    lines.push('   */')
    lines.push('  insertable: boolean')
    lines.push('}')
    lines.push('')
    lines.push('export const MEASURED_PIN_CONTACTS: Record<string, MeasuredPinContact[]> = {')
    for (const key of [...byPart.keys()].sort()) {
      lines.push(`  ${JSON.stringify(key)}: [`)
      for (const m of byPart.get(key)!) {
        lines.push(
          `    { snapId: ${JSON.stringify(m.snapId)}, shoulderOffset: ${m.shoulderOffset.toFixed(
            4,
          )}, tipOffset: ${m.tipOffset.toFixed(4)}, shaftRadius: ${m.shaftRadius.toFixed(
            4,
          )}, shoulderRadius: ${m.shoulderRadius.toFixed(4)}, usableLayers: ${m.usableLayers}, insertable: ${m.insertable} },`,
        )
      }
      lines.push('  ],')
    }
    lines.push('}')
    lines.push('')
    fs.writeFileSync('src/data/measuredPinContacts.ts', lines.join('\n'))
    console.log(
      `emitted src/data/measuredPinContacts.ts — ${byPart.size} parts, ` +
        `${rows.filter((r) => r.measured).length} endpoints`,
    )
    return
  }

  console.log('\n=== pin stopping-surface audit (metadata vs measured mesh) ===\n')
  console.log(
    'part'.padEnd(16) +
      'endpoint'.padEnd(16) +
      'metaSeat'.padStart(9) +
      'measured'.padStart(10) +
      'delta'.padStart(10) +
      'shaftR'.padStart(9) +
      'shldR'.padStart(9) +
      'layers'.padStart(7),
  )
  let mismatched = 0
  let unmeasured = 0
  for (const r of rows) {
    const key = r.def.partNumber ?? r.def.id
    if (!r.measured) {
      unmeasured++
      console.log(
        key.padEnd(16) + r.snap.id.padEnd(16) + fmt(r.metadataOffset, 9) + '  (no mesh)',
      )
      continue
    }
    const delta = r.measured.shoulderOffset - r.metadataOffset
    if (Math.abs(delta) > 0.002) mismatched++
    console.log(
      key.padEnd(16) +
        r.snap.id.padEnd(16) +
        fmt(r.metadataOffset, 9) +
        fmt(r.measured.shoulderOffset, 10) +
        fmt(delta, 10) +
        fmt(r.measured.shaftRadius, 9) +
        fmt(r.measured.shoulderRadius, 9) +
        String(r.measured.usableLayers).padStart(7) +
        (Math.abs(delta) > 0.002 ? '  <-- MISMATCH' : ''),
    )
  }
  console.log(
    `\n${rows.length} pin-side endpoints; ${mismatched} disagree with the mesh by > 0.002; ` +
      `${unmeasured} unmeasurable (no GLB).`,
  )
}

if (path.basename(process.argv[1] ?? '') === 'measure-pin-contacts.ts') main()
