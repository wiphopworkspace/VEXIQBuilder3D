import { create } from 'zustand'
import * as THREE from 'three'
import type {
  AssemblySnapshot,
  ConnectionMate,
  EditorMode,
  HistoryEntry,
  JointSource,
  PartInstanceData,
  ProjectFile,
  SnapPreview,
  Vec3,
} from '../types/assembly'
import { getPartDefinition, getDefaultPinPartId } from '../data/parts'
import {
  buildAllWorldSnapPoints,
  buildOccupiedSnapSet,
  computeSnapTransform,
  findNearestCompatibleSnap,
  getWorldSnapPoints,
  pruneBrokenMatesForInstance,
  replaceMateForSnapPoints,
  rotateEulerAroundWorldAxis,
  snapKey,
  typesCompatible,
} from '../utils/snap'
import { getSnapPoints } from '../data/snapOverrides'
import { parseProject, serializeProject } from '../utils/projectIO'

const AUTOSAVE_KEY = 'vex-iq-assembly-autosave'

let instanceCounter = 0
function nextInstanceId(partId: string): string {
  instanceCounter += 1
  return `${partId}-${Date.now().toString(36)}-${instanceCounter}`
}

let mateCounter = 0
function nextMateId(): string {
  mateCounter += 1
  return `mate-${Date.now().toString(36)}-${mateCounter}`
}

/** Set of "instanceId::snapId" keys that are already mated. */
function occupiedSet(
  connections: ConnectionMate[],
  parts: PartInstanceData[],
): Set<string> {
  return buildOccupiedSnapSet(connections, parts)
}

function isPinSideSnap(type: string, snapId: string): boolean {
  return type === 'pin' || type === 'connector' || snapId.startsWith('pin-')
}

function isHoleSnap(type: string): boolean {
  return type === 'hole'
}

function oppositePinSide(snapId: string): string | null {
  if (snapId === 'pin-front') return 'pin-back'
  if (snapId === 'pin-back') return 'pin-front'
  return null
}

function hasMateOnOppositePinSide(
  connections: ConnectionMate[],
  pinInstanceId: string,
  pinSnapId: string,
): boolean {
  const opposite = oppositePinSide(pinSnapId)
  if (!opposite) return false
  return connections.some(
    (c) =>
      (c.aInstanceId === pinInstanceId && c.aSnapId === opposite) ||
      (c.bInstanceId === pinInstanceId && c.bSnapId === opposite),
  )
}

function cloneParts(parts: PartInstanceData[]): PartInstanceData[] {
  return parts.map((p) => ({
    ...p,
    position: [...p.position],
    rotation: [...p.rotation],
    scale: [...p.scale],
    connections: p.connections
      ? p.connections.map((c) => ({ ...c }))
      : undefined,
  }))
}

function cloneConnections(connections: ConnectionMate[]): ConnectionMate[] {
  return connections.map((c) => ({ ...c }))
}

function cloneSnapshot(snapshot: AssemblySnapshot): AssemblySnapshot {
  return {
    projectName: snapshot.projectName,
    parts: cloneParts(snapshot.parts),
    connections: cloneConnections(snapshot.connections),
  }
}

function snapshotFromState(state: {
  projectName: string
  parts: PartInstanceData[]
  connections: ConnectionMate[]
}): AssemblySnapshot {
  return {
    projectName: state.projectName,
    parts: cloneParts(state.parts),
    connections: cloneConnections(state.connections),
  }
}

function snapshotsEqual(a: AssemblySnapshot, b: AssemblySnapshot): boolean {
  return (
    a.projectName === b.projectName &&
    JSON.stringify(a.parts) === JSON.stringify(b.parts) &&
    JSON.stringify(a.connections) === JSON.stringify(b.connections)
  )
}

function historyForChange(
  state: {
    historyPast: HistoryEntry[]
    historyFuture: HistoryEntry[]
    historyTransaction: HistoryEntry | null
  },
  before: AssemblySnapshot,
  after: AssemblySnapshot,
  label: string,
): Pick<AssemblyStore, 'historyPast' | 'historyFuture' | 'historyTransaction'> {
  if (state.historyTransaction || snapshotsEqual(before, after)) {
    return {
      historyPast: state.historyPast,
      historyFuture: state.historyFuture,
      historyTransaction: state.historyTransaction,
    }
  }
  return {
    historyPast: [...state.historyPast, { label, snapshot: cloneSnapshot(before) }],
    historyFuture: [],
    historyTransaction: null,
  }
}

function selectedOrNull(
  selectedInstanceId: string | null,
  parts: PartInstanceData[],
): string | null {
  return selectedInstanceId &&
    parts.some((p) => p.instanceId === selectedInstanceId)
    ? selectedInstanceId
    : null
}

function instanceHasConnections(
  connections: ConnectionMate[],
  instanceId: string,
): boolean {
  return connections.some(
    (c) => c.aInstanceId === instanceId || c.bInstanceId === instanceId,
  )
}

