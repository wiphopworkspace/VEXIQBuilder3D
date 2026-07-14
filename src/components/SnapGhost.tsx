import { Suspense, useMemo } from 'react'
import * as THREE from 'three'
import { Line, useGLTF } from '@react-three/drei'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'
import { getWorldSnapPoints, shaftMateKind } from '../utils/snap'
import type { ShaftMateKind } from '../utils/snap'
import { assetUrl } from '../utils/assetUrl'

// Ghost meshes must never intercept pointer picking. (Never pass `undefined` to
// `raycast` — R3F assigns it literally and breaks Mesh.prototype.raycast.)
const NO_RAYCAST = () => null

const SHAFT_AXIS_COLOR: Record<ShaftMateKind, string> = {
  'motor-drive': '#f59e0b', // amber — powered by the motor
  'rotation-locked': '#22c55e', // green — locked to the shaft
  'free-spinning': '#38bdf8', // blue — spins freely / axial support
}

/** A translucent clone of the part's GLB, recentered like ScenePart's GLBModel. */
function GhostModel({ path, color }: { path: string; color: string }) {
  const { scene } = useGLTF(assetUrl(path))
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
 * Shaft-family previews additionally draw the insertion/rotation axis through
 * the receiving socket or bore, color-coded by what the connection will do
 * (motor-driven / rotation-locked / free-spinning). Visual-only (never
 * raycastable). GLB parts only; procedural placeholders fall back to just the
 * snap line + highlighted markers.
 */
export default function SnapGhost() {
  const snapPreview = useAssemblyStore((s) => s.snapPreview)
  const parts = useAssemblyStore((s) => s.parts)
  if (!snapPreview?.previewPosition || !snapPreview.previewRotation) return null
  const inst = parts.find((p) => p.instanceId === snapPreview.draggedInstanceId)
  if (!inst) return null
  const def = getPartDefinition(inst.partId)

  // Shaft-axis preview: resolve the target snap in world space and classify
  // the pair. Non-shaft pairs render no line (pins keep the classic cues).
  let axisLine: { points: [THREE.Vector3, THREE.Vector3]; color: string } | null =
    null
  const targetInst = parts.find(
    (p) => p.instanceId === snapPreview.targetInstanceId,
  )
  const targetDef = targetInst ? getPartDefinition(targetInst.partId) : undefined
  const draggedSnapType = def
    ? getSnapPoints(def).find((s) => s.id === snapPreview.draggedSnapId)?.type
    : undefined
  if (targetInst && targetDef && draggedSnapType) {
    const targetWorld = getWorldSnapPoints(targetInst, targetDef).find(
      (s) => s.id === snapPreview.targetSnapId,
    )
    const kind = targetWorld
      ? shaftMateKind(draggedSnapType, targetWorld.type)
      : null
    const axis = targetWorld?.worldMateAxis ?? targetWorld?.worldAxis
    if (targetWorld && kind && axis && axis.lengthSq() > 1e-10) {
      const dir = axis.clone().normalize()
      const center = targetWorld.worldMatePosition
      const HALF = 1.2
      axisLine = {
        points: [
          center.clone().addScaledVector(dir, -HALF),
          center.clone().addScaledVector(dir, HALF),
        ],
        color: SHAFT_AXIS_COLOR[kind],
      }
    }
  }

  const ghost =
    def?.modelPath && def.hasConvertedModel === true ? (
      <group
        position={snapPreview.previewPosition}
        rotation={snapPreview.previewRotation}
      >
        <Suspense fallback={null}>
          <GhostModel path={def.modelPath} color={inst.color} />
        </Suspense>
      </group>
    ) : null

  if (!ghost && !axisLine) return null
  return (
    <>
      {ghost}
      {axisLine && (
        <Line
          points={axisLine.points}
          color={axisLine.color}
          lineWidth={2}
          transparent
          opacity={0.8}
          dashed
          dashSize={0.08}
          gapSize={0.05}
          raycast={NO_RAYCAST}
        />
      )}
    </>
  )
}
