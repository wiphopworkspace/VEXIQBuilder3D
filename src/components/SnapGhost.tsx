import { Suspense, useMemo } from 'react'
import * as THREE from 'three'
import { useGLTF } from '@react-three/drei'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'

// Ghost meshes must never intercept pointer picking. (Never pass `undefined` to
// `raycast` — R3F assigns it literally and breaks Mesh.prototype.raycast.)
const NO_RAYCAST = () => null

/** A translucent clone of the part's GLB, recentered like ScenePart's GLBModel. */
function GhostModel({ path, color }: { path: string; color: string }) {
  const { scene } = useGLTF(encodeURI(path))
  const cloned = useMemo(() => {
    const c = scene.clone(true)
    const box = new THREE.Box3().setFromObject(c)
    c.position.sub(box.getCenter(new THREE.Vector3()))
    c.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh && mesh.material) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone()
        mat.color = new THREE.Color(color)
        mat.transparent = true
        mat.opacity = 0.5
        mat.depthWrite = false
        mesh.material = mat
        mesh.raycast = NO_RAYCAST
      }
    })
    return c
  }, [scene, color])
  return <primitive object={cloned} />
}

/**
 * Ghost of the dragged part shown at the position it will seat if released
 * during an Auto Snap drag — a live "this is where the pin will connect" cue.
 * Visual-only (never raycastable). GLB parts only; procedural placeholders fall
 * back to just the snap line + highlighted markers.
 */
export default function SnapGhost() {
  const snapPreview = useAssemblyStore((s) => s.snapPreview)
  const parts = useAssemblyStore((s) => s.parts)
  if (!snapPreview?.previewPosition || !snapPreview.previewRotation) return null
  const inst = parts.find((p) => p.instanceId === snapPreview.draggedInstanceId)
  if (!inst) return null
  const def = getPartDefinition(inst.partId)
  if (!def?.modelPath || def.hasConvertedModel !== true) return null
  return (
    <group
      position={snapPreview.previewPosition}
      rotation={snapPreview.previewRotation}
    >
      <Suspense fallback={null}>
        <GhostModel path={def.modelPath} color={inst.color} />
      </Suspense>
    </group>
  )
}