type ActiveJointFrame = {
  pivot: THREE.Vector3
  axis: THREE.Vector3
  localContact: THREE.Vector3
}

function snapContactWorld(snap: ReturnType<typeof getWorldSnapPoints>[number]) {
  if (snap.type === 'hole' || snap.role === 'receive') {
    return snap.worldFacePosition?.clone() ?? snap.worldMatePosition.clone()
  }
  return snap.worldSeatPosition?.clone() ?? snap.worldMatePosition.clone()
}

function resolveSnapPointForInstance(
  parts: PartInstanceData[],
  instanceId: string,
  snapId: string,
) {
  const instance = parts.find((p) => p.instanceId === instanceId)
  const definition = instance ? getPartDefinition(instance.partId) : undefined
  if (!instance || !definition) return null
  const snap =
    getWorldSnapPoints(instance, definition).find((s) => s.id === snapId) ??
    null
  return snap ? { instance, snap } : null
}

function activeJointFrameForInstance(
  parts: PartInstanceData[],
  connections: ConnectionMate[],
  instance: PartInstanceData,
): ActiveJointFrame | null {
  const mate = connections.find(
    (c) =>
      c.aInstanceId === instance.instanceId ||
      c.bInstanceId === instance.instanceId,
  )
  if (!mate) return null

  const ownSnapId =
    mate.aInstanceId === instance.instanceId ? mate.aSnapId : mate.bSnapId
  const otherInstanceId =
    mate.aInstanceId === instance.instanceId ? mate.bInstanceId : mate.aInstanceId
  const otherSnapId =
    mate.aInstanceId === instance.instanceId ? mate.bSnapId : mate.aSnapId
  const own = resolveSnapPointForInstance(parts, instance.instanceId, ownSnapId)
  const other = resolveSnapPointForInstance(parts, otherInstanceId, otherSnapId)
  if (!own) return null

  const pivot = snapContactWorld(own.snap)
  const rawAxis =
    other?.snap.worldMateAxis ??
    own.snap.worldMateAxis ??
    other?.snap.worldAxis ??
    own.snap.worldAxis
  const axis =
    rawAxis && rawAxis.lengthSq() > 1e-10
      ? rawAxis.clone().normalize()
      : new THREE.Vector3(0, 1, 0)
  const origin = new THREE.Vector3(...instance.position)
  const currentQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...instance.rotation),
  )
  const localContact = pivot
    .clone()
    .sub(origin)
    .applyQuaternion(currentQ.clone().invert())

  return { pivot, axis, localContact }
}

function positionForRotationKeepingJoint(
  frame: ActiveJointFrame,
  rotation: Vec3,
): Vec3 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation))
  const offset = frame.localContact.clone().applyQuaternion(q)
  const origin = frame.pivot.clone().sub(offset)
  return [origin.x, origin.y, origin.z]
}

function rotateInstanceAroundJoint(
  instance: PartInstanceData,
  frame: ActiveJointFrame,
  deltaRadians: number,
): { position: Vec3; rotation: Vec3 } {
  const deltaQ = new THREE.Quaternion().setFromAxisAngle(
    frame.axis,
    deltaRadians,
  )
  const currentQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...instance.rotation),
  )
  const nextQ = deltaQ.multiply(currentQ).normalize()
  const nextEuler = new THREE.Euler().setFromQuaternion(nextQ)
  const origin = new THREE.Vector3(...instance.position)
  const nextOrigin = frame.pivot
    .clone()
    .add(origin.sub(frame.pivot).applyQuaternion(deltaQ))
  return {
    position: [nextOrigin.x, nextOrigin.y, nextOrigin.z],
    rotation: [nextEuler.x, nextEuler.y, nextEuler.z],
  }
}

