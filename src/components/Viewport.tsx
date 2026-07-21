import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, TransformControls } from '@react-three/drei'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import {
  buildAllWorldSnapPoints,
  buildOccupiedSnapSet,
  findNearestCompatibleSnap,
  getWorldSnapPoints,
} from '../utils/snap'
import {
  HOLE_PITCH,
  latticeReferenceLocal,
  quantizeToHoleLattice,
} from '../utils/gridSnap'
import ScenePart from './ScenePart'
import SnapGhost from './SnapGhost'
import GuideCoach from './GuideCoach'
import MateConnectorPicker from './MateConnectorPicker'
import MateStepPanel from './MateStepPanel'
import ActiveMateHighlight from './ActiveMateHighlight'
import { PART_DND_MIME } from './PartsPanel'

type Placer = (clientX: number, clientY: number) => [number, number, number] | null

/**
 * Stable empty array for the secondary-selection selector. Returning a fresh
 * `[]` from a Zustand selector would be a new reference every render and spin
 * the subscription.
 */
const EMPTY_SELECTION: string[] = []

/**
 * Exposes a screen→ground projector so the viewport's HTML drop handler (which
 * lives outside the R3F canvas, with no camera) can turn a drop point into a
 * world position on the grid plane.
 */
function DropPlacer({ placerRef }: { placerRef: { current: Placer | null } }) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const ray = new THREE.Raycaster()
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    placerRef.current = (clientX, clientY) => {
      const rect = gl.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      ray.setFromCamera(ndc, camera)
      const hit = new THREE.Vector3()
      if (ray.ray.intersectPlane(plane, hit)) return [hit.x, 0.25, hit.z]
      return null
    }
    return () => {
      placerRef.current = null
    }
  }, [camera, gl, placerRef])
  return null
}

type GroupMap = Map<string, THREE.Group>

type ViewName = 'front' | 'top' | 'right' | 'iso'

type CameraApi = {
  setView: (view: ViewName) => void
  focusSelected: () => void
}

// Unit view directions (camera sits at target + dir * distance).
const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  front: [0, 0.12, 1],
  top: [0, 1, 0.0001], // epsilon keeps OrbitControls' up vector stable
  right: [1, 0.12, 0],
  iso: [1, 0.9, 1],
}

/**
 * Imperative camera API for the HTML view buttons (which live outside the
 * canvas). View presets keep the current orbit target and distance; Focus
 * frames the selected part — or the whole assembly when nothing is selected —
 * keeping the current view direction. Both animate smoothly.
 */
