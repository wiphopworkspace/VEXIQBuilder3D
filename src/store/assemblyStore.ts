import { create } from 'zustand'
import * as THREE from 'three'
import type {
  AssemblySnapshot,
  ConnectionMate,
  EditorMode,
  HistoryEntry,
  JointKind,
  JointSource,
  PartInstanceData,
  ProjectFile,
  SnapPreview,
  Vec3,
} from '../types/assembly'
import type { FastenedMateParams, MateConnector, MatePick } from '../types/mate'
import {
  computeFastenedMateTransform,
  connectorProjectRef,
  findConnector,
  resolveConnectorRef,
} from '../utils/mateConnectors'
import { DEFAULT_FASTENED_MATE_PARAMS } from '../types/mate'
import { getPartDefinition, getDefaultPinPartId } from '../data/parts'
import {
  buildAllWorldSnapPoints,
  buildOccupiedSnapSet,
  computeSnapTransform,
  findNearestCompatibleSnap,
  getWorldSnapPoints,
  mateWorldGap,
  pruneBrokenMatesForInstance,
  replaceMateForSnapPoints,
  rotateEulerAroundWorldAxis,
  shaftMateKind,
  snapKey,
  typesCompatible,
  worldSnapContactPosition,
} from '../utils/snap'
import { getSnapPoints } from '../data/snapOverrides'
import {
  getAuthoredSnapOverride,
  setAuthoredSnapOverride,
  clearAuthoredSnapOverride,
  stripResolutionFields,
  dominantAxis,
  roundCoord,
  uniqueSnapId,
  withDerivedFrames,
} from '../data/authoredSnapOverrides'
import { SNAP_CALIBRATION } from '../data/snapCalibration'
import { matchPinProfile } from '../data/pinProfiles'
import type { SnapPointDefinition } from '../types/assembly'
import {
  parseProject,
  serializeProject,
  type ProjectParseInfo,
} from '../utils/projectIO'
import {
  buildClipboard,
  instantiateClipboard,
  type AssemblyClipboard,
} from '../utils/copyPaste'

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

// Classroom-readable snap status: shaft-family mates say what the connection
// DOES mechanically; everything else keeps the classic message.
function snapStatusForShaftKind(
  kind: ReturnType<typeof shaftMateKind>,
): string {
  switch (kind) {
    case 'motor-drive':
      return 'Shaft seated in motor — motor-driven'
    case 'rotation-locked':
      return 'Parts snapped together — rotation locked to shaft'
    case 'free-spinning':
      return 'Shaft passes through — spins freely'
    default:
      return 'Parts snapped together'
  }
}

/** Set of "instanceId::snapId" keys that are already mated. */
function occupiedSet(
  connections: ConnectionMate[],
  parts: PartInstanceData[],
): Set<string> {
  return buildOccupiedSnapSet(connections, parts)
}

/**
 * A part mated to any THIRD part is anchored in the assembly: re-seating it
 * from a single new snap pair would teleport it off its other joints. Mates to
 * the counterpart itself don't anchor — re-mating the same two parts is a
 * legitimate re-seat. (Generalizes the old pin-only rule that a pin mated at
 * another seat is anchored and the beam moves onto it.)
 */
function anchoredElsewhere(
  connections: ConnectionMate[],
  instanceId: string,
  counterpartId: string,
): boolean {
  return connections.some((c) => {
    const other =
      c.aInstanceId === instanceId
        ? c.bInstanceId
        : c.bInstanceId === instanceId
          ? c.aInstanceId
          : null
    return other !== null && other !== counterpartId
  })
}

/**
 * How far apart two picked CONTACT frames may be for Joint Mode to record the
 * mate WITHOUT moving either part (join-in-place). This is a NARROW safety
 * fallback: it fires only when both parts are anchored AND both simulated
 * candidate moves would disturb an existing mate beyond
 * JOINT_EXISTING_MATE_MAX_ERROR — the normal workhorse for aligned pattern
 * joints is the non-destructive simulated move below, which usually succeeds
 * because re-seating an already-aligned part is a no-op. Big enough to absorb
 * small metadata drift on approximate layouts (~0.01–0.06 measured on
 * electronics/corner tables), far below a real half-pitch mismatch (0.25).
 * The gap is measured between CONTACT positions (seat/receiving planes), never
 * between visual markers — a deep socket's marker sits at the mouth, ~0.23
 * away from where a correctly seated shaft actually contacts.
 */
const JOIN_IN_PLACE_TOLERANCE = 0.12

/**
 * Strict Joint Mode preservation tolerance: when a joint pick simulates moving
 * a part that already has mates, every preserved mate must still measure
 * within this contact-frame error afterwards, or the candidate move is not
 * applied. DELIBERATELY independent from the user snap-distance slider
 * (`snapThreshold`, default 0.35) and from the drag-release stale-mate prune:
 * those answer "has this mate physically broken?", which tolerates a pin
 * dragged a quarter-hole sideways; this answers "may Joint Mode itself bend an
 * assembly?", where a 0.25 stretch (one beam thickness — the classic far-face
 * mis-pick) must be refused, not stored. 0.12 sits above real calibrated seat
 * gaps (≤ ~0.03 incl. clearance corrections) and below every physical
 * mismatch step (0.25 face flip, 0.5 hole pitch).
 */
const JOINT_EXISTING_MATE_MAX_ERROR = 0.12

/**
 * Worst contact-frame error over the mates that a candidate joint move must
 * PRESERVE: all mates involving the moved instance except those the new mate
 * would replace (same endpoint or same occupancy group — the exact
 * `replaceMateForSnapPoints` semantics, reused so re-seating a pair never
 * counts its own predecessor as damage). Measures the mates' actual simulated
 * geometry via `mateWorldGap` (contact positions), not prune survival — a
 * mate can survive the loose prune threshold while geometrically stretched.
 */
