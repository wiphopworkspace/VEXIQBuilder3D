import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, TransformControls } from '@react-three/drei'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import {
  buildAllWorldSnapPoints,
  findNearestCompatibleSnap,
  getWorldSnapPoints,
  snapKey,
} from '../utils/snap'
import ScenePart from './ScenePart'
import GuideCoach from './GuideCoach'
import { PART_DND_MIME } from './PartsPanel'

type Placer = (clientX: number, clientY: number) => [number, number, number] | null

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

function Scene() {
  const parts = useAssemblyStore((s) => s.parts)
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const mode = useAssemblyStore((s) => s.mode)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const selectPart = useAssemblyStore((s) => s.selectPart)
  const updateTransform = useAssemblyStore((s) => s.updatePartTransform)
  const trySnap = useAssemblyStore((s) => s.trySnap)
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

  const showGizmo =
    !easyMode &&
    (mode === 'move' || mode === 'rotate') &&
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
        // Drag ended: commit live transform, then let the store snap + connect.
        const pos = selectedObject.position
        const rot = selectedObject.rotation
        updateTransform(selectedId, [pos.x, pos.y, pos.z], [rot.x, rot.y, rot.z])
        trySnap(selectedId)
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
      const dragged = store.parts.find((p) => p.instanceId === selectedId)
      const def = dragged ? getPartDefinition(dragged.partId) : undefined
      if (!dragged || !def) return

      const live = getWorldSnapPoints(dragged, def, selectedObject)
      const others = buildAllWorldSnapPoints(
        store.parts.filter((p) => p.instanceId !== selectedId),
      )
      const occupied = new Set<string>()
      for (const c of store.connections) {
        occupied.add(snapKey(c.aInstanceId, c.aSnapId))
        occupied.add(snapKey(c.bInstanceId, c.bSnapId))
      }
      const result = findNearestCompatibleSnap(selectedId, [...live, ...others], {
        maxDistance: store.snapThreshold,
        occupied,
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
    showGizmo,
    beginHistoryTransaction,
    finishHistoryTransaction,
    mode,
  ])

  return (
    <>
      <color attach="background" args={['#0b0d12']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 8, 5]} intensity={0.8} />
      <directionalLight position={[-5, 4, -3]} intensity={0.3} />

      <Grid
        args={[40, 40]}
        cellSize={0.5}
        cellThickness={0.6}
        cellColor="#2a2f3a"
        sectionSize={2.5}
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
            pinMode={mode === 'pin'}
            onSelect={selectPart}
            groupRef={(obj) => {
              if (obj) groupRefs.current.set(instance.instanceId, obj)
              else groupRefs.current.delete(instance.instanceId)
            }}
          />
        )
      })}

      <SnapPreviewLine groupRefs={groupRefs.current} />

      {showGizmo && selectedObject && (
        <TransformControls
          ref={transformRef}
          object={selectedObject}
          mode={mode === 'rotate' ? 'rotate' : 'translate'}
          size={0.8}
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
  const addPart = useAssemblyStore((s) => s.addPart)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  const placerRef = useRef<Placer | null>(null)
  const [dragOver, setDragOver] = useState(false)

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
    const pos = placerRef.current?.(e.clientX, e.clientY) ?? undefined
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
        <Scene />
      </Canvas>
      <GuideCoach />
      {dragOver && (
        <div className="viewport-drop">Drop to place the part</div>
      )}
      {easyMode && mode === 'select' && (
        <div className="viewport-hint">
          Easy Mode - click a part, drag it near a compatible snap, then release ·
          ⟲ ⟳ Rotate / ⤵ Flip to align (Q / E / F)
        </div>
      )}
      {mode === 'pin' && (
        <div className="viewport-hint">
          Pin Mode — click a highlighted beam hole to insert a pin
        </div>
      )}
      {mode === 'joint' && (
        <div className="viewport-hint">
          {jointSource
            ? 'Joint Mode — click a compatible (green) target snap point · Esc to cancel'
            : 'Joint Mode — click a snap point to start a joint'}
        </div>
      )}
    </div>
  )
}
