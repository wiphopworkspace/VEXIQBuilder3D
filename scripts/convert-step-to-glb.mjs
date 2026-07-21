/**
 * convert-step-to-glb.mjs
 *
 * Batch-converts local VEX IQ STEP files into GLB models using OpenCASCADE
 * (occt-import-js). This is a BUILD-TIME tool only — occt is never shipped in
 * the app bundle. Generated GLBs are written into the GLB folder that pairs
 * with each STEP source, using the same base name so `npm run generate:parts`
 * matches them automatically.
 *
 * Geometry is baked to VEX world scale (1 hole pitch = 0.5 units, real
 * 12.7 mm), centered on X/Z and rested on the grid (min Y -> 0), so a converted
 * GLB drops into the scene at the same place as its placeholder.
 *
 * Usage:
 *   node scripts/convert-step-to-glb.mjs            # both collections
 *   node scripts/convert-step-to-glb.mjs control    # control parts only
 *   node scripts/convert-step-to-glb.mjs all        # full parts catalog only
 *   node scripts/convert-step-to-glb.mjs --force    # re-convert existing GLBs
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import occtimportjs from 'occt-import-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public', 'models')

const MM_TO_WORLD = 0.5 / 12.7
const STEP_EXT = new Set(['.step', '.stp'])

/**
 * Per-part orientation corrections, applied to the raw STEP geometry BEFORE
 * centering and grounding so the converted GLB rests in its natural pose at
 * identity rotation — the convention every other part in the library follows.
 *
 * Keyed by STEP base name. Each entry maps a source vertex to the corrected
 * frame and must be a pure rotation (so normals stay valid under the same map).
 * Add an entry only with measured evidence, and record WHY.
 */
const ORIENTATION_CORRECTIONS = {
  // VEX IQ Robot Brain Gen 2. The SolidWorks export stands the brain upright
  // on a long edge: measured extents 101.7 x 76.3 x 34.2 mm with the screen
  // recess on +Z, so it would rest 76 mm tall on a 34 mm edge. Rotating -90
  // about X puts the screen face up (+Y) and the 34.2 mm thickness on the
  // vertical axis, giving the real device's 101.7 x 76.3 mm footprint. This
  // also lands the two long walls carrying the mount sockets on +/-Z with the
  // sockets near the base — the same frame the Gen 1 Brain (228-2540) uses,
  // so both generations share one metadata convention.
  '228-6480': (x, y, z) => [x, z, -y],
}

const COLLECTIONS = {
  control: {
    stepDir: path.join(PUBLIC, 'VEX-IQ-All-Control-STEP'),
    glbDir: path.join(PUBLIC, 'VEX-IQ-All-Control-GLB'),
  },
  all: {
    stepDir: path.join(PUBLIC, 'VEX-IQ-All-Parts-2024-11-08'),
    glbDir: path.join(PUBLIC, 'VEX-IQ-All-Parts-GLB'),
  },
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const which = args.find((a) => a === 'control' || a === 'all')
const targets = which ? [which] : ['control', 'all']

// ---- glTF/GLB constants ----
const FLOAT = 5126
const UINT = 5125
const ARRAY_BUFFER = 34962
const ELEMENT_ARRAY_BUFFER = 34963

let occtPromise = null
const getOcct = () => (occtPromise ??= occtimportjs())

async function walkStep(dir) {
  const out = []
  async function rec(cur) {
    let entries
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name)
      if (e.isDirectory()) await rec(abs)
      else if (STEP_EXT.has(path.extname(e.name).toLowerCase())) out.push(abs)
    }
  }
  await rec(dir)
  out.sort()
  return out
}