export type AssemblyStore = {
  projectName: string
  parts: PartInstanceData[]
  connections: ConnectionMate[]
  selectedInstanceId: string | null
  // "instanceId::snapId" of the first snap point picked in click-to-snap.
  selectedSnapPointId: string | null
  snapPreview: SnapPreview | null
  mode: EditorMode
  // "Auto Snap": snap-on-drag-release.
  snapEnabled: boolean
  // Distance (world units) within which a compatible pair snaps. Settings slider.
  snapThreshold: number
  // When true, dragging a connected part away beyond threshold breaks the mate.
  breakOnMove: boolean
  // Joint Mode: the first snap point the user picked (source), if any.
  jointSource: JointSource | null
  // Debug toggle: always show snap-point markers.
  showSnapPoints: boolean
  // Developer toggle: snap debug overlay (origin axes + snap id labels) on the
  // selected part. Visual only — never affects snapping or selection bounds.
  snapDebug: boolean
  easyMode: boolean
  selectedPinPartId: string
  statusMessage: string
  // Part ids whose GLB failed to load (so the UI can warn about the fallback).
  glbErrors: Record<string, true>
  historyPast: HistoryEntry[]
  historyFuture: HistoryEntry[]
  historyTransaction: HistoryEntry | null
  jointPositionUnlocked: Record<string, true>

  setProjectName: (name: string) => void
  markGlbError: (partId: string) => void
  addPart: (partId: string, position?: Vec3) => string | null
  selectPart: (instanceId: string | null) => void
  updatePartTransform: (
    instanceId: string,
    position: Vec3,
    rotation: Vec3,
  ) => void
  /** Called after a move/transform ends to apply snapping if enabled. */
  trySnap: (instanceId: string) => void
  setSnapPreview: (preview: SnapPreview | null) => void
  /** Joint Mode: pick a source snap point, then a compatible target to mate. */
  jointPick: (instanceId: string, snapId: string) => void
  /** Reset the Joint Mode source selection (Esc / Cancel). */
  clearJoint: () => void
  deleteSelected: () => void
  duplicateSelected: () => void
  setMode: (mode: EditorMode) => void
  toggleEasyMode: () => void
  toggleSnap: () => void
  setSelectedPinPartId: (partId: string) => void
  setSnapThreshold: (value: number) => void
  toggleBreakOnMove: () => void
  toggleShowSnapPoints: () => void
  toggleSnapDebug: () => void
  setPartColor: (instanceId: string, color: string) => void
  clearProject: () => void
  loadProject: (json: unknown) => void
  exportProject: () => ProjectFile
  insertPinAtSnapPoint: (instanceId: string, snapPointId: string) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  beginHistoryTransaction: (label: string) => void
  finishHistoryTransaction: (label?: string) => void
  commitHistory: (label?: string) => void
  resetTool: () => void
  /**
   * Rotate the selected part `deltaRadians` about a world axis. When Auto Snap
   * is on, it re-snaps afterward so a part rotated near a compatible point drops
   * into place — the whole thing is one undo step.
   */
  rotateSelected: (
    axis: Vec3,
    deltaRadians: number,
    options?: { center?: boolean },
  ) => void
  rotateSelectedY: (deltaRadians: number, options?: { center?: boolean }) => void
  setStatus: (message: string) => void
  isInstanceConnected: (instanceId: string) => boolean
  isJointPositionLocked: (instanceId: string) => boolean
  toggleJointPositionLock: (instanceId: string) => void
  updatePartRotationKeepingJoint: (instanceId: string, rotation: Vec3) => void
}

function persist(
  parts: PartInstanceData[],
  projectName: string,
  connections: ConnectionMate[],
) {
  try {
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify(serializeProject(projectName, parts, connections)),
    )
  } catch {
    // Ignore quota / availability errors — autosave is best-effort.
  }
}

function loadAutosave(): ProjectFile | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (!raw) return null
    return parseProject(JSON.parse(raw))
  } catch {
    return null
  }
}

const autosaved = loadAutosave()