function CameraCommander({
  apiRef,
  groupRefs,
}: {
  apiRef: { current: CameraApi | null }
  groupRefs: GroupMap
}) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as any
  const anim = useRef<{
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromTgt: THREE.Vector3
    toTgt: THREE.Vector3
    t: number
  } | null>(null)

  useEffect(() => {
    if (!controls) {
      apiRef.current = null
      return
    }
    const startTween = (toPos: THREE.Vector3, toTgt: THREE.Vector3) => {
      anim.current = {
        fromPos: camera.position.clone(),
        toPos,
        fromTgt: (controls.target as THREE.Vector3).clone(),
        toTgt,
        t: 0,
      }
    }
    apiRef.current = {
      setView: (view) => {
        const target = (controls.target as THREE.Vector3).clone()
        const distance = camera.position.distanceTo(target)
        const dir = new THREE.Vector3(...VIEW_DIRS[view]).normalize()
        startTween(target.clone().addScaledVector(dir, distance), target)
      },
      focusSelected: () => {
        const { selectedInstanceId } = useAssemblyStore.getState()
        const box = new THREE.Box3()
        const measure = (obj: THREE.Object3D) => {
          obj.updateWorldMatrix(true, true)
          box.expandByObject(obj)
        }
        const selected = selectedInstanceId
          ? groupRefs.get(selectedInstanceId)
          : undefined
        if (selected) measure(selected)
        else groupRefs.forEach(measure)
        if (box.isEmpty()) return
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const radius = Math.max(size.length() / 2, 0.4)
        const fov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180
        const distance = Math.max((radius / Math.tan(fov / 2)) * 1.35, 1.2)
        const dir = camera.position
          .clone()
          .sub(controls.target as THREE.Vector3)
          .normalize()
        if (dir.lengthSq() < 1e-6) dir.set(1, 0.9, 1).normalize()
        startTween(center.clone().addScaledVector(dir, distance), center)
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [camera, controls, apiRef, groupRefs])

  useFrame((_, delta) => {
    const a = anim.current
    if (!a || !controls) return
    a.t = Math.min(a.t + delta / 0.35, 1)
    const e = a.t * a.t * (3 - 2 * a.t) // smoothstep ease
    camera.position.lerpVectors(a.fromPos, a.toPos, e)
    ;(controls.target as THREE.Vector3).lerpVectors(a.fromTgt, a.toTgt, e)
    controls.update()
    if (a.t >= 1) anim.current = null
  })

  return null
}

/** Live line drawn between the candidate snap pair while dragging. */
function SnapPreviewLine({ groupRefs }: { groupRefs: GroupMap }) {
  const line = useMemo(() => {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3),
    )
    const mat = new THREE.LineBasicMaterial({
      color: '#ffe24d',
      depthTest: false,
      transparent: true,
    })
    const obj = new THREE.Line(geom, mat)
    obj.frustumCulled = false
    obj.visible = false
    obj.raycast = () => null
    return obj
  }, [])

  // Dispose the geometry/material when the Viewport unmounts (no GPU leak).
  useEffect(() => {
    return () => {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
  }, [line])

  useFrame(() => {
    const { snapPreview, parts } = useAssemblyStore.getState()
    if (!snapPreview) {
      line.visible = false
      return
    }
    const find = (instanceId: string, snapId: string) => {
      const inst = parts.find((p) => p.instanceId === instanceId)
      const def = inst ? getPartDefinition(inst.partId) : undefined
      const obj = groupRefs.get(instanceId)
      if (!inst || !def || !obj) return null
      const wp = getWorldSnapPoints(inst, def, obj).find((s) => s.id === snapId)
      return wp?.worldPosition ?? null
    }
    const a = find(snapPreview.draggedInstanceId, snapPreview.draggedSnapId)
    const b = find(snapPreview.targetInstanceId, snapPreview.targetSnapId)
    if (!a || !b) {
      line.visible = false
      return
    }
    const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.setXYZ(0, a.x, a.y, a.z)
    attr.setXYZ(1, b.x, b.y, b.z)
    attr.needsUpdate = true
    line.visible = true
  })

  return <primitive object={line} />
}

// Bridges the live WebGL canvas element up to the TopBar for screenshots.
function CanvasExporter({
  onReady,
}: {
  onReady: (canvas: HTMLCanvasElement) => void
}) {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    onReady(gl.domElement)
  }, [gl, onReady])
  return null
}