/** Build a GLB Buffer from occt meshes, baking VEX world scale + grounding. */
function buildGlb(meshes, name) {
  // Optional per-part orientation fix, applied before the bbox is measured so
  // centering and grounding describe the CORRECTED pose.
  const orient = ORIENTATION_CORRECTIONS[name] ?? ((x, y, z) => [x, y, z])

  // Global bbox (mm) for centering/grounding.
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity
  for (const m of meshes) {
    const p = m.attributes.position.array
    for (let i = 0; i < p.length; i += 3) {
      const [px, py, pz] = orient(p[i], p[i + 1], p[i + 2])
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
      if (pz < minZ) minZ = pz
      if (pz > maxZ) maxZ = pz
    }
  }
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const S = MM_TO_WORLD

  const gltf = {
    asset: { version: '2.0', generator: 'vex-step2glb' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [] }],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  }

  const chunks = []
  let offset = 0
  const addView = (buf, target) => {
    const pad = (4 - (offset % 4)) % 4
    if (pad) {
      chunks.push(Buffer.alloc(pad))
      offset += pad
    }
    const view = { buffer: 0, byteOffset: offset, byteLength: buf.length }
    if (target) view.target = target
    gltf.bufferViews.push(view)
    chunks.push(buf)
    offset += buf.length
    return gltf.bufferViews.length - 1
  }

  for (const m of meshes) {
    const src = m.attributes.position.array
    const pos = new Float32Array(src.length)
    let pminx = Infinity,
      pminy = Infinity,
      pminz = Infinity,
      pmaxx = -Infinity,
      pmaxy = -Infinity,
      pmaxz = -Infinity
    for (let i = 0; i < src.length; i += 3) {
      const [ox, oy, oz] = orient(src[i], src[i + 1], src[i + 2])
      const x = (ox - cx) * S
      const y = (oy - minY) * S
      const z = (oz - cz) * S
      pos[i] = x
      pos[i + 1] = y
      pos[i + 2] = z
      if (x < pminx) pminx = x
      if (x > pmaxx) pmaxx = x
      if (y < pminy) pminy = y
      if (y > pmaxy) pmaxy = y
      if (z < pminz) pminz = z
      if (z > pmaxz) pmaxz = z
    }
    const posView = addView(Buffer.from(pos.buffer), ARRAY_BUFFER)
    const posAcc = gltf.accessors.length
    gltf.accessors.push({
      bufferView: posView,
      componentType: FLOAT,
      count: pos.length / 3,
      type: 'VEC3',
      min: [pminx, pminy, pminz],
      max: [pmaxx, pmaxy, pmaxz],
    })

    const attributes = { POSITION: posAcc }
    const nsrc = m.attributes.normal?.array
    if (nsrc && nsrc.length === src.length) {
      // Normals take the same pure rotation as positions (no translation/scale).
      const norm = new Float32Array(nsrc.length)
      for (let i = 0; i < nsrc.length; i += 3) {
        const [nx, ny, nz] = orient(nsrc[i], nsrc[i + 1], nsrc[i + 2])
        norm[i] = nx
        norm[i + 1] = ny
        norm[i + 2] = nz
      }
      const normView = addView(Buffer.from(norm.buffer), ARRAY_BUFFER)
      attributes.NORMAL = gltf.accessors.length
      gltf.accessors.push({
        bufferView: normView,
        componentType: FLOAT,
        count: norm.length / 3,
        type: 'VEC3',
      })
    }

    const idx = Uint32Array.from(m.index.array)
    const idxView = addView(Buffer.from(idx.buffer), ELEMENT_ARRAY_BUFFER)
    const idxAcc = gltf.accessors.length
    gltf.accessors.push({
      bufferView: idxView,
      componentType: UINT,
      count: idx.length,
      type: 'SCALAR',
    })

    const c = m.color || [0.6, 0.63, 0.7]
    const matIdx = gltf.materials.length
    gltf.materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: [c[0], c[1], c[2], 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.7,
      },
    })

    gltf.meshes[0].primitives.push({ attributes, indices: idxAcc, material: matIdx })
  }

  const bin = Buffer.concat(chunks)
  gltf.buffers.push({ byteLength: bin.length })

  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8')
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)])
  const binPad = (4 - (bin.length % 4)) % 4
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)])

  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // "glTF"
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)

  const jsonHead = Buffer.alloc(8)
  jsonHead.writeUInt32LE(jsonChunk.length, 0)
  jsonHead.writeUInt32LE(0x4e4f534a, 4) // "JSON"
  const binHead = Buffer.alloc(8)
  binHead.writeUInt32LE(binChunk.length, 0)
  binHead.writeUInt32LE(0x004e4942, 4) // "BIN\0"

  return Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk])
}

async function main() {
  const occt = await getOcct()
  let ok = 0,
    skip = 0,
    fail = 0

  for (const key of targets) {
    const { stepDir, glbDir } = COLLECTIONS[key]
    const files = await walkStep(stepDir)
    await fs.mkdir(glbDir, { recursive: true })
    console.log(`\n[convert] ${key}: ${files.length} STEP file(s)`)

    for (const abs of files) {
      const base = path.basename(abs, path.extname(abs))
      const out = path.join(glbDir, `${base}.glb`)
      if (!force) {
        try {
          await fs.access(out)
          skip++
          continue
        } catch {
          /* not converted yet */
        }
      }
      try {
        const buffer = new Uint8Array(await fs.readFile(abs))
        const res = occt.ReadStepFile(buffer, null)
        if (!res.success || !res.meshes.length) throw new Error('no meshes')
        const glb = buildGlb(res.meshes, base)
        await fs.writeFile(out, glb)
        ok++
        const kb = (glb.length / 1024).toFixed(0)
        console.log(`  OK   ${base}.glb  (${kb} KB)`)
      } catch (err) {
        fail++
        console.log(`  FAIL ${base}: ${err.message}`)
      }
    }
  }

  console.log(`\n[convert] done — ${ok} converted, ${skip} skipped, ${fail} failed.`)
  if (ok > 0) console.log('[convert] Now run:  npm run generate:parts')
}

main().catch((err) => {
  console.error('[convert] Fatal:', err)
  process.exit(1)
})