export const useAssemblyStore = create<AssemblyStore>((set, get) => ({
  projectName: autosaved?.projectName ?? 'My Robot',
  parts: autosaved?.parts ?? [],
  connections: autosaved?.connections ?? [],
  selectedInstanceId: null,
  selectedSnapPointId: null,
  snapPreview: null,
  mode: 'select',
  snapEnabled: true,
  snapThreshold: 0.35,
  breakOnMove: true,
  jointSource: null,
  showSnapPoints: false,
  snapDebug: false,
  easyMode: true,
  selectedPinPartId: getDefaultPinPartId(),
  statusMessage: 'Ready',
  glbErrors: {},
  historyPast: [],
  historyFuture: [],
  historyTransaction: null,
  jointPositionUnlocked: {},

  setProjectName: (name) => {
    const state = get()
    const before = snapshotFromState(state)
    const after = { ...before, projectName: name }
    set({
      projectName: name,
      ...historyForChange(state, before, after, 'Rename Project'),
    })
    persist(get().parts, name, get().connections)
  },

  markGlbError: (partId) => {
    if (get().glbErrors[partId]) return
    set({ glbErrors: { ...get().glbErrors, [partId]: true } })
  },

  addPart: (partId, position) => {
    const def = getPartDefinition(partId)
    if (!def) return null
    const state = get()
    const before = snapshotFromState(state)
    const instanceId = nextInstanceId(partId)
    const instance: PartInstanceData = {
      instanceId,
      partId,
      position: position ?? [0, 0.25, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: def.defaultColor,
    }
    const parts = [...state.parts, instance]
    const after = {
      projectName: state.projectName,
      parts,
      connections: state.connections,
    }
    set({
      parts,
      selectedInstanceId: instanceId,
      statusMessage: `Added ${def.name}`,
      ...historyForChange(state, before, after, 'Add Part'),
    })
    persist(parts, state.projectName, state.connections)
    return instanceId
  },

  selectPart: (instanceId) =>
    set({ selectedInstanceId: instanceId, selectedSnapPointId: null }),

  updatePartTransform: (instanceId, position, rotation) => {
    const state = get()
    const current = state.parts.find((p) => p.instanceId === instanceId)
    if (!current) return
    let nextPosition = position
    const locked = get().isJointPositionLocked(instanceId)
    if (locked) {
      const rotationChanged =
        Math.abs(rotation[0] - current.rotation[0]) > 1e-10 ||
        Math.abs(rotation[1] - current.rotation[1]) > 1e-10 ||
        Math.abs(rotation[2] - current.rotation[2]) > 1e-10
      const frame = rotationChanged
        ? activeJointFrameForInstance(state.parts, state.connections, current)
        : null
      nextPosition = frame
        ? positionForRotationKeepingJoint(frame, rotation)
        : current.position
    }
    const parts = state.parts.map((p) =>
      p.instanceId === instanceId
        ? { ...p, position: nextPosition, rotation }
        : p,
    )
    set({ parts })
  },

  trySnap: (instanceId) => {
    const state = get()
    const before = snapshotFromState(state)
    set({ snapPreview: null })
    const dragged = state.parts.find((p) => p.instanceId === instanceId)
    if (!dragged) {
      persist(state.parts, state.projectName, state.connections)
      return
    }

    let parts = state.parts
    let connections = state.connections
    let snapped = false

    // 1. Snap to the nearest compatible point (occupied targets are skipped, so
    //    a second pin can't land in a hole that's already taken). Re-snapping
    //    replaces any mate that reused either snap point — no accumulation.
    if (state.snapEnabled) {
      const all = buildAllWorldSnapPoints(state.parts)
      const result = findNearestCompatibleSnap(instanceId, all, {
        maxDistance: state.snapThreshold,
        occupied: occupiedSet(state.connections, state.parts),
      })
      if (result) {
        const { position, rotation } = computeSnapTransform(
          dragged,
          result.dragged,
          result.target,
          {
            debug: state.snapDebug,
            parts: state.parts,
            connections: state.connections,
          },
        )
        parts = state.parts.map((p) =>
          p.instanceId === instanceId ? { ...p, position, rotation } : p,
        )
        const mate: ConnectionMate = {
          id: nextMateId(),
          aInstanceId: instanceId,
          aSnapId: result.dragged.id,
          bInstanceId: result.target.instanceId,
          bSnapId: result.target.id,
          type: 'snap',
        }
        connections = replaceMateForSnapPoints(connections, mate, parts)
        snapped = true
      }
    }

    // 2. Break mates on the moved part that no longer physically hold (dragged
    //    away from a hole) — only when "break on move" is enabled. The fresh
    //    snap mate has ~0 gap and is kept; this frees a hole once its pin leaves.
    if (state.breakOnMove) {
      connections = pruneBrokenMatesForInstance(
        instanceId,
        parts,
        connections,
        state.snapThreshold,
      )
    }

    let statusMessage = state.statusMessage
    if (snapped) statusMessage = 'Parts snapped together'
    else if (connections.length < state.connections.length)
      statusMessage = 'Connection broken'

    const after = { projectName: state.projectName, parts, connections }
    const jointPositionUnlocked = { ...state.jointPositionUnlocked }
    if (snapped) delete jointPositionUnlocked[instanceId]
    set({
      parts,
      connections,
      jointPositionUnlocked,
      statusMessage,
      ...historyForChange(
        state,
        before,
        after,
        snapped ? 'Snap Parts' : 'Move Part',
      ),
    })
    persist(parts, state.projectName, connections)
  },

  setSnapPreview: (preview) => set({ snapPreview: preview }),

  jointPick: (instanceId, snapId) => {
    const state = get()
    const inst = state.parts.find((p) => p.instanceId === instanceId)
    const def = inst ? getPartDefinition(inst.partId) : undefined
    const sp = def ? getSnapPoints(def).find((s) => s.id === snapId) : undefined
    if (!def || !sp) return

    const source = state.jointSource

    // First pick → this becomes the source snap point.
    if (!source) {
      set({
        jointSource: { instanceId, snapId, type: sp.type },
        statusMessage: 'Select a compatible target snap point.',
      })
      return
    }
    // Clicking the same point again clears the pending selection.
    if (source.instanceId === instanceId && source.snapId === snapId) {
      set({ jointSource: null, statusMessage: 'Joint selection cleared.' })
      return
    }
    // The target must live on a different part.
    if (source.instanceId === instanceId) {
      set({ statusMessage: 'Pick the target snap point on a different part.' })
      return
    }
    // Bidirectional type compatibility.
    if (!typesCompatible(source.type, sp.type)) {
      set({ statusMessage: 'Incompatible snap points.' })
      return
    }
    // Block an occupied target unless its existing mate is this same source↔target.
    const occ = occupiedSet(state.connections, state.parts)
    const targetKey = snapKey(instanceId, snapId)
    const sourceKey = snapKey(source.instanceId, source.snapId)
    if (occ.has(targetKey)) {
      const sameMate = state.connections.some(
        (c) =>
          (snapKey(c.aInstanceId, c.aSnapId) === targetKey &&
            snapKey(c.bInstanceId, c.bSnapId) === sourceKey) ||
          (snapKey(c.bInstanceId, c.bSnapId) === targetKey &&
            snapKey(c.aInstanceId, c.aSnapId) === sourceKey),
      )
      if (!sameMate) {
        set({ statusMessage: 'Target snap point is already occupied.' })
        return
      }
    }

    const before = snapshotFromState(state)
    // Move the source part so its snap point seats onto the (fixed) target.
    const all = buildAllWorldSnapPoints(state.parts)
    const sourceWorld = all.find(
      (s) => s.instanceId === source.instanceId && s.id === source.snapId,
    )
    const targetWorld = all.find(
      (s) => s.instanceId === instanceId && s.id === snapId,
    )
    const sourceInstance = state.parts.find(
      (p) => p.instanceId === source.instanceId,
    )
    const targetInstance = state.parts.find((p) => p.instanceId === instanceId)
    if (!sourceWorld || !targetWorld || !sourceInstance || !targetInstance) {
      set({ jointSource: null })
      return
    }
    const moveTargetOntoInsertedPin =
      isPinSideSnap(sourceWorld.type, sourceWorld.id) &&
      isHoleSnap(targetWorld.type) &&
      hasMateOnOppositePinSide(
        state.connections,
        source.instanceId,
        source.snapId,
      )
    const movingInstance = moveTargetOntoInsertedPin
      ? targetInstance
      : sourceInstance
    const movingSnap = moveTargetOntoInsertedPin ? targetWorld : sourceWorld
    const fixedSnap = moveTargetOntoInsertedPin ? sourceWorld : targetWorld
    const movingInstanceId = movingInstance.instanceId
    const { position, rotation } = computeSnapTransform(
      movingInstance,
      movingSnap,
      fixedSnap,
      {
        debug: state.snapDebug,
        parts: state.parts,
        connections: state.connections,
      },
    )
    const parts = state.parts.map((p) =>
      p.instanceId === movingInstanceId ? { ...p, position, rotation } : p,
    )
    const mate: ConnectionMate = {
      id: nextMateId(),
      aInstanceId: movingSnap.instanceId,
      aSnapId: movingSnap.id,
      bInstanceId: fixedSnap.instanceId,
      bSnapId: fixedSnap.id,
      type: 'snap',
    }
    let connections = replaceMateForSnapPoints(state.connections, mate, parts)
    if (state.breakOnMove) {
      connections = pruneBrokenMatesForInstance(
        movingInstanceId,
        parts,
        connections,
        state.snapThreshold,
      )
    }
    const after = { projectName: state.projectName, parts, connections }
    const jointPositionUnlocked = { ...state.jointPositionUnlocked }
    delete jointPositionUnlocked[movingInstanceId]
    set({
      parts,
      connections,
      jointPositionUnlocked,
      jointSource: null,
      selectedInstanceId: movingInstanceId,
      statusMessage: 'Joint created.',
      ...historyForChange(state, before, after, 'Snap Parts'),
    })
    persist(parts, state.projectName, connections)
  },

  clearJoint: () =>
    set({
      jointSource: null,
      statusMessage: 'Joint Mode: select the first snap point.',
    }),

  deleteSelected: () => {
    const state = get()
    const { selectedInstanceId, parts, projectName, connections } = state
    if (!selectedInstanceId) return
    const before = snapshotFromState(state)
    const next = parts.filter((p) => p.instanceId !== selectedInstanceId)
    // Drop any connections that referenced the deleted part.
    const nextConnections = connections.filter(
      (c) =>
        c.aInstanceId !== selectedInstanceId &&
        c.bInstanceId !== selectedInstanceId,
    )
    const jointPositionUnlocked = { ...state.jointPositionUnlocked }
    delete jointPositionUnlocked[selectedInstanceId]
    set({
      parts: next,
      connections: nextConnections,
      jointPositionUnlocked,
      selectedInstanceId: null,
      selectedSnapPointId: null,
      statusMessage: 'Deleted part',
      ...historyForChange(
        state,
        before,
        { projectName, parts: next, connections: nextConnections },
        'Delete Part',
      ),
    })
    persist(next, projectName, nextConnections)
  },

  duplicateSelected: () => {
    const state = get()
    const { selectedInstanceId, parts, projectName, connections } = state
    if (!selectedInstanceId) return
    const original = parts.find((p) => p.instanceId === selectedInstanceId)
    if (!original) return
    const before = snapshotFromState(state)
    const instanceId = nextInstanceId(original.partId)
    // A duplicate starts unconnected (we don't copy mates for a single part).
    const copy: PartInstanceData = {
      ...original,
      instanceId,
      connections: undefined,
      position: [
        original.position[0] + 0.4,
        original.position[1],
        original.position[2] + 0.4,
      ],
    }
    const next = [...parts, copy]
    set({
      parts: next,
      selectedInstanceId: instanceId,
      statusMessage: 'Duplicated part',
      ...historyForChange(
        state,
        before,
        { projectName, parts: next, connections },
        'Duplicate Part',
      ),
    })
    persist(next, projectName, connections)
  },

  setMode: (mode) => {
    const state = get()
    const selectedConnected =
      !!state.selectedInstanceId &&
      instanceHasConnections(state.connections, state.selectedInstanceId)
    const selectedLocked =
      selectedConnected &&
      !!state.selectedInstanceId &&
      !state.jointPositionUnlocked[state.selectedInstanceId]
    const helper =
      mode === 'pin'
        ? 'Pin Mode: choose a pin type, then click a highlighted beam hole'
        : mode === 'joint'
          ? 'Joint Mode: select the first snap point.'
          : mode === 'move'
            ? selectedLocked
              ? 'Part is locked by a joint. Right-click to unlock position.'
              : 'Move Mode: drag the gizmo to move the part'
            : mode === 'rotate'
              ? selectedConnected
                ? 'Rotate Mode: connected parts rotate around their joint.'
                : 'Rotate Mode: drag the ring to rotate the part'
              : 'Select Mode: click a part to select it'
    set({
      mode,
      statusMessage: helper,
      selectedSnapPointId: null,
      jointSource: null,
    })
  },

  toggleEasyMode: () => {
    const easyMode = !get().easyMode
    set({
      easyMode,
      mode: easyMode ? 'select' : get().mode,
      statusMessage: easyMode
        ? 'Easy Assembly Mode on: click, drag, and release near holes to snap'
        : 'Advanced tools enabled',
    })
  },

  toggleSnap: () => {
    const snapEnabled = !get().snapEnabled
    set({
      snapEnabled,
      statusMessage: snapEnabled ? 'Auto Snap on' : 'Auto Snap off',
    })
  },

  setSelectedPinPartId: (partId) => {
    const def = getPartDefinition(partId)
    if (!def) {
      set({ statusMessage: 'Selected pin type is not available in the parts library.' })
      return
    }
    set({
      selectedPinPartId: partId,
      statusMessage: `Pin Mode pin: ${def.name}`,
    })
  },

  setSnapThreshold: (value) => {
    const snapThreshold = Math.min(1, Math.max(0.1, value))
    set({ snapThreshold })
  },

  toggleBreakOnMove: () => {
    const breakOnMove = !get().breakOnMove
    set({
      breakOnMove,
      statusMessage: breakOnMove
        ? 'Connections break when a part is moved away'
        : 'Connections persist when a part is moved',
    })
  },

  toggleShowSnapPoints: () => {
    const showSnapPoints = !get().showSnapPoints
    set({
      showSnapPoints,
      statusMessage: showSnapPoints ? 'Showing snap points' : 'Hiding snap points',
    })
  },

  toggleSnapDebug: () => {
    const snapDebug = !get().snapDebug
    set({
      snapDebug,
      statusMessage: snapDebug ? 'Snap debug on' : 'Snap debug off',
    })
  },

  setPartColor: (instanceId, color) => {
    const state = get()
    const before = snapshotFromState(state)
    const parts = state.parts.map((p) =>
      p.instanceId === instanceId ? { ...p, color } : p,
    )
    set({
      parts,
      ...historyForChange(
        state,
        before,
        {
          projectName: state.projectName,
          parts,
          connections: state.connections,
        },
        'Change Color',
      ),
    })
    persist(parts, state.projectName, state.connections)
  },

  clearProject: () => {
    const state = get()
    const before = snapshotFromState(state)
    const after = { projectName: 'My Robot', parts: [], connections: [] }
    set({
      parts: [],
      connections: [],
      selectedInstanceId: null,
      selectedSnapPointId: null,
      jointSource: null,
      snapPreview: null,
      jointPositionUnlocked: {},
      projectName: 'My Robot',
      statusMessage: 'New project',
      ...historyForChange(state, before, after, 'Clear Project'),
    })
    persist([], 'My Robot', [])
  },

  loadProject: (json) => {
    const project = parseProject(json)
    set({
      projectName: project.projectName,
      parts: project.parts,
      connections: project.connections,
      selectedInstanceId: null,
      selectedSnapPointId: null,
      jointSource: null,
      snapPreview: null,
      jointPositionUnlocked: {},
      statusMessage: `Loaded "${project.projectName}" (history cleared)`,
      historyPast: [],
      historyFuture: [],
      historyTransaction: null,
    })
    persist(project.parts, project.projectName, project.connections)
  },

  exportProject: () => {
    const { projectName, parts, connections } = get()
    return serializeProject(projectName, parts, connections)
  },

  insertPinAtSnapPoint: (instanceId, snapPointId) => {
    const state = get()
    const before = snapshotFromState(state)
    const target = state.parts.find((p) => p.instanceId === instanceId)
    if (!target) return
    const targetDef = getPartDefinition(target.partId)
    if (!targetDef) return

    // Prevent stacking pins into an already-mated hole.
    if (
      occupiedSet(state.connections, state.parts).has(
        snapKey(instanceId, snapPointId),
      )
    ) {
      set({ statusMessage: 'That hole is already occupied' })
      return
    }

    // Use the selected Pin Mode part. It still goes through the shared
    // computeSnapTransform path, so Auto Snap / Joint Mode / Pin Mode agree.
    const pinPartId = state.selectedPinPartId || getDefaultPinPartId()
    const pinDef = getPartDefinition(pinPartId)
    if (!pinDef) {
      set({ statusMessage: 'Selected pin type is not available in the parts library.' })
      return
    }
    const pinInstanceId = nextInstanceId(pinPartId)

    // Use the EXACT same snapping pipeline as Auto Snap / Joint Mode: build the
    // pin's world snap points at its initial transform, pick its seated shoulder
    // snap, and run computeSnapTransform so the pin's mate frame — not its
    // geometric center — lands on the hole face with orientation aligned.
    const pin0: PartInstanceData = {
      instanceId: pinInstanceId,
      partId: pinPartId,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: pinDef.defaultColor,
    }
    const pinSnaps = getWorldSnapPoints(pin0, pinDef)
    const pinSnap =
      pinSnaps.find((s) => s.role === 'shoulder' && s.id === 'pin-front') ??
      pinSnaps.find((s) => s.id === 'pin-front') ??
      pinSnaps.find((s) => s.role === 'shoulder') ??
      pinSnaps.find((s) => s.id === 'pin-center') ??
      pinSnaps.find((s) => s.type === 'pin') ??
      pinSnaps[0]
    const holeSnap = getWorldSnapPoints(target, targetDef).find(
      (s) => s.id === snapPointId,
    )
    if (!pinSnap || !holeSnap) return

    const { position, rotation } = computeSnapTransform(
      pin0,
      pinSnap,
      holeSnap,
      {
        debug: state.snapDebug,
        parts: state.parts,
        connections: state.connections,
      },
    )
    const pin: PartInstanceData = { ...pin0, position, rotation }
    const mate: ConnectionMate = {
      id: nextMateId(),
      aInstanceId: pinInstanceId,
      aSnapId: pinSnap.id,
      bInstanceId: instanceId,
      bSnapId: snapPointId,
      type: 'snap',
    }
    const parts = [...state.parts, pin]
    const connections = replaceMateForSnapPoints(state.connections, mate, parts)
    const jointPositionUnlocked = { ...state.jointPositionUnlocked }
    delete jointPositionUnlocked[pinInstanceId]
    set({
      parts,
      connections,
      jointPositionUnlocked,
      selectedInstanceId: pinInstanceId,
      statusMessage: `${pinDef.name} inserted into hole`,
      ...historyForChange(
        state,
        before,
        { projectName: state.projectName, parts, connections },
        'Insert Pin',
      ),
    })
    persist(parts, state.projectName, connections)
  },

  undo: () => {
    const state = get()
    const entry = state.historyPast[state.historyPast.length - 1]
    if (!entry) return
    const current = snapshotFromState(state)
    const nextPast = state.historyPast.slice(0, -1)
    const nextFuture = [
      ...state.historyFuture,
      { label: entry.label, snapshot: current },
    ]
    const snapshot = cloneSnapshot(entry.snapshot)
    set({
      projectName: snapshot.projectName,
      parts: snapshot.parts,
      connections: snapshot.connections,
      selectedInstanceId: selectedOrNull(
        state.selectedInstanceId,
        snapshot.parts,
      ),
      selectedSnapPointId: null,
      jointSource: null,
      snapPreview: null,
      historyPast: nextPast,
      historyFuture: nextFuture,
      historyTransaction: null,
      statusMessage: `Undo: ${entry.label}`,
    })
    persist(snapshot.parts, snapshot.projectName, snapshot.connections)
  },

  redo: () => {
    const state = get()
    const entry = state.historyFuture[state.historyFuture.length - 1]
    if (!entry) return
    const current = snapshotFromState(state)
    const nextFuture = state.historyFuture.slice(0, -1)
    const snapshot = cloneSnapshot(entry.snapshot)
    set({
      projectName: snapshot.projectName,
      parts: snapshot.parts,
      connections: snapshot.connections,
      selectedInstanceId: selectedOrNull(
        state.selectedInstanceId,
        snapshot.parts,
      ),
      selectedSnapPointId: null,
      jointSource: null,
      snapPreview: null,
      historyPast: [
        ...state.historyPast,
        { label: entry.label, snapshot: current },
      ],
      historyFuture: nextFuture,
      historyTransaction: null,
      statusMessage: `Redo: ${entry.label}`,
    })
    persist(snapshot.parts, snapshot.projectName, snapshot.connections)
  },

  canUndo: () => get().historyPast.length > 0,

  canRedo: () => get().historyFuture.length > 0,

  beginHistoryTransaction: (label) => {
    const state = get()
    if (state.historyTransaction) return
    set({
      historyTransaction: {
        label,
        snapshot: snapshotFromState(state),
      },
    })
  },

  finishHistoryTransaction: (label) => {
    const state = get()
    const transaction = state.historyTransaction
    if (!transaction) return
    const after = snapshotFromState(state)
    if (snapshotsEqual(transaction.snapshot, after)) {
      set({ historyTransaction: null })
      return
    }
    set({
      historyPast: [
        ...state.historyPast,
        {
          label: label ?? transaction.label,
          snapshot: cloneSnapshot(transaction.snapshot),
        },
      ],
      historyFuture: [],
      historyTransaction: null,
    })
  },

  commitHistory: (label) => {
    get().finishHistoryTransaction(label)
  },

  resetTool: () => {
    set({
      selectedInstanceId: null,
      jointSource: null,
      snapPreview: null,
      selectedSnapPointId: null,
      mode: 'select',
      statusMessage: 'Selection cleared',
    })
  },

  rotateSelected: (axis, deltaRadians, options) => {
    const state = get()
    const id = state.selectedInstanceId
    if (!id) return
    const target = state.parts.find((p) => p.instanceId === id)
    if (!target) return

    // Group the rotation and any follow-on re-snap into one undo step.
    get().beginHistoryTransaction('Rotate Part')
    const jointFrame = options?.center
      ? null
      : activeJointFrameForInstance(state.parts, state.connections, target)
    const transform = jointFrame
      ? rotateInstanceAroundJoint(target, jointFrame, deltaRadians)
      : {
          position: target.position,
          rotation: rotateEulerAroundWorldAxis(
            target.rotation,
            axis,
            deltaRadians,
          ),
        }
    const rotated = state.parts.map((p) =>
      p.instanceId === id ? { ...p, ...transform } : p,
    )
    set({
      parts: rotated,
      statusMessage: jointFrame
        ? 'Rotated selected part around its joint'
        : 'Rotated selected part',
    })

    // Unconnected rotations can still Auto Snap into a nearby target. Connected
    // rotations keep the mate position fixed and must not prune the joint.
    if (!jointFrame && get().snapEnabled) {
      get().trySnap(id)
    }
    get().finishHistoryTransaction('Rotate Part')
    persist(get().parts, get().projectName, get().connections)
  },

  rotateSelectedY: (deltaRadians, options) => {
    get().rotateSelected([0, 1, 0], deltaRadians, options)
  },

  setStatus: (message) => set({ statusMessage: message }),

  isInstanceConnected: (instanceId) =>
    instanceHasConnections(get().connections, instanceId),

  isJointPositionLocked: (instanceId) =>
    instanceHasConnections(get().connections, instanceId) &&
    !get().jointPositionUnlocked[instanceId],

  toggleJointPositionLock: (instanceId) => {
    const state = get()
    if (!instanceHasConnections(state.connections, instanceId)) {
      set({ statusMessage: 'Only connected parts can be locked or unlocked.' })
      return
    }
    const unlocked = { ...state.jointPositionUnlocked }
    if (unlocked[instanceId]) {
      delete unlocked[instanceId]
      set({
        jointPositionUnlocked: unlocked,
        selectedInstanceId: instanceId,
        statusMessage: 'Joint position locked. Part can rotate around the pin.',
      })
    } else {
      unlocked[instanceId] = true
      set({
        jointPositionUnlocked: unlocked,
        selectedInstanceId: instanceId,
        statusMessage: 'Joint position unlocked. Drag to move or right-click to lock again.',
      })
    }
  },

  updatePartRotationKeepingJoint: (instanceId, rotation) => {
    const state = get()
    const instance = state.parts.find((p) => p.instanceId === instanceId)
    if (!instance) return
    const jointFrame = activeJointFrameForInstance(
      state.parts,
      state.connections,
      instance,
    )
    const position = jointFrame
      ? positionForRotationKeepingJoint(jointFrame, rotation)
      : instance.position
    const parts = state.parts.map((p) =>
      p.instanceId === instanceId ? { ...p, position, rotation } : p,
    )
    set({
      parts,
      statusMessage: jointFrame
        ? 'Rotating around joint'
        : 'Rotated selected part',
    })
  },
}))
