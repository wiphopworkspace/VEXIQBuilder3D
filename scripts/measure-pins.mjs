/*
 * Headless pin GLB profiler (debug-mantra reproduction step).
 * Run: node scripts/measure-pins.mjs
 *
 * Parses each pin GLB (no WebGL), finds the shaft axis (longest bbox extent),
 * bins vertices along it, and reports the cross-section radius per bin so we can
 * locate the flange/cap and seat planes. All coords are relative to the bbox
 * center, because ScenePart's GLBModel re-centers the clone on its bbox center.
 */
import fs from 'fs'
import path from 'path'

const DIR = 'public/models/VEX-IQ-All-Parts-GLB'
const TARGETS = [
  '1x1 Connector Pin (228-2500-060).glb',
  '1x2 Connector Pin (228-2500-061).glb',
  '2x2 Connector Pin (228-2500-062).glb',
  '0x2 Connector Pin (228-2500-086).glb',
  '0x3 Connector Pin (228-2500-087).glb',
  '0x1 Sheet Pin (228-2500-099).glb',
]

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

// minimal mat4 (column-major like glTF)
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
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
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

function readPositions(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex]
  const bv = json.bufferViews[acc.bufferView]
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = bv.byteStride ?? 12
  const out = []
  for (let i = 0; i < acc.count; i++) {
    const b = start + i * stride
    out.push([bin.readFloatLE(b), bin.readFloatLE(b + 4), bin.readFloatLE(b + 8)])
  }
  return out
}

function collectVertices(json, bin) {
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

function profile(file) {
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
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  // shaft = longest axis
  const shaft = size.indexOf(Math.max(...size))
  const a1 = (shaft + 1) % 3
  const a2 = (shaft + 2) % 3
  const half = size[shaft] / 2
  const NB = 24
  const bins = Array.from({ length: NB }, () => ({ rMax: 0, n: 0 }))
  for (const v of verts) {
    const s = v[shaft] - center[shaft] // relative to center, range [-half, half]
    let bi = Math.floor(((s + half) / size[shaft]) * NB)
    if (bi < 0) bi = 0
    if (bi >= NB) bi = NB - 1
    const r = Math.hypot(v[a1] - center[a1], v[a2] - center[a2])
    if (r > bins[bi].rMax) bins[bi].rMax = r
    bins[bi].n++
  }
  const axisName = ['X', 'Y', 'Z'][shaft]
  console.log(`\n=== ${path.basename(file)} ===`)
  console.log(`  size=[${size.map((n) => n.toFixed(3)).join(', ')}]  shaft=${axisName} len=${size[shaft].toFixed(3)} (±${half.toFixed(3)} about center)`)
  // radius profile, low-res sparkline by bin
  const rmaxAll = Math.max(...bins.map((b) => b.rMax))
  const rows = bins.map((b, i) => {
    const sPos = -half + (i + 0.5) * (size[shaft] / NB)
    const bar = '#'.repeat(Math.round((b.rMax / rmaxAll) * 24))
    return `   s=${sPos >= 0 ? '+' : ''}${sPos.toFixed(3)}  r=${b.rMax.toFixed(3)} ${bar}`
  })
  console.log(rows.join('\n'))
  // flange = bin of max radius; report its signed position about center
  const flangeBin = bins.reduce((bestI, b, i, arr) => (b.rMax > arr[bestI].rMax ? i : bestI), 0)
  const flangePos = -half + (flangeBin + 0.5) * (size[shaft] / NB)
  // symmetry: compare mass each side of center
  const nLeft = verts.filter((v) => v[shaft] - center[shaft] < 0).length
  const nRight = verts.length - nLeft
  console.log(`  flange(maxR) at s=${flangePos.toFixed(3)} (r=${rmaxAll.toFixed(3)})  massL/R=${nLeft}/${nRight} -> ${Math.abs(nLeft - nRight) / verts.length > 0.15 ? 'ASYMMETRIC (capped?)' : 'symmetric'}`)
}

for (const t of TARGETS) {
  const f = path.join(DIR, t)
  if (!fs.existsSync(f)) { console.log(`(missing) ${t}`); continue }
  try { profile(f) } catch (e) { console.log(`(error) ${t}: ${e.message}`) }
}
