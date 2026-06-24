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
  buildOccupiedSnapSet,
  findNearestCompatibleSnap,
  getWorldSnapPoints,
} from '../utils/snap'
import { surfaceConnector } from '../utils/mateConnectors'
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

// Minimum clickable half-extent (world units) so tiny parts — e.g. a 1x1
// connector pin (~0.23 × 0.25 × 0.48) — are easy to grab. One hole pitch is 0.5,
// so 0.2 keeps the proxy comfortably inside a single-cell footprint.
const HIT_PROXY_HALF = 0.2
const EASY_DRAG_START_PX = 4

// THREE's default mesh raycast. We toggle a mesh between "raycastable" and
// "ignored" via the `raycast` prop, but we must NEVER pass `undefined` to mean
// "default": R3F assigns it literally, shadowing Mesh.prototype.raycast with
// undefined, so the next raytest throws "object.raycast is not a function" and
// freezes all pointer interaction. Pass this real function instead.
const DEFAULT_RAYCAST = THREE.Mesh.prototype.raycast
const NO_RAYCAST = () => null

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
  const pickMateConnector = useAssemblyStore((s) => s.pickMateConnector)
  const isInstanceConnected = useAssemblyStore((s) => s.isInstanceConnected)
  const isJointPositionLocked = useAssemblyStore((s) => s.isJointPositionLocked)
  const toggleJointPositionLock = useAssemblyStore(
    (s) => s.toggleJointPositionLock,
  )
  // The visible model root — selection bounds are measured from this, never
  // from snap markers, the gizmo, or hard-coded metadata.
  const modelRef = useRef<THREE.Group>(null)
  const instanceRef = useRef(instance)
  instanceRef.current = instance
  const dragRef = useRef<{
    pointerId: number
    plane: THREE.Plane
    offset: THREE.Vector3
    startClientX: number
    startClientY: number
    dragging: boolean
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
    const occupied = buildOccupiedSnapSet(store.connections, store.parts)
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
    if (isJointPositionLocked(instance.instanceId)) {
      setStatus('Part is locked by a joint. Right-click to unlock position.')
      return
    }
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
      startClientX: e.clientX ?? 0,
      startClientY: e.clientY ?? 0,
      dragging: false,
      moved: false,
    }
    if (controls) controls.enabled = false
    e.target?.setPointerCapture?.(e.pointerId)
    setStatus(`Selected ${definition.name}`)
  }

  function moveEasyDrag(e: any) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.stopPropagation()
    if (!drag.dragging) {
      const dx = (e.clientX ?? drag.startClientX) - drag.startClientX
      const dy = (e.clientY ?? drag.startClientY) - drag.startClientY
      if (Math.hypot(dx, dy) < EASY_DRAG_START_PX) return
      drag.dragging = true
      beginHistoryTransaction('Move Part')
      setStatus('Drag to move; release near a compatible snap point')
    }
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
    if (drag.dragging && drag.moved) {
      trySnap(instance.instanceId)
      const finalState = useAssemblyStore.getState()
      finishHistoryTransaction(
        finalState.statusMessage === 'Parts snapped together'
          ? 'Snap Parts'
          : 'Move Part',
      )
    } else if (drag.dragging) {
      finishHistoryTransaction('Move Part')
    } else {
      setStatus(`Selected ${definition.name}`)
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
          // Mate Connector Tool: clicking part geometry (away from a connector
          // dot, which swallows the event) creates a surface-pick connector.
          if (mode === 'mate') {
            e.stopPropagation()
            onSelect(instance.instanceId)
            const point = (e.point as THREE.Vector3).clone()
            const worldNormal = e.face
              ? e.face.normal
                  .clone()
                  .transformDirection((e.object as THREE.Object3D).matrixWorld)
              : new THREE.Vector3(0, 1, 0)
            pickMateConnector(
              instance.instanceId,
              surfaceConnector(instance.instanceId, point, worldNormal),
            )
            return
          }
          if (easyMode && (mode === 'select' || mode === 'move')) {
            startEasyDrag(e)
            return
          }
          e.stopPropagation()
          onSelect(instance.instanceId)
        }}
        onContextMenu={(e) => {
          e.stopPropagation()
          e.nativeEvent?.preventDefault?.()
          onSelect(instance.instanceId)
          if (isInstanceConnected(instance.instanceId)) {
            toggleJointPositionLock(instance.instanceId)
          } else {
            setStatus('Part is not connected. Snap it to a pin or hole before locking.')
          }
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

        {/* Invisible minimum hit target so small parts (e.g. a 1x1 pin) are easy
            to click and drag. Sibling of modelRef → excluded from the selection
            Box3, and opacity 0 → no pixels in screenshots. Non-raycastable in
            Pin/Joint Mode so it never intercepts snap-marker clicks. Pointer
            events bubble to the transformed group's handlers below. */}
        <mesh
          raycast={
            pinMode || mode === 'joint' || mode === 'mate'
              ? NO_RAYCAST
              : DEFAULT_RAYCAST
          }
        >
          <boxGeometry
            args={[HIT_PROXY_HALF * 2, HIT_PROXY_HALF * 2, HIT_PROXY_HALF * 2]}
          />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>

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
