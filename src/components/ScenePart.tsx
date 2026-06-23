import {
  Component,
  useEffect,
  Suspense,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import * as THREE from 'three'
import { useGLTF } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import type { PartDefinition, PartInstanceData } from '../types/assembly'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import {
  buildAllWorldSnapPoints,
  findNearestCompatibleSnap,
  getWorldSnapPoints,
  snapKey,
} from '../utils/snap'
import ProceduralModel from './ProceduralModel'
import SelectionBounds from './SelectionBounds'
import SnapPointMarkers from './SnapPointMarkers'
import SnapDebug from './SnapDebug'

type Props = {
  instance: PartInstanceData
  definition: PartDefinition
  selected: boolean
  pinMode: boolean
  onSelect: (instanceId: string) => void
  groupRef?: (obj: THREE.Group | null) => void
}

/** Attempts to load a GLB model; throws to the Suspense boundary if missing. */
function GLBModel({ path, color }: { path: string; color: string }) {
  // Encode spaces/special chars in the web path for the loader's fetch.
  const { scene } = useGLTF(encodeURI(path))

  // Clone per-instance and shift so the model's bounding-box center sits at the
  // local origin. The converter grounds GLB models (minY = 0), but snap points
  // (and the procedural placeholders) are authored in a center-origin frame.
  // Without this, inferred hole markers render along the model's bottom edge
  // instead of near its visible midline.
  const cloned = useMemo(() => {
    const c = scene.clone(true)
    const box = new THREE.Box3().setFromObject(c)
    const center = box.getCenter(new THREE.Vector3())
    c.position.sub(center)
    return c
  }, [scene])

  // Tint every mesh with the instance color (clone materials so instances of
  // the same part can be colored independently).
  useMemo(() => {
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh && mesh.material) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone()
        mat.color = new THREE.Color(color)
        mesh.material = mat
      }
    })
  }, [cloned, color])

  return <primitive object={cloned} />
}

