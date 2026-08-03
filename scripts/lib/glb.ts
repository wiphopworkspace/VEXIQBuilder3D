/**
 * Minimal headless GLB vertex reader shared by the measurement scripts.
 *
 * The measurements this feeds (`measure-pin-contacts.ts`,
 * `measure-hole-seats.ts`) only ever need POSITION data in the frame
 * `ScenePart.tsx` renders in, so this deliberately reads nothing else: no
 * three.js, no loaders, no materials, no indices.
 *
 * `recentredVertices` is the important part — it re-centres the model on its
 * bounding-box centre exactly the way `ScenePart` does, which is the frame ALL
 * snap metadata is authored in. A measurement taken in the raw GLB frame would
 * be silently offset from every snap point in the catalog.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { PartDefinition } from '../../src/types/assembly'

export type Vec = [number, number, number]
type Mat = number[]

export function parseGLB(file: string): { json: any; bin: Buffer } {
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

export function collectVertices(json: any, bin: Buffer): Vec[] {
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

const vertexCache = new Map<string, Vec[] | null>()

/** Vertices re-centred exactly the way `ScenePart.tsx` re-centres the model. */
export function recentredVertices(def: PartDefinition): Vec[] | null {
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

export function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function normalize(v: Vec): Vec {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
