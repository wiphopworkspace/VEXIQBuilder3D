/*
 * High-resolution pin/receiver GLB geometry profiler.
 *
 * WHY: seating must be driven by the REAL mechanical stopping surface, not by
 * an endpoint origin that happens to sit near it. This tool measures, straight
 * from the converted GLB vertices:
 *
 *   - the insertion (shaft) axis
 *   - the shaft radius and the flange/cap radius
 *   - the exact axial planes where the flange/cap begins and ends — i.e. the
 *     SHOULDER FACES that physically stop against a receiving part
 *   - for receivers: the part thickness along each candidate hole axis
 *
 * All coordinates are expressed relative to the bounding-box CENTER, because
 * `ScenePart.tsx` re-centers every converted GLB on its bbox centre before
 * placing it — so this frame is exactly the frame snap metadata is authored in.
 *
 * Run:  node scripts/measure-pin-geometry.mjs [filter]
 *       node scripts/measure-pin-geometry.mjs --json    (machine-readable)
 */
import fs from 'fs'
import path from 'path'

const DIRS = [
  'public/models/VEX-IQ-All-Parts-GLB',
  'public/models/VEX-IQ-All-Control-GLB',
]

// ---------------------------------------------------------------- GLB parsing

function parseGLB(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb')
  let off = 12
  let json = null
  let bin = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004e4942) bin = data
    off += 8 + len
  }
  return { json, bin }
}

function matMul(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}

function trsMatrix(n) {
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

function applyMat(m, p) {
  const [x, y, z] = p
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

function readPositions(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex]
  const bv = json.bufferViews[acc.bufferView]
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = bv.byteStride ?? 3 * COMPONENT_BYTES[acc.componentType]
  const out = []
  for (let i = 0; i < acc.count; i++) {
    const b = start + i * stride
    out.push([bin.readFloatLE(b), bin.readFloatLE(b + 4), bin.readFloatLE(b + 8)])
  }
  return out
}

export function collectVertices(json, bin) {
  const verts = []
  const visit = (nodeIndex, parent) => {
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

// ------------------------------------------------------------- measurement

/**
 * Cluster the axial coordinates of the vertices that belong to a radial band
 * into flat planes. A moulded flange/cap face is a disc: many vertices share
 * one axial coordinate at the outer radius, so a plane shows up as a tight
 * cluster with a high vertex count.
 */
function clusterPlanes(values, tol = 0.004) {
  const sorted = [...values].sort((a, b) => a - b)
  const clusters = []
  for (const v of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && v - last.max <= tol) {
      last.max = v
      last.sum += v
      last.n++
    } else {
      clusters.push({ min: v, max: v, sum: v, n: 1 })
    }
  }
  return clusters.map((c) => ({
    at: c.sum / c.n,
    min: c.min,
    max: c.max,
    n: c.n,
  }))
}

/**
 * Profile one part along a chosen axis.
 * Returns the radial feature structure: the outer (flange/cap) radius, the
 * shaft radius, and every candidate stopping plane where the outer radius
 * terminates.
 */
export function profileAxis(verts, axis, center) {
  const a1 = (axis + 1) % 3
  const a2 = (axis + 2) % 3
  const rows = verts.map((v) => ({
    s: v[axis] - center[axis],
    r: Math.hypot(v[a1] - center[a1], v[a2] - center[a2]),
  }))
  const rMax = Math.max(...rows.map((x) => x.r))
  // Outer band: vertices within 4% of the maximum radius — the flange/cap rim.
  const outerBand = rows.filter((x) => x.r >= rMax * 0.96)
  const outerPlanes = clusterPlanes(outerBand.map((x) => x.s))
  // Shaft band: everything at least 25% smaller than the rim, ignoring the
  // near-axis interior. Its radius is what actually enters a hole.
  const shaftRows = rows.filter((x) => x.r <= rMax * 0.75 && x.r > rMax * 0.15)
  const rShaft = shaftRows.length ? Math.max(...shaftRows.map((x) => x.r)) : 0
  const sMin = Math.min(...rows.map((x) => x.s))
  const sMax = Math.max(...rows.map((x) => x.s))
  return { rMax, rShaft, outerPlanes, sMin, sMax, count: rows.length }
}

export function measurePart(file) {
  const { json, bin } = parseGLB(file)
  const verts = collectVertices(json, bin)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of verts)
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i]
      if (v[i] > max[i]) max[i] = v[i]
    }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const center = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ]
  const shaft = size.indexOf(Math.max(...size))
  return {
    file: path.basename(file),
    size,
    shaftAxis: shaft,
    shaftAxisName: ['X', 'Y', 'Z'][shaft],
    ...profileAxis(verts, shaft, center),
    verts: verts.length,
  }
}

// ------------------------------------------------------------------- driver

function listFiles(filter) {
  const out = []
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.glb')) continue
      if (filter && !f.toLowerCase().includes(filter.toLowerCase())) continue
      out.push(path.join(dir, f))
    }
  }
  return out.sort()
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const filter = args.find((a) => !a.startsWith('--'))
  const files = listFiles(filter)
  const results = []
  for (const f of files) {
    try {
      results.push(measurePart(f))
    } catch (e) {
      results.push({ file: path.basename(f), error: e.message })
    }
  }
  if (asJson) {
    process.stdout.write(JSON.stringify(results, null, 2))
    return
  }
  for (const r of results) {
    if (r.error) {
      console.log(`(error) ${r.file}: ${r.error}`)
      continue
    }
    console.log(`\n=== ${r.file} ===`)
    console.log(
      `  size=[${r.size.map((n) => n.toFixed(4)).join(', ')}]  axis=${r.shaftAxisName}  ` +
        `extent=[${r.sMin.toFixed(4)}, ${r.sMax.toFixed(4)}] about centre  verts=${r.verts}`,
    )
    console.log(`  rimRadius=${r.rMax.toFixed(4)}  shaftRadius=${r.rShaft.toFixed(4)}`)
    console.log('  rim planes (candidate stopping surfaces):')
    for (const p of r.outerPlanes) {
      console.log(
        `    s=${p.at >= 0 ? '+' : ''}${p.at.toFixed(4)}  ` +
          `span=[${p.min.toFixed(4)}, ${p.max.toFixed(4)}]  verts=${p.n}`,
      )
    }
  }
}

// Run whenever this file is the entry point. (A `file://` string compare is
// unreliable on Windows, where argv[1] is a drive-letter path.)
if (path.basename(process.argv[1] ?? '') === 'measure-pin-geometry.mjs') main()
