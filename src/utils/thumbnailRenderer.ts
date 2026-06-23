import * as THREE from 'three'
import { GLTFLoader } from 'three-stdlib'

/**
 * Renders small PNG thumbnails of part GLBs in the browser, on demand.
 *
 * One shared offscreen WebGL renderer + scene is reused for every part (a second
 * tiny GL context alongside the main viewport). Models are loaded, framed,
 * rendered to a data URL, then disposed — only the resulting PNG string is kept.
 * Calls are serialized through a queue so the single shared scene is never
 * rendering two models at once. This is intentionally NOT a build step: it needs
 * no extra dependencies and no Chromium, and results are cached per session.
 */
const SIZE = 80

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let loader: GLTFLoader | null = null

function ensureRenderer(): boolean {
  if (renderer) return true
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true, // required for toDataURL()
    })
    renderer.setSize(SIZE, SIZE)
    renderer.setPixelRatio(1)
    scene = new THREE.Scene()
    scene.add(new THREE.AmbientLight(0xffffff, 0.85))
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(3, 5, 4)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.35)
    fill.position.set(-4, 2, -3)
    scene.add(fill)
    camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000)
    loader = new GLTFLoader()
    return true
  } catch {
    renderer = null
    return false
  }
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose()
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial
        mat?.map?.dispose()
        mat?.dispose?.()
      }
    }
  })
}

async function renderOne(modelPath: string, tint?: string): Promise<string> {
  if (!ensureRenderer() || !renderer || !scene || !camera || !loader) {
    throw new Error('no-webgl')
  }
  const gltf = await loader.loadAsync(encodeURI(modelPath))
  const model = gltf.scene

  // Center on the bounding-box center and frame it to fill the thumbnail.
  const box = new THREE.Box3().setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  model.position.sub(center)

  if (tint) {
    const color = new THREE.Color(tint)
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh && mesh.material) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone()
        mat.color = color.clone()
        mesh.material = mat
      }
    })
  }

  scene.add(model)
  try {
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const dist = (maxDim / 2 / Math.tan((camera.fov * Math.PI) / 360)) * 1.6
    camera.position.set(dist * 0.7, dist * 0.6, dist)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  } finally {
    scene.remove(model)
    disposeObject(model)
  }
}

const cache = new Map<string, Promise<string>>()
// Serializes renders so the single shared scene only draws one model at a time.
let queue: Promise<unknown> = Promise.resolve()

/** Cached, queued thumbnail render. Resolves to a PNG data URL. */
export function getPartThumbnail(modelPath: string, tint?: string): Promise<string> {
  const key = `${modelPath}|${tint ?? ''}`
  const existing = cache.get(key)
  if (existing) return existing

  // Chain after the previous render so the shared scene stays single-threaded.
  const prev = queue
  const job = prev
    .catch(() => undefined)
    .then(() => renderOne(modelPath, tint))
  queue = job
  cache.set(key, job)
  // Drop failed entries so a transient error can be retried later.
  job.catch(() => cache.delete(key))
  return job
}