function maxPreservedMateError(
  movingInstanceId: string,
  simulatedParts: PartInstanceData[],
  connections: ConnectionMate[],
  candidate: Pick<
    ConnectionMate,
    'aInstanceId' | 'aSnapId' | 'bInstanceId' | 'bSnapId'
  >,
  parts: PartInstanceData[],
): number {
  const probe: ConnectionMate = {
    id: '__joint-candidate-probe__',
    type: 'snap',
    ...candidate,
  }
  const preserved = replaceMateForSnapPoints(connections, probe, parts).filter(
    (c) => c.id !== probe.id,
  )
  let worst = 0
  for (const mate of preserved) {
    if (
      mate.aInstanceId !== movingInstanceId &&
      mate.bInstanceId !== movingInstanceId
    ) {
      continue
    }
    const gap = mateWorldGap(mate, simulatedParts)
    if (gap !== null && gap > worst) worst = gap
  }
  return worst
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
  return connections.map((c) => JSON.parse(JSON.stringify(c)) as ConnectionMate)
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

function resolveConnectorForMateEndpoint(
  parts: PartInstanceData[],
  mate: ConnectionMate,
  side: 'a' | 'b',
): MateConnector | null {
  const instanceId = side === 'a' ? mate.aInstanceId : mate.bInstanceId
  const snapId = side === 'a' ? mate.aSnapId : mate.bSnapId
  const ref = side === 'a' ? mate.aConnectorRef : mate.bConnectorRef
  const instance = parts.find((p) => p.instanceId === instanceId)
  const definition = instance ? getPartDefinition(instance.partId) : undefined
  if (!instance || !definition) return null
  const fromRef = resolveConnectorRef(instance, definition, ref)
  if (fromRef) return fromRef
  return findConnector(instance, definition, snapId)
}

function activeJointFrameForInstance(
  parts: PartInstanceData[],
  connections: ConnectionMate[],
  instance: PartInstanceData,
  preferredMateId?: string,
): ActiveJointFrame | null {
  const ownMates = connections.filter(
    (c) =>
      c.aInstanceId === instance.instanceId ||
      c.bInstanceId === instance.instanceId,
  )
  // Honor the user's chosen active mate when the part has several; otherwise
  // fall back to the first mate involving this part.
  const mate =
    (preferredMateId && ownMates.find((c) => c.id === preferredMateId)) ||
    ownMates[0]
  if (!mate) return null

  const ownSide = mate.aInstanceId === instance.instanceId ? 'a' : 'b'
  const otherSide = ownSide === 'a' ? 'b' : 'a'
  const ownConnector = resolveConnectorForMateEndpoint(parts, mate, ownSide)
  const otherConnector = resolveConnectorForMateEndpoint(parts, mate, otherSide)
  const ownSnapId = ownSide === 'a' ? mate.aSnapId : mate.bSnapId
  const otherInstanceId = ownSide === 'a' ? mate.bInstanceId : mate.aInstanceId
  const otherSnapId = ownSide === 'a' ? mate.bSnapId : mate.aSnapId
  const own = ownConnector
    ? null
    : resolveSnapPointForInstance(parts, instance.instanceId, ownSnapId)
  const other = otherConnector
    ? null
    : resolveSnapPointForInstance(parts, otherInstanceId, otherSnapId)
  if (!ownConnector && !own) return null

  const pivot = ownConnector
    ? new THREE.Vector3(...ownConnector.origin)
    : snapContactWorld(own!.snap)
  const rawAxis =
    (otherConnector ? new THREE.Vector3(...otherConnector.axisZ) : null) ??
    (ownConnector ? new THREE.Vector3(...ownConnector.axisZ) : null) ??
    other?.snap.worldMateAxis ??
    own?.snap.worldMateAxis ??
    other?.snap.worldAxis ??
    own?.snap.worldAxis
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
  /**
   * SECONDARY selections (Shift/Ctrl+click), never including the primary
   * `selectedInstanceId`. Copy operates on the whole set; everything else in
   * the app (gizmos, Properties, Joint/Pin mode, rotate, nudge) continues to
   * act on the primary alone.
   */
  multiSelectIds: string[]
  /**
   * The primary this secondary set was formed against. When any other action
   * moves the primary (add part, delete, undo, load, pin insert, joint pick,
   * …), the anchor no longer matches and `getSelectionIds` collapses back to
   * single-select automatically — so no existing selection code path has to
   * know multi-select exists, and a stale multi-selection cannot survive.
   */
  multiSelectAnchor: string | null
  // "instanceId::snapId" of the first snap point picked in click-to-snap.
  selectedSnapPointId: string | null
  snapPreview: SnapPreview | null
  mode: EditorMode
  // "Auto Snap": snap-on-drag-release.
  snapEnabled: boolean
  // Distance (world units) within which a compatible pair snaps. Settings slider.
  snapThreshold: number
  // Grid move snapping (CAD-style): dragged parts move on a fixed world-unit
  // grid (0 = free). 0.25 = half a hole pitch — RoboStem's "Normal 8 LDU"
  // equivalent — and matches the y=0.25 resting height, so all three axes stay
  // on-grid. Applies to the Basic-Mode plane drag, the Advanced move gizmo,
  // and drag-to-place; final seating on release still comes from
  // computeSnapTransform, which overrides the grid.
  moveStep: number
  // Rotation snapping for the Advanced rotate gizmo, in degrees (0 = free).
  rotationStepDeg: number
  // When true, dragging a connected part away beyond threshold breaks the mate.
  breakOnMove: boolean
  // Joint Mode: the first snap point the user picked (source), if any.
  jointSource: JointSource | null
  // Debug toggle: always show snap-point markers.
  showSnapPoints: boolean
  // When false, the selected part stops auto-showing its snap markers during
  // Auto Snap assembly, so the marker field doesn't block the view while you
  // check alignment. Pin/Joint mode and "Show snap points" still show markers.
  showMarkersWhileMoving: boolean
  // Developer toggle: snap debug overlay (origin axes + snap id labels) on the
  // selected part. Visual only — never affects snapping or selection bounds.
  snapDebug: boolean
  easyMode: boolean
  selectedPinPartId: string
  statusMessage: string
  // Part ids whose GLB failed to load (so the UI can warn about the fallback).
  glbErrors: Record<string, true>
  /**
   * Internal (application, not OS) clipboard. Deliberately OUTSIDE undo
   * history and outside the project file: copying is not an edit, and a
   * clipboard is a session tool, not part of the saved assembly.
   */
  clipboard: AssemblyClipboard | null
  /** Pastes since the last copy — drives the accumulating paste offset. */
  pasteCount: number
  historyPast: HistoryEntry[]
  historyFuture: HistoryEntry[]
  historyTransaction: HistoryEntry | null
  jointPositionUnlocked: Record<string, true>
  // Advanced Mate Connector Tool: picked source/target connectors.
  mateSource: MatePick | null
  mateTarget: MatePick | null
  // Original transform of the moving part, captured when the Mate Editor opens
  // so Cancel can restore it (preview must not corrupt project state).
  mateOriginalTransform: { position: Vec3; rotation: Vec3 } | null
  // Per-instance chosen active mate (for rotate-around-joint when >1 mate).
  activeMateId: Record<string, string>
  // Existing mate being edited in the Mate Editor, if any.
  mateEditingMateId: string | null
  mateInitialParams: FastenedMateParams | null
  mateInitialKind: JointKind | null
  // Visual Snap Authoring Tool (Advanced Mode). The authored data itself lives
  // in `data/authoredSnapOverrides.ts` (localStorage, outside undo history);
  // the version counter re-renders every snap-point consumer after an edit.
  snapAuthoring: boolean
  snapAuthoringVersion: number
  authoringSelectedSnapId: string | null
  // Armed by the panel: the next click on the selected part's surface adds a
  // snap point at the hit position.
  authoringSurfacePick: boolean

  setProjectName: (name: string) => void
  markGlbError: (partId: string) => void
  addPart: (partId: string, position?: Vec3) => string | null
  selectPart: (instanceId: string | null) => void
  /** Shift/Ctrl+click: add an unselected part to the selection, or drop it. */
  toggleSelectPart: (instanceId: string) => void
  /** Every currently selected instance id (primary first). Always valid. */
  getSelectionIds: () => string[]
  /** Snapshot the selection into the internal clipboard. Never mutates. */
  copySelection: () => void
  /** Instantiate the clipboard as new parts/mates. One undo step. */
  pasteClipboard: () => void
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
  setMoveStep: (value: number) => void
  setRotationStepDeg: (value: number) => void
  toggleBreakOnMove: () => void
  toggleShowSnapPoints: () => void
  toggleMarkersWhileMoving: () => void
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
  /**
   * Move the selected part by a world-space delta (arrow-key nudge). One undo
   * step per call. Deliberately does NOT auto-snap — nudging is for precise
   * placement, and re-snapping would yank the part straight back. Stale mates
   * still break (breakOnMove) so nudging a pin out of a hole frees the hole.
   */
  nudgeSelected: (delta: Vec3) => void
  setStatus: (message: string) => void
  isInstanceConnected: (instanceId: string) => boolean
  isJointPositionLocked: (instanceId: string) => boolean
  toggleJointPositionLock: (instanceId: string) => void
  updatePartRotationKeepingJoint: (instanceId: string, rotation: Vec3) => void
  // Advanced Mate Connector workflow.
  pickMateConnector: (instanceId: string, connector: MateConnector) => void
  updateMateConnectorPick: (
    endpoint: 'source' | 'target',
    connector: MateConnector,
  ) => void
  editMate: (mateId: string, movingInstanceId?: string) => void
  clearMate: () => void
  previewFastenedMate: (params: FastenedMateParams) => void
  restoreMatePreview: () => void
  /** Spin a part about its (revolute) joint axis by deltaRadians. Transient —
   * the caller wraps a drag in begin/finish history transaction. */
  rotateAroundJointLive: (instanceId: string, deltaRadians: number) => void
  applyFastenedMate: (params: FastenedMateParams, mateType?: JointKind) => void
  cancelMate: () => void
  setActiveMate: (instanceId: string, mateId: string) => void
  // Visual Snap Authoring Tool.
  toggleSnapAuthoring: () => void
  setAuthoringSelectedSnapId: (snapId: string | null) => void
  setAuthoringSurfacePick: (armed: boolean) => void
  /** Write a part's authored snap set (empty array clears it) and re-render. */
  setAuthoredSnapPointsForPart: (
    partId: string,
    snaps: SnapPointDefinition[],
    status?: string,
  ) => void
  clearAuthoredSnapPointsForPart: (partId: string) => void
  /** Surface pick: add an authored point at a world-space hit on an instance. */
  addAuthoredPointFromWorldHit: (
    instanceId: string,
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
  ) => void
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
  multiSelectIds: [],
  multiSelectAnchor: null,
  clipboard: null,
  pasteCount: 0,
  selectedSnapPointId: null,
  snapPreview: null,
  mode: 'select',
  snapEnabled: true,
  snapThreshold: 0.35,
  moveStep: 0.25,
  rotationStepDeg: 15,
  breakOnMove: true,
  jointSource: null,
  showSnapPoints: false,
  showMarkersWhileMoving: true,
  snapDebug: false,
  easyMode: true,
  selectedPinPartId: getDefaultPinPartId(),
  statusMessage: 'Ready',
  glbErrors: {},
  historyPast: [],
  historyFuture: [],
  historyTransaction: null,
  jointPositionUnlocked: {},
  mateSource: null,
  mateTarget: null,
  mateOriginalTransform: null,
  activeMateId: {},
  mateEditingMateId: null,
  mateInitialParams: null,
  mateInitialKind: null,
  snapAuthoring: false,
  snapAuthoringVersion: 0,
  authoringSelectedSnapId: null,
  authoringSurfacePick: false,

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
    set({
      selectedInstanceId: instanceId,
      selectedSnapPointId: null,
      // A plain click always replaces the selection.
      multiSelectIds: [],
      multiSelectAnchor: null,
    }),

  toggleSelectPart: (instanceId) => {
    const state = get()
    if (!state.parts.some((p) => p.instanceId === instanceId)) return
    const current = get().getSelectionIds()
    if (current.includes(instanceId)) {
      // Deselect it. The primary role passes to whatever is left.
      const rest = current.filter((id) => id !== instanceId)
      const primary = rest[rest.length - 1] ?? null
      set({
        selectedInstanceId: primary,
        multiSelectIds: primary ? rest.filter((id) => id !== primary) : [],
        multiSelectAnchor: primary,
        selectedSnapPointId: null,
        statusMessage: primary
          ? `${rest.length} part${rest.length === 1 ? '' : 's'} selected`
          : 'Selection cleared',
      })
      return
    }
    // Add it and make it the primary, so the gizmo/Properties follow the part
    // the user just clicked.
    const next = [...current, instanceId]
    set({
      selectedInstanceId: instanceId,
      multiSelectIds: current,
      multiSelectAnchor: instanceId,
      selectedSnapPointId: null,
      statusMessage: `${next.length} parts selected`,
    })
  },

  getSelectionIds: () => {
    const { selectedInstanceId, multiSelectIds, multiSelectAnchor, parts } =
      get()
    if (!selectedInstanceId) return []
    const exists = (id: string) => parts.some((p) => p.instanceId === id)
    if (!exists(selectedInstanceId)) return []
    // The secondary set is only live while the primary is the one it was
    // formed against (see multiSelectAnchor). Any other action that changes
    // the primary silently collapses the selection back to that part alone.
    if (multiSelectAnchor !== selectedInstanceId) return [selectedInstanceId]
    return [
      selectedInstanceId,
      ...multiSelectIds.filter((id) => id !== selectedInstanceId && exists(id)),
    ]
  },

  copySelection: () => {
    const state = get()
    const ids = get().getSelectionIds()
    const clipboard = buildClipboard(state.parts, state.connections, ids)
    if (!clipboard) {
      // Non-destructive: keep any previous clipboard, touch nothing else.
      set({ statusMessage: 'Nothing selected to copy.' })
      return
    }
    const partCount = clipboard.parts.length
    const mateCount = clipboard.mates.length
    // NOTE: no history entry — copying is not an edit. Also no `parts` /
    // `connections` write, so the scene is byte-identical afterwards.
    set({
      clipboard,
      pasteCount: 0,
      statusMessage:
        `Copied ${partCount} part${partCount === 1 ? '' : 's'}` +
        (mateCount > 0
          ? ` and ${mateCount} connection${mateCount === 1 ? '' : 's'}.`
          : '.'),
    })
  },

  pasteClipboard: () => {
    const state = get()
    const clipboard = state.clipboard
    if (!clipboard || clipboard.parts.length === 0) {
      set({ statusMessage: 'Clipboard is empty — copy something first.' })
      return
    }
    const before = snapshotFromState(state)
    const pasteIndex = state.pasteCount + 1
    const { parts: pasted, connections: pastedMates } = instantiateClipboard(
      clipboard,
      pasteIndex,
      nextInstanceId,
      nextMateId,
    )

    const parts = [...state.parts, ...pasted]
    const connections = [...state.connections, ...pastedMates]
    const primary = pasted[0].instanceId
    const after = { projectName: state.projectName, parts, connections }

    // Deliberately NO trySnap / auto-snap here: a paste places exact copied
    // transforms plus the offset. Snapping the fresh copy would let it grab
    // the ORIGINAL parts it was copied from and silently re-create the very
    // external mates that copying excluded.
    set({
      parts,
      connections,
      selectedInstanceId: primary,
      multiSelectIds: pasted.slice(1).map((p) => p.instanceId),
      multiSelectAnchor: primary,
      selectedSnapPointId: null,
      pasteCount: pasteIndex,
      statusMessage:
        `Pasted ${pasted.length} part${pasted.length === 1 ? '' : 's'}` +
        (pastedMates.length > 0
          ? ` and ${pastedMates.length} connection${
              pastedMates.length === 1 ? '' : 's'
            }.`
          : '.'),
      ...historyForChange(state, before, after, 'Paste'),
    })
    persist(parts, state.projectName, connections)
  },

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
        ? activeJointFrameForInstance(
            state.parts,
            state.connections,
            current,
            state.activeMateId[instanceId],
          )
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
    let snappedShaftKind: ReturnType<typeof shaftMateKind> = null
    const snapInfo = { allRejectedByOverlap: false }

    // 1. Snap to the nearest compatible point (occupied targets are skipped, so
    //    a second pin can't land in a hole that's already taken). Re-snapping
    //    replaces any mate that reused either snap point — no accumulation.
    if (state.snapEnabled) {
      const all = buildAllWorldSnapPoints(state.parts)
      const result = findNearestCompatibleSnap(instanceId, all, {
        maxDistance: state.snapThreshold,
        occupied: occupiedSet(state.connections, state.parts),
        basicMode: state.easyMode,
        parts: state.parts,
        connections: state.connections,
        info: snapInfo,
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
        snappedShaftKind = shaftMateKind(result.dragged.type, result.target.type)
        const mate: ConnectionMate = {
          id: nextMateId(),
          aInstanceId: instanceId,
          aSnapId: result.dragged.id,
          bInstanceId: result.target.instanceId,
          bSnapId: result.target.id,
          type: 'snap',
          // A shaft through a support bore spins freely — persist that as a
          // revolute joint so the Angle control works on it out of the box.
          ...(snappedShaftKind === 'free-spinning'
            ? { jointKind: 'revolute' as const }
            : {}),
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
    if (snapped) statusMessage = snapStatusForShaftKind(snappedShaftKind)
    else if (snapInfo.allRejectedByOverlap)
      statusMessage = 'Snap skipped — parts would overlap. Try a stacked seat or a free hole.'
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
    // Candidate placement for one part moving onto the other through the
    // shared snap transform path, plus the worst contact-frame error the move
    // would leave on any mate it must preserve. The error is measured on the
    // simulated geometry itself — NOT on prune survival: the loose
    // snapThreshold prune (default 0.35) tolerates a mate stretched by a
    // whole far-face flip (0.25) and answers a different question entirely
    // (see JOINT_EXISTING_MATE_MAX_ERROR).
    const placementFor = (
      moving: PartInstanceData,
      movingSnapPt: typeof sourceWorld,
      fixedSnapPt: typeof targetWorld,
    ) => {
      const { position, rotation } = computeSnapTransform(
        moving,
        movingSnapPt,
        fixedSnapPt,
        {
          debug: state.snapDebug,
          parts: state.parts,
          connections: state.connections,
        },
      )
      const simParts = state.parts.map((p) =>
        p.instanceId === moving.instanceId ? { ...p, position, rotation } : p,
      )
      return {
        position,
        rotation,
        preservedMateError: maxPreservedMateError(
          moving.instanceId,
          simParts,
          state.connections,
          {
            aInstanceId: movingSnapPt.instanceId,
            aSnapId: movingSnapPt.id,
            bInstanceId: fixedSnapPt.instanceId,
            bSnapId: fixedSnapPt.id,
          },
          state.parts,
        ),
      }
    }

    // Which part moves? PREFERENCE: the one that is not anchored to a third
    // part — re-seating it cannot disturb the rest of the assembly. But the
    // preference only orders the candidates; the STRICT preservation gate
    // applies to whichever part actually moves, because "not anchored
    // elsewhere" still permits mates to the counterpart itself (two parts
    // joined by two pegs), and moving for one of them would tear the other.
    //
    // The simulated non-destructive move is the NORMAL WORKHORSE for aligned
    // pattern joints (2nd pin of a motor/hub pattern): re-seating an
    // already-aligned part is a near-no-op, so its preserved mates stay well
    // inside the tolerance and the mate is simply recorded. join-in-place
    // below is a NARROW SAFETY FALLBACK for cases where both candidate moves
    // are unsafe but the requested CONTACT frames are already aligned.
    // Anything else is REFUSED without touching parts, mates, selection, or
    // history — never teleport a part off its joints, and never leave a mate
    // stored but geometrically stretched.
    const sourceAnchored = anchoredElsewhere(
      state.connections,
      source.instanceId,
      instanceId,
    )
    const targetAnchored = anchoredElsewhere(
      state.connections,
      instanceId,
      source.instanceId,
    )
    let movingInstance = sourceInstance
    let movingSnap = sourceWorld
    let fixedSnap = targetWorld
    let placement: { position: Vec3; rotation: Vec3 } | null = null
    let joinedInPlace = false
    const moveTarget = () => {
      movingInstance = targetInstance
      movingSnap = targetWorld
      fixedSnap = sourceWorld
    }
    const srcPlacement = placementFor(sourceInstance, sourceWorld, targetWorld)
    const tgtPlacement = placementFor(targetInstance, targetWorld, sourceWorld)
    const candidates: Array<{
      moveTheTarget: boolean
      placement: typeof srcPlacement
    }> =
      !sourceAnchored && targetAnchored
        ? [
            { moveTheTarget: false, placement: srcPlacement },
            { moveTheTarget: true, placement: tgtPlacement },
          ]
        : sourceAnchored && !targetAnchored
          ? [
              { moveTheTarget: true, placement: tgtPlacement },
              { moveTheTarget: false, placement: srcPlacement },
            ]
          : [
              { moveTheTarget: false, placement: srcPlacement },
              { moveTheTarget: true, placement: tgtPlacement },
            ]
    for (const candidate of candidates) {
      if (candidate.placement.preservedMateError > JOINT_EXISTING_MATE_MAX_ERROR)
        continue
      if (candidate.moveTheTarget) moveTarget()
      placement = candidate.placement
      break
    }
    if (!placement) {
      // Neither side may move. Compare CONTACT positions, never markers: a
      // deep socket's marker is its mouth, ~0.23 away from where a correctly
      // seated shaft actually contacts.
      const gap = worldSnapContactPosition(sourceWorld).distanceTo(
        worldSnapContactPosition(targetWorld),
      )
      const srcAxis = sourceWorld.worldMateAxis ?? sourceWorld.worldAxis
      const tgtAxis = targetWorld.worldMateAxis ?? targetWorld.worldAxis
      const axesAligned =
        !srcAxis ||
        !tgtAxis ||
        Math.abs(
          srcAxis.clone().normalize().dot(tgtAxis.clone().normalize()),
        ) >= Math.cos((25 * Math.PI) / 180)
      if (gap <= JOIN_IN_PLACE_TOLERANCE && axesAligned) {
        joinedInPlace = true
      } else {
        const wouldMove = Math.min(
          srcPlacement.preservedMateError,
          tgtPlacement.preservedMateError,
        )
        set({
          jointSource: null,
          statusMessage: `Joint refused: this connection would move an existing mate by ${wouldMove.toFixed(2)}. Select the nearer face, disconnect the existing mate, or unlock the assembly first.`,
        })
        return
      }
    }
    const movingInstanceId = movingInstance.instanceId
    const parts = joinedInPlace
      ? state.parts
      : state.parts.map((p) =>
          p.instanceId === movingInstanceId
            ? {
                ...p,
                position: placement!.position,
                rotation: placement!.rotation,
              }
            : p,
        )
    const jointShaftKind = shaftMateKind(movingSnap.type, fixedSnap.type)
    const mate: ConnectionMate = {
      id: nextMateId(),
      aInstanceId: movingSnap.instanceId,
      aSnapId: movingSnap.id,
      bInstanceId: fixedSnap.instanceId,
      bSnapId: fixedSnap.id,
      type: 'snap',
      // Same convention as trySnap: free-spinning support mates are revolute.
      ...(jointShaftKind === 'free-spinning'
        ? { jointKind: 'revolute' as const }
        : {}),
    }
    let connections = replaceMateForSnapPoints(state.connections, mate, parts)
    // Nothing moved on a join-in-place, so nothing can have newly broken.
    // The prune floor is the strict preservation tolerance: a mate the
    // simulated-move gate just verified (error ≤ 0.12) must never be silently
    // pruned here because the user tightened the snap-distance slider below
    // it — genuinely stale counterpart mates (a re-seated pin's old hole,
    // typically ≥ 0.25 off) still prune.
    if (state.breakOnMove && !joinedInPlace) {
      connections = pruneBrokenMatesForInstance(
        movingInstanceId,
        parts,
        connections,
        Math.max(state.snapThreshold, JOINT_EXISTING_MATE_MAX_ERROR),
      )
    }
    const after = { projectName: state.projectName, parts, connections }
    const jointPositionUnlocked = { ...state.jointPositionUnlocked }
    delete jointPositionUnlocked[movingInstanceId]
    if (joinedInPlace) delete jointPositionUnlocked[fixedSnap.instanceId]
    set({
      parts,
      connections,
      jointPositionUnlocked,
      jointSource: null,
      selectedInstanceId: movingInstanceId,
      statusMessage: joinedInPlace
        ? 'Joint created — parts were already aligned, locked in place.'
        : jointShaftKind
          ? snapStatusForShaftKind(jointShaftKind)
          : 'Joint created.',
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
    const { parts, projectName, connections } = state
    // Deletes the WHOLE selection: with Shift/Ctrl+click every selected part
    // is outlined, so removing only the primary would leave highlighted parts
    // behind. Single selection behaves exactly as before.
    const doomed = new Set(get().getSelectionIds())
    if (doomed.size === 0) return
    const before = snapshotFromState(state)
    const next = parts.filter((p) => !doomed.has(p.instanceId))
    // Drop any connections that referenced a deleted part.
    const nextConnections = connections.filter(
      (c) => !doomed.has(c.aInstanceId) && !doomed.has(c.bInstanceId),
    )
    const jointPositionUnlocked = { ...state.jointPositionUnlocked }
    for (const id of doomed) delete jointPositionUnlocked[id]
    set({
      parts: next,
      connections: nextConnections,
      jointPositionUnlocked,
      selectedInstanceId: null,
      multiSelectIds: [],
      multiSelectAnchor: null,
      selectedSnapPointId: null,
      statusMessage:
        doomed.size === 1 ? 'Deleted part' : `Deleted ${doomed.size} parts`,
      ...historyForChange(
        state,
        before,
        { projectName, parts: next, connections: nextConnections },
        doomed.size === 1 ? 'Delete Part' : 'Delete Parts',
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
    let nextMode = mode
    if (state.easyMode && (mode === 'mate' || mode === 'rotate')) {
      nextMode = 'select'
    }
    const selectedConnected =
      !!state.selectedInstanceId &&
      instanceHasConnections(state.connections, state.selectedInstanceId)
    const selectedLocked =
      selectedConnected &&
      !!state.selectedInstanceId &&
      !state.jointPositionUnlocked[state.selectedInstanceId]
    const helper =
      state.easyMode && mode === 'mate'
        ? 'Switch to Advanced Mode to use the Mate Connector Tool.'
        : state.easyMode && mode === 'rotate'
          ? 'Switch to Advanced Mode to use the rotate gizmo, or use Q/E/F.'
          : nextMode === 'pin'
        ? 'Pin Mode: choose a pin type, then click a highlighted beam hole'
        : nextMode === 'joint'
          ? 'Joint Mode: select the first snap point.'
          : nextMode === 'mate'
            ? 'Mate Connector Tool: click a source connector, then a target.'
            : nextMode === 'move'
              ? selectedLocked
                ? 'Part is locked by a joint. Right-click to unlock position.'
                : state.easyMode
                  ? 'Basic Move: drag the selected part on the horizontal plane'
                  : 'Move Mode: drag the gizmo to move the part'
              : nextMode === 'rotate'
                ? selectedConnected
                  ? 'Rotate Mode: connected parts rotate around their joint.'
                  : 'Rotate Mode: drag the ring to rotate the part'
                : 'Select Mode: click a part to select it'
    // Leaving the Mate tool with an uncommitted preview restores the part.
    let parts = state.parts
    if (nextMode !== 'mate' && state.mateOriginalTransform && state.mateSource) {
      const id = state.mateSource.instanceId
      const original = state.mateOriginalTransform
      parts = state.parts.map((p) =>
        p.instanceId === id
          ? { ...p, position: original.position, rotation: original.rotation }
          : p,
      )
    }
    set({
      mode: nextMode,
      parts,
      statusMessage: helper,
      selectedSnapPointId: null,
      jointSource: null,
      mateSource: null,
      mateTarget: null,
      mateOriginalTransform: null,
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
    })
  },

  toggleEasyMode: () => {
    const state = get()
    const easyMode = !state.easyMode
    let parts = state.parts
    if (easyMode && state.mateOriginalTransform && state.mateSource) {
      const id = state.mateSource.instanceId
      const original = state.mateOriginalTransform
      parts = state.parts.map((p) =>
        p.instanceId === id
          ? { ...p, position: original.position, rotation: original.rotation }
          : p,
      )
    }
    set({
      easyMode,
      parts,
      mode: easyMode ? 'select' : state.mode,
      showSnapPoints: easyMode ? false : state.showSnapPoints,
      snapDebug: easyMode ? false : state.snapDebug,
      selectedSnapPointId: easyMode ? null : state.selectedSnapPointId,
      jointSource: easyMode ? null : state.jointSource,
      mateSource: easyMode ? null : state.mateSource,
      mateTarget: easyMode ? null : state.mateTarget,
      mateOriginalTransform: easyMode ? null : state.mateOriginalTransform,
      mateEditingMateId: easyMode ? null : state.mateEditingMateId,
      mateInitialParams: easyMode ? null : state.mateInitialParams,
      mateInitialKind: easyMode ? null : state.mateInitialKind,
      snapAuthoring: easyMode ? false : state.snapAuthoring,
      authoringSelectedSnapId: easyMode ? null : state.authoringSelectedSnapId,
      authoringSurfacePick: easyMode ? false : state.authoringSurfacePick,
      statusMessage: easyMode
        ? 'Basic Mode on: click, drag, and release near holes to snap'
        : 'Advanced Mode on: CAD-lite Mate Connector tools enabled',
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

  setMoveStep: (value) => {
    const moveStep = Math.max(0, value)
    set({
      moveStep,
      statusMessage:
        moveStep > 0 ? `Move step: ${moveStep} units` : 'Move step: free',
    })
  },

  setRotationStepDeg: (value) => {
    const rotationStepDeg = Math.max(0, value)
    set({
      rotationStepDeg,
      statusMessage:
        rotationStepDeg > 0
          ? `Rotation step: ${rotationStepDeg}°`
          : 'Rotation step: free',
    })
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

  toggleMarkersWhileMoving: () => {
    const showMarkersWhileMoving = !get().showMarkersWhileMoving
    set({
      showMarkersWhileMoving,
      statusMessage: showMarkersWhileMoving
        ? 'Showing snap markers while moving'
        : 'Hiding snap markers while moving',
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
      mateSource: null,
      mateTarget: null,
      mateOriginalTransform: null,
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
      activeMateId: {},
      projectName: 'My Robot',
      statusMessage: 'New project',
      // The CLIPBOARD deliberately survives (copying a module out of one
      // build and into a fresh one is useful, and pasted parts are minted
      // fresh so they are always valid here). The paste COUNTER resets: an
      // empty scene has nothing to bury, so the next paste should land at
      // one offset step, not wherever the previous project's run left off.
      pasteCount: 0,
      multiSelectIds: [],
      multiSelectAnchor: null,
      ...historyForChange(state, before, after, 'Clear Project'),
    })
    persist([], 'My Robot', [])
  },

  loadProject: (json) => {
    const parseInfo: ProjectParseInfo = {}
    const project = parseProject(json, parseInfo)
    // Older projects can reference snap ids from a previous metadata
    // generation (e.g. fabricated hole rows replaced by measured mhole-*
    // sets); those mates are dropped on load and the user should know.
    const removed = parseInfo.removedConnectionCount ?? 0
    const removedNote =
      removed > 0
        ? ` — ${removed} outdated connection${removed === 1 ? '' : 's'} removed`
        : ''
    set({
      projectName: project.projectName,
      parts: project.parts,
      connections: project.connections,
      selectedInstanceId: null,
      selectedSnapPointId: null,
      jointSource: null,
      snapPreview: null,
      jointPositionUnlocked: {},
      mateSource: null,
      mateTarget: null,
      mateOriginalTransform: null,
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
      activeMateId: {},
      statusMessage: `Loaded "${project.projectName}" (history cleared)${removedNote}`,
      // Same policy as clearProject: keep the clipboard, restart the offset
      // sequence against the newly loaded scene.
      pasteCount: 0,
      multiSelectIds: [],
      multiSelectAnchor: null,
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
    const state = get()
    // Restore an uncommitted Mate Editor preview before clearing.
    let parts = state.parts
    if (state.mateOriginalTransform && state.mateSource) {
      const id = state.mateSource.instanceId
      const original = state.mateOriginalTransform
      parts = state.parts.map((p) =>
        p.instanceId === id
          ? { ...p, position: original.position, rotation: original.rotation }
          : p,
      )
    }
    set({
      parts,
      selectedInstanceId: null,
      jointSource: null,
      snapPreview: null,
      selectedSnapPointId: null,
      mateSource: null,
      mateTarget: null,
      mateOriginalTransform: null,
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
      authoringSelectedSnapId: null,
      authoringSurfacePick: false,
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

    const hasMate = instanceHasConnections(state.connections, id)
    const jointFrame = options?.center
      ? null
      : activeJointFrameForInstance(
          state.parts,
          state.connections,
          target,
          state.activeMateId[id],
        )
    if (hasMate && !options?.center && !jointFrame) {
      set({
        statusMessage:
          'Active mate connector could not be resolved. Edit or recalibrate the mate before rotating.',
      })
      return
    }

    // Group the rotation and any follow-on re-snap into one undo step.
    get().beginHistoryTransaction('Rotate Part')
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

  nudgeSelected: (delta) => {
    const state = get()
    const id = state.selectedInstanceId
    if (!id) return
    const target = state.parts.find((p) => p.instanceId === id)
    if (!target) return
    if (get().isJointPositionLocked(id)) {
      set({
        statusMessage:
          'Part is locked by a joint. Right-click it (or use Unlock Position) before nudging.',
      })
      return
    }
    get().beginHistoryTransaction('Nudge Part')
    const position: Vec3 = [
      target.position[0] + delta[0],
      target.position[1] + delta[1],
      target.position[2] + delta[2],
    ]
    const parts = state.parts.map((p) =>
      p.instanceId === id ? { ...p, position } : p,
    )
    let connections = state.connections
    if (state.breakOnMove) {
      connections = pruneBrokenMatesForInstance(id, parts, connections)
    }
    set({
      parts,
      connections,
      statusMessage: `Nudged to [${position
        .map((n) => Number(n.toFixed(3)))
        .join(', ')}]`,
    })
    get().finishHistoryTransaction('Nudge Part')
    persist(parts, get().projectName, connections)
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
      state.activeMateId[instanceId],
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

  pickMateConnector: (instanceId, connector) => {
    const state = get()
    const source = state.mateSource
    if (!source) {
      set({
        mateSource: { instanceId, connector },
        mateTarget: null,
        mateOriginalTransform: null,
        mateEditingMateId: null,
        mateInitialParams: null,
        mateInitialKind: null,
        selectedInstanceId: instanceId,
        statusMessage: `Source connector: ${connector.label ?? connector.id}. Now pick a target connector on another part.`,
      })
      return
    }
    // Clicking the same connector again clears the pending source.
    if (source.instanceId === instanceId && source.connector.id === connector.id) {
      set({
        mateSource: null,
        mateTarget: null,
        mateOriginalTransform: null,
        mateEditingMateId: null,
        mateInitialParams: null,
        mateInitialKind: null,
        statusMessage: 'Mate source cleared. Pick a source connector.',
      })
      return
    }
    if (source.instanceId === instanceId) {
      set({ statusMessage: 'Pick the target connector on a different part.' })
      return
    }
    const sourceInstance = state.parts.find(
      (p) => p.instanceId === source.instanceId,
    )
    if (!sourceInstance) {
      set({
        mateSource: null,
        mateTarget: null,
        mateOriginalTransform: null,
        mateEditingMateId: null,
        mateInitialParams: null,
        mateInitialKind: null,
      })
      return
    }
    set({
      mateTarget: { instanceId, connector },
      mateOriginalTransform: {
        position: [...sourceInstance.position],
        rotation: [...sourceInstance.rotation],
      },
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
      selectedInstanceId: source.instanceId,
      statusMessage:
        'Mate Editor: adjust offset / flip / roll / gap, then Apply Mate.',
    })
  },

  updateMateConnectorPick: (endpoint, connector) => {
    const state = get()
    if (endpoint === 'source' && state.mateSource) {
      set({
        mateSource: { ...state.mateSource, connector },
        statusMessage: `Source connector adjusted: ${connector.label ?? connector.id}`,
      })
      return
    }
    if (endpoint === 'target' && state.mateTarget) {
      set({
        mateTarget: { ...state.mateTarget, connector },
        statusMessage: `Target connector adjusted: ${connector.label ?? connector.id}`,
      })
    }
  },

  editMate: (mateId, movingInstanceId) => {
    const state = get()
    const mate = state.connections.find((c) => c.id === mateId)
    if (!mate) {
      set({ statusMessage: 'Mate not found.' })
      return
    }
    const preferred =
      movingInstanceId &&
      (mate.aInstanceId === movingInstanceId ||
        mate.bInstanceId === movingInstanceId)
        ? movingInstanceId
        : state.selectedInstanceId &&
            (mate.aInstanceId === state.selectedInstanceId ||
              mate.bInstanceId === state.selectedInstanceId)
          ? state.selectedInstanceId
          : mate.aInstanceId
    const sourceSide = preferred === mate.bInstanceId ? 'b' : 'a'
    const targetSide = sourceSide === 'a' ? 'b' : 'a'
    const sourceInstanceId =
      sourceSide === 'a' ? mate.aInstanceId : mate.bInstanceId
    const targetInstanceId =
      targetSide === 'a' ? mate.aInstanceId : mate.bInstanceId
    const sourceInstance = state.parts.find(
      (p) => p.instanceId === sourceInstanceId,
    )
    const sourceConnector = resolveConnectorForMateEndpoint(
      state.parts,
      mate,
      sourceSide,
    )
    const targetConnector = resolveConnectorForMateEndpoint(
      state.parts,
      mate,
      targetSide,
    )
    if (!sourceInstance || !sourceConnector || !targetConnector) {
      set({
        statusMessage:
          'Mate connector could not be resolved. Project data may need calibration.',
      })
      return
    }
    set({
      mode: 'mate',
      mateSource: { instanceId: sourceInstanceId, connector: sourceConnector },
      mateTarget: { instanceId: targetInstanceId, connector: targetConnector },
      mateOriginalTransform: {
        position: [...sourceInstance.position],
        rotation: [...sourceInstance.rotation],
      },
      mateEditingMateId: mate.id,
      mateInitialParams: mate.mateParams ?? DEFAULT_FASTENED_MATE_PARAMS,
      mateInitialKind: mate.jointKind ?? 'fastened',
      selectedInstanceId: sourceInstanceId,
      statusMessage: 'Editing existing mate.',
    })
  },

  clearMate: () => {
    const state = get()
    let parts = state.parts
    if (state.mateOriginalTransform && state.mateSource) {
      const id = state.mateSource.instanceId
      const original = state.mateOriginalTransform
      parts = state.parts.map((p) =>
        p.instanceId === id
          ? { ...p, position: original.position, rotation: original.rotation }
          : p,
      )
    }
    set({
      parts,
      mateSource: null,
      mateTarget: null,
      mateOriginalTransform: null,
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
      statusMessage: 'Mate selection cleared.',
    })
  },

  previewFastenedMate: (params) => {
    const state = get()
    const { mateSource, mateTarget, mateOriginalTransform } = state
    if (!mateSource || !mateTarget || !mateOriginalTransform) return
    const sourceInstance = state.parts.find(
      (p) => p.instanceId === mateSource.instanceId,
    )
    const sourceDef = sourceInstance
      ? getPartDefinition(sourceInstance.partId)
      : undefined
    if (!sourceInstance || !sourceDef) return
    // Always solve from the ORIGINAL transform so repeated previews are stable.
    const original0: PartInstanceData = {
      ...sourceInstance,
      position: mateOriginalTransform.position,
      rotation: mateOriginalTransform.rotation,
    }
    const sourceConnector =
      mateSource.connector.source === 'manual' ||
      mateSource.connector.source === 'surfacePick' ||
      mateSource.connector.source === 'fallback'
        ? mateSource.connector
        : findConnector(original0, sourceDef, mateSource.connector.id) ??
          mateSource.connector
    const { position, rotation } = computeFastenedMateTransform(
      original0,
      sourceConnector,
      mateTarget.connector,
      params,
    )
    const parts = state.parts.map((p) =>
      p.instanceId === mateSource.instanceId
        ? { ...p, position, rotation }
        : p,
    )
    set({ parts })
  },

  restoreMatePreview: () => {
    const state = get()
    if (!state.mateOriginalTransform || !state.mateSource) return
    const id = state.mateSource.instanceId
    const original = state.mateOriginalTransform
    const parts = state.parts.map((p) =>
      p.instanceId === id
        ? { ...p, position: original.position, rotation: original.rotation }
        : p,
    )
    set({ parts })
  },

  rotateAroundJointLive: (instanceId, deltaRadians) => {
    const state = get()
    const inst = state.parts.find((p) => p.instanceId === instanceId)
    if (!inst) return
    // Prefer a revolute joint axis; fall back to the active/first mate.
    const revolute = state.connections.find(
      (c) =>
        c.jointKind === 'revolute' &&
        (c.aInstanceId === instanceId || c.bInstanceId === instanceId),
    )
    const frame = activeJointFrameForInstance(
      state.parts,
      state.connections,
      inst,
      revolute?.id ?? state.activeMateId[instanceId],
    )
    if (!frame) return
    const { position, rotation } = rotateInstanceAroundJoint(
      inst,
      frame,
      deltaRadians,
    )
    set({
      parts: state.parts.map((p) =>
        p.instanceId === instanceId ? { ...p, position, rotation } : p,
      ),
    })
  },

  applyFastenedMate: (params, mateType = 'fastened') => {
    const state = get()
    const {
      mateSource,
      mateTarget,
      mateOriginalTransform,
      mateEditingMateId,
    } = state
    if (!mateSource || !mateTarget || !mateOriginalTransform) return
    const sourceInstance = state.parts.find(
      (p) => p.instanceId === mateSource.instanceId,
    )
    const sourceDef = sourceInstance
      ? getPartDefinition(sourceInstance.partId)
      : undefined
    const targetInstance = state.parts.find(
      (p) => p.instanceId === mateTarget.instanceId,
    )
    const targetDef = targetInstance
      ? getPartDefinition(targetInstance.partId)
      : undefined
    if (!sourceInstance || !sourceDef || !targetInstance || !targetDef) return

    // "before" = the pre-preview transform, so this is a single undo step.
    const partsAtOriginal = state.parts.map((p) =>
      p.instanceId === mateSource.instanceId
        ? {
            ...p,
            position: mateOriginalTransform.position,
            rotation: mateOriginalTransform.rotation,
          }
        : p,
    )
    const before = snapshotFromState({
      projectName: state.projectName,
      parts: partsAtOriginal,
      connections: state.connections,
    })

    const original0: PartInstanceData = {
      ...sourceInstance,
      position: mateOriginalTransform.position,
      rotation: mateOriginalTransform.rotation,
    }
    const sourceConnector =
      mateSource.connector.source === 'manual' ||
      mateSource.connector.source === 'surfacePick' ||
      mateSource.connector.source === 'fallback'
        ? mateSource.connector
        : findConnector(original0, sourceDef, mateSource.connector.id) ??
          mateSource.connector
    const { position, rotation } = computeFastenedMateTransform(
      original0,
      sourceConnector,
      mateTarget.connector,
      params,
    )
    const parts = state.parts.map((p) =>
      p.instanceId === mateSource.instanceId
        ? { ...p, position, rotation }
        : p,
    )
    const movedSourceInstance =
      parts.find((p) => p.instanceId === mateSource.instanceId) ??
      sourceInstance
    const movedTargetInstance =
      parts.find((p) => p.instanceId === mateTarget.instanceId) ??
      targetInstance
    const sourceRefAtOriginal = connectorProjectRef(
      original0,
      sourceDef,
      sourceConnector,
    )
    const movedSourceConnector =
      resolveConnectorRef(movedSourceInstance, sourceDef, sourceRefAtOriginal) ??
      sourceConnector
    const aConnectorRef = connectorProjectRef(
      movedSourceInstance,
      sourceDef,
      movedSourceConnector,
    )
    const bConnectorRef = connectorProjectRef(
      movedTargetInstance,
      targetDef,
      mateTarget.connector,
    )
    const mate: ConnectionMate = {
      id: mateEditingMateId ?? nextMateId(),
      aInstanceId: mateSource.instanceId,
      aSnapId: sourceConnector.snapId ?? sourceConnector.id,
      bInstanceId: mateTarget.instanceId,
      bSnapId: mateTarget.connector.snapId ?? mateTarget.connector.id,
      type: 'snap',
      jointKind: mateType === 'revolute' ? 'revolute' : undefined,
      aConnectorRef,
      bConnectorRef,
      mateParams: params,
    }
    const withoutEditing = mateEditingMateId
      ? state.connections.filter((c) => c.id !== mateEditingMateId)
      : state.connections
    const connections = replaceMateForSnapPoints(withoutEditing, mate, parts)
    const after = { projectName: state.projectName, parts, connections }
    const jointPositionUnlocked = { ...state.jointPositionUnlocked }
    delete jointPositionUnlocked[mateSource.instanceId]
    const label = mateType === 'revolute' ? 'Revolute Joint' : 'Fastened Mate'
    set({
      parts,
      connections,
      jointPositionUnlocked,
      mateSource: null,
      mateTarget: null,
      mateOriginalTransform: null,
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
      selectedInstanceId: mateSource.instanceId,
      statusMessage:
        mateType === 'revolute'
          ? 'Revolute joint applied — use the Angle control to rotate it'
          : 'Fastened mate applied',
      ...historyForChange(state, before, after, label),
    })
    persist(parts, state.projectName, connections)
  },

  cancelMate: () => {
    const state = get()
    let parts = state.parts
    if (state.mateOriginalTransform && state.mateSource) {
      const id = state.mateSource.instanceId
      const original = state.mateOriginalTransform
      parts = state.parts.map((p) =>
        p.instanceId === id
          ? { ...p, position: original.position, rotation: original.rotation }
          : p,
      )
    }
    set({
      parts,
      mateSource: null,
      mateTarget: null,
      mateOriginalTransform: null,
      mateEditingMateId: null,
      mateInitialParams: null,
      mateInitialKind: null,
      statusMessage: 'Mate canceled',
    })
    persist(parts, state.projectName, state.connections)
  },

  toggleSnapAuthoring: () => {
    const snapAuthoring = !get().snapAuthoring
    set({
      snapAuthoring,
      authoringSelectedSnapId: null,
      authoringSurfacePick: false,
      statusMessage: snapAuthoring
        ? 'Snap Authoring: select a part, then edit its snap points in the panel'
        : 'Snap Authoring off',
    })
  },

  setAuthoringSelectedSnapId: (snapId) =>
    set({ authoringSelectedSnapId: snapId }),

  setAuthoringSurfacePick: (armed) =>
    set({
      authoringSurfacePick: armed,
      statusMessage: armed
        ? 'Click the selected part\'s surface to place a snap point (Esc cancels)'
        : get().statusMessage,
    }),

  setAuthoredSnapPointsForPart: (partId, snaps, status) => {
    setAuthoredSnapOverride(partId, stripResolutionFields(snaps))
    set((state) => ({
      snapAuthoringVersion: state.snapAuthoringVersion + 1,
      statusMessage: status ?? state.statusMessage,
    }))
  },

  clearAuthoredSnapPointsForPart: (partId) => {
    clearAuthoredSnapOverride(partId)
    set((state) => ({
      snapAuthoringVersion: state.snapAuthoringVersion + 1,
      authoringSelectedSnapId: null,
      statusMessage: 'Reverted to the built-in snap metadata for this part',
    }))
  },

  addAuthoredPointFromWorldHit: (instanceId, worldPoint, worldNormal) => {
    const state = get()
    const instance = state.parts.find((p) => p.instanceId === instanceId)
    const def = instance ? getPartDefinition(instance.partId) : undefined
    if (!instance || !def) return
    // Pins are calibrated through pin profiles + seat overrides; an authored
    // set shadowing a pin profile would bypass that calibration (and the 1x1
    // invariants), so refuse rather than silently degrade.
    if (matchPinProfile(def)) {
      set({
        statusMessage:
          'Pins are calibrated via pin profiles — authoring is for beams, connectors, and specialty parts.',
      })
      return
    }
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...instance.rotation),
    )
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...instance.position),
      rotation,
      new THREE.Vector3(...instance.scale),
    )
    const local = worldPoint.clone().applyMatrix4(matrix.clone().invert())
    const localNormal = worldNormal
      .clone()
      .applyQuaternion(rotation.clone().invert())
      .normalize()
    const normal = dominantAxis([localNormal.x, localNormal.y, localNormal.z])
    const axis: Vec3 = [-normal[0], -normal[1], -normal[2]]
    const snaps =
      getAuthoredSnapOverride(def.id) ??
      stripResolutionFields(getSnapPoints(def))
    const id = uniqueSnapId('auth-point', snaps)
    const position: Vec3 = [
      roundCoord(local.x),
      roundCoord(local.y),
      roundCoord(local.z),
    ]
    const point = withDerivedFrames({
      id,
      type: 'hole',
      role: 'receive',
      position,
      axis,
      normal,
      receivingDepth: SNAP_CALIBRATION.defaultBeamHoleDepth,
      occupancyGroup: id,
      compatibleWith: ['pin', 'connector'],
    })
    setAuthoredSnapOverride(def.id, [...snaps, point])
    set((s) => ({
      snapAuthoringVersion: s.snapAuthoringVersion + 1,
      authoringSelectedSnapId: id,
      authoringSurfacePick: false,
      statusMessage: `Added snap point "${id}" at [${position.join(', ')}] — edit its type/axis in the panel`,
    }))
  },

  setActiveMate: (instanceId, mateId) => {
    set((s) => ({
      activeMateId: { ...s.activeMateId, [instanceId]: mateId },
      statusMessage: 'Active joint updated for rotation',
    }))
  },
}))