export default function ScenePart({
  instance,
  definition,
  selected,
  pinMode,
  onSelect,
  groupRef,
}: Props) {
  const [glbFailed, setGlbFailed] = useState(false)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => (s as any).controls)
  const markGlbError = useAssemblyStore((s) => s.markGlbError)
  const snapDebug = useAssemblyStore((s) => s.snapDebug)
  const mode = useAssemblyStore((s) => s.mode)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const updateTransform = useAssemblyStore((s) => s.updatePartTransform)
  const trySnap = useAssemblyStore((s) => s.trySnap)
  const beginHistoryTransaction = useAssemblyStore(
    (s) => s.beginHistoryTransaction,
  )
  const finishHistoryTransaction = useAssemblyStore(
    (s) => s.finishHistoryTransaction,
  )
  const setSnapPreview = useAssemblyStore((s) => s.setSnapPreview)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  // The visible model root — selection bounds are measured from this, never
  // from snap markers, the gizmo, or hard-coded metadata.
  const modelRef = useRef<THREE.Group>(null)
  const instanceRef = useRef(instance)
  instanceRef.current = instance
  const dragRef = useRef<{
    pointerId: number
    plane: THREE.Plane
    offset: THREE.Vector3
    moved: boolean
  } | null>(null)

  useEffect(() => {
    return () => {
      dragRef.current = null
      if (controls) controls.enabled = true
    }
  }, [controls])

  // Only load a GLB when one has actually been converted and is on disk.
  const useGLB =
    !!definition.modelPath && definition.hasConvertedModel === true && !glbFailed

  function updateEasySnapPreview(nextPosition: THREE.Vector3) {
    const store = useAssemblyStore.getState()
    if (!store.snapEnabled) {
      setSnapPreview(null)
      return
    }
    const liveInstance: PartInstanceData = {
      ...instanceRef.current,
      position: [nextPosition.x, nextPosition.y, nextPosition.z],
    }
    const live = getWorldSnapPoints(liveInstance, definition)
    const others = buildAllWorldSnapPoints(
      store.parts.filter((p) => p.instanceId !== instance.instanceId),
    )
    const occupied = new Set<string>()
    for (const c of store.connections) {
      occupied.add(snapKey(c.aInstanceId, c.aSnapId))
      occupied.add(snapKey(c.bInstanceId, c.bSnapId))
    }
    const result = findNearestCompatibleSnap(instance.instanceId, [...live, ...others], {
      maxDistance: store.snapThreshold,
      occupied,
    })
    if (!result) {
      setSnapPreview(null)
      if (store.statusMessage.startsWith('Release to snap')) {
        setStatus('Move near a compatible snap point')
      }
      return
    }
    const targetPart = store.parts.find(
      (p) => p.instanceId === result.target.instanceId,
    )
    const targetDef = targetPart ? getPartDefinition(targetPart.partId) : null
    setSnapPreview({
      draggedInstanceId: instance.instanceId,
      draggedSnapId: result.dragged.id,
      targetInstanceId: result.target.instanceId,
      targetSnapId: result.target.id,
    })
    setStatus(
      `Release to snap: ${definition.name} ${result.dragged.id} → ${
        targetDef?.name ?? 'part'
      } ${result.target.id}`,
    )
  }

  function startEasyDrag(e: any) {
    if (!easyMode || pinMode || (mode !== 'select' && mode !== 'move')) return
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect(instance.instanceId)
    camera.updateMatrixWorld()
    const plane = new THREE.Plane(
      new THREE.Vector3(0, 1, 0),
      -instance.position[1],
    )
    const hit = new THREE.Vector3()
    if (!e.ray.intersectPlane(plane, hit)) return
    const origin = new THREE.Vector3(...instance.position)
    dragRef.current = {
      pointerId: e.pointerId,
      plane,
      offset: hit.sub(origin),
      moved: false,
    }
    if (controls) controls.enabled = false
    e.target?.setPointerCapture?.(e.pointerId)
    beginHistoryTransaction('Move Part')
    setStatus('Drag to move; release near a compatible snap point')
  }

  function moveEasyDrag(e: any) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.stopPropagation()
    const hit = new THREE.Vector3()
    if (!e.ray.intersectPlane(drag.plane, hit)) return
    const next = hit.sub(drag.offset)
    const previous = instanceRef.current.position
    if (
      Math.abs(next.x - previous[0]) > 0.001 ||
      Math.abs(next.y - previous[1]) > 0.001 ||
      Math.abs(next.z - previous[2]) > 0.001
    ) {
      drag.moved = true
    }
    updateTransform(
      instance.instanceId,
      [next.x, next.y, next.z],
      instanceRef.current.rotation,
    )
    updateEasySnapPreview(next)
  }

  function endEasyDrag(e: any) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.stopPropagation()
    dragRef.current = null
    if (controls) controls.enabled = true
    e.target?.releasePointerCapture?.(e.pointerId)
    setSnapPreview(null)
    if (drag.moved) {
      trySnap(instance.instanceId)
      const finalState = useAssemblyStore.getState()
      finishHistoryTransaction(
        finalState.statusMessage === 'Parts snapped together'
          ? 'Snap Parts'
          : 'Move Part',
      )
    } else {
      finishHistoryTransaction('Move Part')
    }
  }

  return (
    <>
      <group
        ref={(obj) => {
          groupRef?.(obj)
        }}
        position={instance.position}
        rotation={instance.rotation}
        scale={instance.scale}
        onPointerDown={(e) => {
          // Selecting should not interfere with hole-clicks in pin mode.
          if (pinMode) return
          if (easyMode && (mode === 'select' || mode === 'move')) {
            startEasyDrag(e)
            return
          }
          e.stopPropagation()
          onSelect(instance.instanceId)
        }}
        onPointerMove={moveEasyDrag}
        onPointerUp={endEasyDrag}
        onPointerCancel={endEasyDrag}
      >
        <group ref={modelRef}>
          {useGLB ? (
            <Suspense fallback={null}>
              <ErrorCatcher
                onError={() => {
                  setGlbFailed(true)
                  markGlbError(definition.id)
                }}
              >
                <GLBModel path={definition.modelPath!} color={instance.color} />
              </ErrorCatcher>
            </Suspense>
          ) : (
            <ProceduralModel definition={definition} color={instance.color} />
          )}
        </group>

        {/* Snap markers live OUTSIDE modelRef so they are excluded from the
            selection Box3, but inside the transformed group so they track the
            part. They handle Pin Mode hole clicks and click-to-snap. */}
        <SnapPointMarkers instance={instance} definition={definition} />

        {/* Debug overlay (origin axes + snap labels), selected part only.
            Also a sibling of modelRef → excluded from the selection Box3. */}
        {selected && snapDebug && (
          <SnapDebug instance={instance} definition={definition} />
        )}
      </group>

      {/* Rendered in world space (sibling of the transformed group) so the box
          comes straight from the world-space Box3 of the real model. Mounted
          only while selected to avoid idle per-frame work on other parts. */}
      {selected && <SelectionBounds targetRef={modelRef} visible />}
    </>
  )
}

// Minimal error boundary so a missing/broken GLB falls back to procedural.
class ErrorCatcher extends Component<
  { children: ReactNode; onError: () => void },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch() {
    this.props.onError()
  }
  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}