function Scene({ viewApiRef }: { viewApiRef: { current: CameraApi | null } }) {
  const parts = useAssemblyStore((s) => s.parts)
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const mode = useAssemblyStore((s) => s.mode)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const selectPart = useAssemblyStore((s) => s.selectPart)
  const toggleSelectPart = useAssemblyStore((s) => s.toggleSelectPart)
  // Secondary (Shift/Ctrl+click) selections, for the extra outlines. The
  // anchor check mirrors getSelectionIds so a stale set never paints.
  const secondarySelection = useAssemblyStore((s) =>
    s.multiSelectAnchor && s.multiSelectAnchor === s.selectedInstanceId
      ? s.multiSelectIds
      : EMPTY_SELECTION,
  )
  const handleSelect = useCallback(
    (instanceId: string, additive?: boolean) => {
      if (additive) toggleSelectPart(instanceId)
      else selectPart(instanceId)
    },
    [selectPart, toggleSelectPart],
  )
  const updateTransform = useAssemblyStore((s) => s.updatePartTransform)
  const trySnap = useAssemblyStore((s) => s.trySnap)
  const updateRotationKeepingJoint = useAssemblyStore(
    (s) => s.updatePartRotationKeepingJoint,
  )
  const isInstanceConnected = useAssemblyStore((s) => s.isInstanceConnected)
  // Subscribe to the lock DATA so the move gizmo appears/disappears immediately
  // when a part is locked/unlocked (via the button or a right-click).
  const jointPositionUnlocked = useAssemblyStore((s) => s.jointPositionUnlocked)
  // CAD-style incremental snapping for the gizmo (0 = free). three.js
  // TransformControls quantizes the part ORIGIN to the absolute world grid
  // natively (no phase hook) — the hole-lattice registration applies to the
  // Basic-Mode drag and drop; gizmo releases still seat through trySnap.
  const moveStep = useAssemblyStore((s) => s.moveStep)
  const rotationStepDeg = useAssemblyStore((s) => s.rotationStepDeg)
  const gridCell = moveStep >= 0.25 ? moveStep : HOLE_PITCH
  const beginHistoryTransaction = useAssemblyStore(
    (s) => s.beginHistoryTransaction,
  )
  const finishHistoryTransaction = useAssemblyStore(
    (s) => s.finishHistoryTransaction,
  )

  // Track the selected object's group so TransformControls can attach to it.
  const groupRefs = useRef<Map<string, THREE.Group>>(new Map())
  const transformRef = useRef<any>(null)
  const orbitRef = useRef<any>(null)

  const selectedObject =
    selectedId != null ? groupRefs.current.get(selectedId) : undefined
  const selectedConnected = selectedId ? isInstanceConnected(selectedId) : false
  const selectedJointLocked =
    selectedConnected && selectedId != null && !jointPositionUnlocked[selectedId]

  const showGizmo =
    !easyMode &&
    (mode === 'rotate' || (mode === 'move' && !selectedJointLocked)) &&
    selectedObject != null

  // Disable orbit while dragging; live-preview snapping; commit + snap on end.
  useEffect(() => {
    const controls = transformRef.current
    if (!controls) return

    const onDragging = (e: any) => {
      if (orbitRef.current) orbitRef.current.enabled = !e.value
      if (e.value && selectedId && selectedObject) {
        beginHistoryTransaction(mode === 'rotate' ? 'Rotate Part' : 'Move Part')
      }
      if (!e.value && selectedId && selectedObject) {
        // Drag ended: commit live transform. Connected parts are joint-locked:
        // rotation keeps the active mate point fixed, and translation is hidden.
        const pos = selectedObject.position
        const rot = selectedObject.rotation
        if (mode === 'rotate') {
          updateRotationKeepingJoint(selectedId, [rot.x, rot.y, rot.z])
        } else {
          updateTransform(selectedId, [pos.x, pos.y, pos.z], [rot.x, rot.y, rot.z])
          trySnap(selectedId)
        }
        const finalState = useAssemblyStore.getState()
        finishHistoryTransaction(
          finalState.statusMessage === 'Parts snapped together'
            ? 'Snap Parts'
            : mode === 'rotate'
              ? 'Rotate Part'
              : 'Move Part',
        )
      }
    }

    // Live snap preview while the gizmo moves the part.
    const onObjectChange = () => {
      const store = useAssemblyStore.getState()
      if (!store.snapEnabled || !selectedId || !selectedObject) return
      if (mode === 'rotate' && store.isInstanceConnected(selectedId)) {
        store.setSnapPreview(null)
        return
      }
      const dragged = store.parts.find((p) => p.instanceId === selectedId)
      const def = dragged ? getPartDefinition(dragged.partId) : undefined
      if (!dragged || !def) return

      const live = getWorldSnapPoints(dragged, def, selectedObject)
      const others = buildAllWorldSnapPoints(
        store.parts.filter((p) => p.instanceId !== selectedId),
      )
      const occupied = buildOccupiedSnapSet(store.connections, store.parts)
      const snapInfo = { allRejectedByOverlap: false }
      const result = findNearestCompatibleSnap(selectedId, [...live, ...others], {
        maxDistance: store.snapThreshold,
        occupied,
        basicMode: store.easyMode,
        parts: store.parts,
        connections: store.connections,
        info: snapInfo,
      })
      if (result) {
        const targetPart = store.parts.find(
          (p) => p.instanceId === result.target.instanceId,
        )
        const targetDef = targetPart
          ? getPartDefinition(targetPart.partId)
          : undefined
        store.setSnapPreview({
          draggedInstanceId: selectedId,
          draggedSnapId: result.dragged.id,
          targetInstanceId: result.target.instanceId,
          targetSnapId: result.target.id,
        })
        store.setStatus(
          `Release to snap: ${def.name} ${result.dragged.id} → ${
            targetDef?.name ?? 'part'
          } ${result.target.id}`,
        )
      } else {
        store.setSnapPreview(null)
        if (snapInfo.allRejectedByOverlap) {
          store.setStatus('Snap blocked — parts would overlap here')
        }
      }
    }

    controls.addEventListener('dragging-changed', onDragging)
    controls.addEventListener('objectChange', onObjectChange)
    return () => {
      controls.removeEventListener('dragging-changed', onDragging)
      controls.removeEventListener('objectChange', onObjectChange)
    }
  }, [
    selectedId,
    selectedObject,
    updateTransform,
    trySnap,
    updateRotationKeepingJoint,
    showGizmo,
    beginHistoryTransaction,
    finishHistoryTransaction,
    mode,
    selectedConnected,
    selectedJointLocked,
  ])

  return (
    <>
      <color attach="background" args={['#0b0d12']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 8, 5]} intensity={0.8} />
      <directionalLight position={[-5, 4, -3]} intensity={0.3} />

      {/* Ground grid mirrors the ACTIVE move step (coarser steps draw coarser
          cells) so what users see is what drags snap to; Free/Fine fall back
          to the 0.5 hole pitch. Sections stay a whole multiple of the cell. */}
      <Grid
        args={[40, 40]}
        cellSize={gridCell}
        cellThickness={0.6}
        cellColor="#2a2f3a"
        sectionSize={gridCell < 0.5 ? gridCell * 10 : gridCell * 5}
        sectionThickness={1}
        sectionColor="#3a4250"
        fadeDistance={30}
        infiniteGrid
        position={[0, 0, 0]}
      />
      <axesHelper args={[1.5]} />

      {parts.map((instance) => {
        const def = getPartDefinition(instance.partId)
        if (!def) return null
        return (
          <ScenePart
            key={instance.instanceId}
            instance={instance}
            definition={def}
            selected={instance.instanceId === selectedId}
            alsoSelected={secondarySelection.includes(instance.instanceId)}
            pinMode={mode === 'pin'}
            onSelect={handleSelect}
            groupRef={(obj) => {
              if (obj) groupRefs.current.set(instance.instanceId, obj)
              else groupRefs.current.delete(instance.instanceId)
            }}
          />
        )
      })}

      <SnapPreviewLine groupRefs={groupRefs.current} />
      <CameraCommander apiRef={viewApiRef} groupRefs={groupRefs.current} />
      <SnapGhost />
      <ActiveMateHighlight />

      {mode === 'mate' && <MateConnectorPicker />}

      {showGizmo && selectedObject && (
        <TransformControls
          ref={transformRef}
          object={selectedObject}
          mode={mode === 'rotate' ? 'rotate' : 'translate'}
          size={0.8}
          translationSnap={moveStep > 0 ? moveStep : null}
          rotationSnap={
            rotationStepDeg > 0 ? (rotationStepDeg * Math.PI) / 180 : null
          }
        />
      )}

      <OrbitControls
        ref={orbitRef}
        makeDefault
        enableDamping
        dampingFactor={0.1}
        maxDistance={40}
        minDistance={1}
      />
    </>
  )
}

export default function Viewport({
  onCanvasReady,
}: {
  onCanvasReady: (canvas: HTMLCanvasElement) => void
}) {
  const mode = useAssemblyStore((s) => s.mode)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const selectPart = useAssemblyStore((s) => s.selectPart)
  const clearJoint = useAssemblyStore((s) => s.clearJoint)
  const jointSource = useAssemblyStore((s) => s.jointSource)
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const isInstanceConnected = useAssemblyStore((s) => s.isInstanceConnected)
  // Subscribe to the lock DATA so the Basic-Mode hint follows lock/unlock.
  const jointPositionUnlocked = useAssemblyStore((s) => s.jointPositionUnlocked)
  const addPart = useAssemblyStore((s) => s.addPart)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  const placerRef = useRef<Placer | null>(null)
  const viewApiRef = useRef<CameraApi | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // `Z` frames the selected part (F is taken by flip). Lives here because the
  // camera API ref is viewport-local, unlike the store shortcuts in App.tsx.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'z' && e.key !== 'Z') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }
      viewApiRef.current?.focusSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const selectedLocked =
    selectedId != null &&
    isInstanceConnected(selectedId) &&
    !jointPositionUnlocked[selectedId]

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PART_DND_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragOver) setDragOver(true)
  }
  const handleDrop = (e: React.DragEvent) => {
    const partId = e.dataTransfer.getData(PART_DND_MIME)
    setDragOver(false)
    if (!partId) return
    e.preventDefault()
    const raw = placerRef.current?.(e.clientX, e.clientY)
    // Drop onto the same hole lattice the drags use, so a placed part's holes
    // start pin-alignable with everything already on the grid. New instances
    // spawn unrotated, so the reference offset uses identity rotation.
    const step = useAssemblyStore.getState().moveStep
    let pos: [number, number, number] | undefined
    if (raw) {
      const v = quantizeToHoleLattice(
        new THREE.Vector3(raw[0], raw[1], raw[2]),
        step,
        [0, 0, 0],
        latticeReferenceLocal(getPartDefinition(partId)),
      )
      pos = [v.x, raw[1], v.z]
    }
    const id = addPart(partId, pos)
    if (id) setStatus('Part placed — drag it to snap, or rotate to align')
  }

  return (
    <div
      className={`viewport${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the viewport bounds.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={handleDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Canvas
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [4, 4, 6], fov: 50, near: 0.1, far: 200 }}
        dpr={[1, 1.75]}
        onPointerMissed={() => {
          // Empty-space click: cancel a pending joint pick, else deselect.
          if (mode === 'joint') clearJoint()
          else if (mode !== 'pin') selectPart(null)
        }}
      >
        <CanvasExporter onReady={onCanvasReady} />
        <DropPlacer placerRef={placerRef} />
        <Scene viewApiRef={viewApiRef} />
      </Canvas>
      <div className="viewport-views">
        <button
          onClick={() => viewApiRef.current?.setView('iso')}
          title="Isometric 3D view"
        >
          3D
        </button>
        <button
          onClick={() => viewApiRef.current?.setView('front')}
          title="Front view"
        >
          Front
        </button>
        <button
          onClick={() => viewApiRef.current?.setView('top')}
          title="Top view"
        >
          Top
        </button>
        <button
          onClick={() => viewApiRef.current?.setView('right')}
          title="Right view"
        >
          Right
        </button>
        <button
          onClick={() => viewApiRef.current?.focusSelected()}
          title="Frame the selected part, or the whole assembly (Z)"
        >
          ⌖ Focus
        </button>
      </div>
      <GuideCoach />
      {dragOver && (
        <div className="viewport-drop">Drop to place the part</div>
      )}
      {easyMode && mode === 'select' && (
        <div className="viewport-hint">
          {selectedLocked
            ? 'Locked joint - right-click part or use Unlock Position to move · rotate still pivots on the pin'
            : 'Basic Mode - click a part, drag it near a compatible snap, then release · ⟲ ⟳ Rotate / ⤵ Flip to align'}
        </div>
      )}
      {mode === 'pin' && (
        <div className="viewport-hint">
          Pin Mode — click a highlighted beam hole to insert a pin · Esc to stop
        </div>
      )}
      {mode === 'joint' && (
        <div className="viewport-hint">
          {jointSource
            ? 'Joint Mode — click a compatible (green) target snap point · Esc to cancel'
            : 'Joint Mode — click a snap point to start a joint'}
        </div>
      )}
      {mode === 'mate' && <MateStepPanel />}
    </div>
  )
}
