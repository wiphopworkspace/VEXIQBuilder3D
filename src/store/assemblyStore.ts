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
  connectedComponentOf,
  findNearestCompatibleSnap,
  getWorldSnapPoints,
  mateWorldGap,
  pruneBrokenMatesForInstance,
  replaceMateForSnapPoints,
  reseatAssemblyFromMates,
  validateMate,
  rotateEulerAroundWorldAxis,
  shaftMateKind,
  snapKey,
  typesCompatible,
  worldSnapContactPosition,
} from '../utils/snap'
import { getSnapPoints } from '../data/snapOverrides'
import {
  SHIPPED_PIN_SEATING_CALIBRATION,
  calibrationDiff,
  clearUserPinSeatingCalibration,
  loadUserPinSeatingCalibration,
  resolvePinSeatingCalibration,
  sanitizePinSeatingCalibration,
  saveUserPinSeatingCalibration,
  type PinSeatingCalibration,
  type PinSeatingCalibrationInput,
} from '../data/seatingCalibration'
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
 * User defaults are read ONCE at module init so the first render already has
 * the team's calibration (no flash of shipped values, and Node/verify runs get
 * an empty set because localStorage is absent there).
 */
const INITIAL_PIN_SEATING_USER_DEFAULTS: PinSeatingCalibrationInput =
  loadUserPinSeatingCalibration()
const INITIAL_PIN_SEATING: PinSeatingCalibration = resolvePinSeatingCalibration(
  INITIAL_PIN_SEATING_USER_DEFAULTS,
  {},
)

/**
 * Strict Joint Mode preservation tolerance: when a joint pick simulates moving
 * a part that already has mates, every preserved mate must still measure
 * within this contact-frame error afterwards, or the candidate move is not
 * applied. It now lives in the calibration set as
 * `PinSeatingCalibration.simulatedMoveTolerance` (shipped 0.12, unchanged)
 * and is read from `state.pinSeating` at each pick.
 *
 * It stays DELIBERATELY independent from the user snap-distance slider
 * (`snapThreshold`, default 0.35) and from the drag-release stale-mate prune
 * (`mateBreakTolerance`): those answer "has this mate physically broken?",
 * which tolerates a pin dragged a quarter-hole sideways; this answers "may
 * Joint Mode itself bend an assembly?", where a 0.25 stretch (one beam
 * thickness — the classic far-face mis-pick) must be refused, not stored.
 * 0.12 sits above real calibrated seat gaps (≤ ~0.03 incl. clearance
 * corrections) and below every physical mismatch step (0.25 face flip,
 * 0.5 hole pitch). Do not collapse these three into one number.
 */

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

/**
 * The pose a MATED part may take when the user asks for the absolute rotation
 * `requested` — the Advanced rotate gizmo, the Properties "Rotation (degrees)"
 * editor, anything that hands over an orientation rather than a hinge angle.
 *
 * Keeping the contact POINT fixed is only half of what a joint means. The other
 * half is that a pin joint permits exactly ONE motion: the twist about its own
 * axis. Pinning the point alone let a part turn any way it liked as long as one
 * point stayed put — measured on the rotate gizmo, one drag on a perpendicular
 * ring left a beam lying ACROSS its pin: mate-axis misalignment 90.000°, mate
 * still stored, status still "Rotating around joint". Its contact gap was
 * 0.04257, comfortably UNDER `simulatedMoveTolerance` (0.12), so no gap-based
 * gate could ever have caught it — only refusing the off-axis component can.
 *
 * So the requested delta is decomposed about the joint axis (swing-twist) and
 * only the twist survives. Requests that are already on-axis — the Angle
 * slider, Q/E/F — pass through bit-identical (measured: contact moves
 * 0.000000), which is what keeps this from being a behaviour change for them.
 *
 * `offAxis` reports that something was discarded, so the caller can say so
 * instead of silently doing less than it was asked.
 */
/**
 * Every path that can rotate a mated part shares one refusal, so `flipSelected`
 * can keep rewriting the verb and the user reads the same measured number
 * whether they pressed Q, dragged the gizmo or typed into the Properties panel.
 */
function overConstrainedRotationMessage(error: number): string {
  return (
    'Cannot rotate — this part is held by more than one joint ' +
    `(would stretch a mate by ${error.toFixed(3)}). ` +
    'Rotate the whole assembly, or unlock/detach it first.'
  )
}

const JOINT_AXIS_ONLY_MESSAGE =
  'Rotated on the joint axis — that is the only way a joint turns. ' +
  'Unlock Position or detach the part to aim it freely.'

function poseKeepingJoint(
  instance: PartInstanceData,
  frame: ActiveJointFrame,
  requested: Vec3,
): { position: Vec3; rotation: Vec3; offAxis: boolean } {
  const currentQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...instance.rotation),
  )
  const requestedQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...requested),
  )
  const deltaQ = requestedQ
    .clone()
    .multiply(currentQ.clone().invert())
    .normalize()

  const axis = frame.axis.clone().normalize()
  const vector = new THREE.Vector3(deltaQ.x, deltaQ.y, deltaQ.z)
  const projected = axis.clone().multiplyScalar(vector.dot(axis))
  const twist = new THREE.Quaternion(
    projected.x,
    projected.y,
    projected.z,
    deltaQ.w,
  )
  // A half turn PERPENDICULAR to the axis projects to nothing at all (both the
  // vector part and w vanish): it is pure swing, so the joint permits none of
  // it. Leaving the part exactly where it is beats normalizing a zero quat.
  const isPureSwing = twist.lengthSq() < 1e-12
  if (isPureSwing) {
    return {
      position: instance.position,
      rotation: instance.rotation,
      offAxis: true,
    }
  }
  twist.normalize()
  const offAxis = Math.abs(twist.dot(deltaQ)) < 1 - 1e-9
  // Swinging the ORIGIN about the pivot by the same delta is algebraically the
  // pivot-preserving placement (origin = pivot - qNew * localContact), and it
  // keeps every joint motion in the app on the one shared helper.
  return { ...rigidRotateAboutPivot(instance, frame.pivot, twist), offAxis }
}

/**
 * Swing `instance` about `frame.axis` through `frame.pivot` — the one motion a
 * joint actually permits. Orientation and position must both move by the SAME
 * delta, which is what keeps the pivot (and therefore the contact frames) fixed.
 *
 * The delta is applied through `rigidRotateAboutPivot` rather than inline,
 * because doing it inline is how this went wrong: `THREE.Quaternion.multiply`
 * mutates the receiver, so `deltaQ.multiply(currentQ)` left `deltaQ` holding the
 * part's whole NEW orientation, and the position was then swung by that instead
 * of by the delta. Invisible whenever the part's stored rotation was identity —
 * i.e. in every simple test — and wrong for every beam joined onto the back of a
 * pin, which the join flips 180 degrees. Measured: a 15 degree press moved the
 * contact point 1.51910 and broke the mate it claimed to be rotating around.
 */
function rotateInstanceAroundJoint(
  instance: PartInstanceData,
  frame: ActiveJointFrame,
  deltaRadians: number,
): { position: Vec3; rotation: Vec3 } {
  const deltaQ = new THREE.Quaternion().setFromAxisAngle(
    frame.axis,
    deltaRadians,
  )
  return rigidRotateAboutPivot(instance, frame.pivot, deltaQ)
}

/**
 * Apply one world-space rotation `deltaQ` about `pivot` to a single part, as a
 * rigid body: the orientation is pre-multiplied and the position swings on the
 * same arc. Every point of the part maps `p -> pivot + deltaQ * (p - pivot)`,
 * so anything sitting ON the pivot axis stays exactly where it was.
 */
function rigidRotateAboutPivot(
  instance: PartInstanceData,
  pivot: THREE.Vector3,
  deltaQ: THREE.Quaternion,
): { position: Vec3; rotation: Vec3 } {
  const currentQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...instance.rotation),
  )
  const nextQ = deltaQ.clone().multiply(currentQ).normalize()
  const nextEuler = new THREE.Euler().setFromQuaternion(nextQ)
  const nextOrigin = pivot
    .clone()
    .add(
      new THREE.Vector3(...instance.position)
        .sub(pivot)
        .applyQuaternion(deltaQ),
    )
  return {
    position: [nextOrigin.x, nextOrigin.y, nextOrigin.z],
    rotation: [nextEuler.x, nextEuler.y, nextEuler.z],
  }
}

/**
 * Carry `followers` along with one part's pose change, as a single rigid body:
 * the same rotation about that part's ORIGINAL origin, then the same
 * translation. Every follower keeps its exact relative pose to the moved part,
 * so every contact frame inside the group survives to the last float.
 *
 * This is what lets a dragged assembly SEAT: the grabbed part is solved by
 * `computeSnapTransform` as usual, and the rest of the assembly is carried by
 * the transform that solve produced rather than being re-solved one by one
 * (which could only add drift, and would anneal a deliberate join-in-place
 * mate back onto its seat — the same reasoning as `moveConnectedGroup`).
 */
function applyRigidFollow(
  parts: PartInstanceData[],
  followers: Set<string>,
  from: { position: Vec3; rotation: Vec3 },
  to: { position: Vec3; rotation: Vec3 },
): PartInstanceData[] {
  if (followers.size === 0) return parts
  const fromQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...from.rotation),
  )
  const toQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...to.rotation))
  // deltaQ takes the OLD orientation to the new one, applied in world space.
  // Built on a clone: THREE.Quaternion.multiply/invert mutate the receiver, and
  // clobbering fromQ here is exactly the bug that broke joint rotation before.
  const deltaQ = toQ.clone().multiply(fromQ.clone().invert()).normalize()
  const pivot = new THREE.Vector3(...from.position)
  const shift = new THREE.Vector3(...to.position).sub(pivot)
  return parts.map((p) => {
    if (!followers.has(p.instanceId)) return p
    const spun = rigidRotateAboutPivot(p, pivot, deltaQ)
    return {
      ...p,
      rotation: spun.rotation,
      position: [
        spun.position[0] + shift.x,
        spun.position[1] + shift.y,
        spun.position[2] + shift.z,
      ] as Vec3,
    }
  })
}

/**
 * Worst contact-frame separation over every mate involving `instanceId`, measured
 * against a SIMULATED scene. Unlike `maxPreservedMateError` this has no candidate
 * mate to exclude — a rotation replaces nothing, so every joint the part is in
 * has to survive it.
 */
function worstMateErrorAfterMove(
  instanceId: string,
  simulatedParts: PartInstanceData[],
  connections: ConnectionMate[],
  calibration: PinSeatingCalibration,
): number {
  let worst = 0
  for (const mate of connections) {
    if (mate.aInstanceId !== instanceId && mate.bInstanceId !== instanceId) {
      continue
    }
    const gap = validateMate(mate, simulatedParts, calibration).contactGap
    if (gap !== null && gap > worst) worst = gap
  }
  return worst
}

/**
 * One member of a live group drag, captured ONCE when the pointer goes down.
 * The drag then re-derives every frame's pose from these, never from the pose
 * it wrote last frame.
 */
export type GroupDragOrigin = { instanceId: string; position: Vec3 }

/**
 * Which axis a Basic-Mode drag runs along. `ground` is the classic X/Z drag on
 * the horizontal plane through the part; `height` slides it straight up and
 * down in Y, which is the only way to stack a mated beam layer by hand without
 * a keyboard (arrow keys need Shift, and a tablet has no Shift).
 */
export type BasicDragAxis = 'ground' | 'height'

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
  // SEARCH ONLY — never a validity threshold. See `pinSeating` below.
  snapThreshold: number
  /**
   * Effective pin seating calibration: shipped defaults < user-saved defaults
   * < project overrides. Read by seating, mate validation, the Joint Mode
   * preservation gate and the contact debug overlay, so every tolerance
   * decision in the app comes from one resolved set.
   */
  pinSeating: PinSeatingCalibration
  /** The user's saved web-app defaults (versioned localStorage), if any. */
  pinSeatingUserDefaults: PinSeatingCalibrationInput
  /** Overrides carried inside the current project file, if any. */
  pinSeatingProjectOverrides: PinSeatingCalibrationInput
  // Grid move snapping (CAD-style): dragged parts move on a fixed world-unit
  // grid (0 = free). 0.25 = half a hole pitch — RoboStem's "Normal 8 LDU"
  // equivalent — and matches the y=0.25 resting height, so all three axes stay
  // on-grid. Applies to the Basic-Mode plane drag, the Advanced move gizmo,
  // and drag-to-place; final seating on release still comes from
  // computeSnapTransform, which overrides the grid.
  moveStep: number
  // Rotation snapping for the Advanced rotate gizmo, in degrees (0 = free).
  rotationStepDeg: number
  // Which axis a Basic-Mode part drag runs along. See BasicDragAxis: 'ground'
  // is the historical X/Z plane drag, 'height' slides in Y. Advanced Mode has
  // the gizmo's Y arrow, so this only steers the Basic drag.
  basicDragAxis: BasicDragAxis
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
  /**
   * Write a pose straight onto one part. The LIVE path: drag frames stream
   * through it, so it neither takes history nor autosaves by default.
   *
   * A joint-locked part is re-posed to keep its joint: the contact point stays
   * put, only the twist the joint permits is applied, and a rotation that would
   * stretch a second mate past `simulatedMoveTolerance` is refused outright.
   *
   * `commit` marks a discrete edit (a typed value, a gizmo release) and
   * autosaves the result.
   */
  updatePartTransform: (
    instanceId: string,
    position: Vec3,
    rotation: Vec3,
    options?: { commit?: boolean },
  ) => void
  /**
   * Called after a move/transform ends to apply snapping if enabled.
   *
   * `excludeTargetInstanceIds` hides those parts' snap points from the search.
   * A group drag needs it: every other member travelled rigidly WITH the
   * grabbed part, so a free hole inside the group sits at the same relative
   * distance it did before the drag. Without the exclusion the grabbed part
   * would "snap" to its own assembly, and the rigid delta that seat produces
   * would then be applied to that same assembly — moving the target away by
   * exactly as much, so the two points never meet and the whole group jumps.
   *
   * `rigidFollowers` are carried by whatever transform the seat produced (see
   * `applyRigidFollow`). They are applied BEFORE mates are pruned, so the
   * break check sees the scene as it will actually end up — otherwise seating
   * the grabbed part would look, for one instant, like it had been torn out of
   * every joint holding it to its own assembly, and `breakOnMove` would delete
   * exactly the mates the group move exists to preserve.
   */
  trySnap: (
    instanceId: string,
    options?: {
      excludeTargetInstanceIds?: string[]
      rigidFollowers?: string[]
      /** Snap keys on this part that may not source the new mate. */
      excludeSourceSnapKeys?: Set<string>
    },
  ) => void
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
  /** Apply calibration changes to the live scene (session-scoped). */
  setPinSeating: (patch: PinSeatingCalibrationInput) => void
  /** Persist the current effective calibration as this browser's default. */
  savePinSeatingAsUserDefault: () => void
  /** Forget user defaults AND project overrides — back to shipped values. */
  resetPinSeatingToShipped: () => void
  /** Store the current effective calibration as a project-file override. */
  setPinSeatingProjectOverride: (patch: PinSeatingCalibrationInput) => void
  setMoveStep: (value: number) => void
  setRotationStepDeg: (value: number) => void
  setBasicDragAxis: (axis: BasicDragAxis) => void
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
   * Flip the selected part. Free part: 90° about world X, as documented. Part in
   * a joint: a HALF TURN about the joint axis — the only flip the joint permits
   * without leaving the pin, and what "flip this beam" means once it is mounted.
   */
  flipSelected: (options?: { center?: boolean }) => void
  /**
   * Turn a whole mated sub-assembly as one body — the twin of
   * `moveConnectedGroup`, and what "build the module, then attach it" needs
   * before the module goes on.
   *
   * Rigid, for the same reason the translate is: every member is rotated about
   * ONE pivot by ONE delta, and a mate always has both endpoints inside the
   * component, so every internal contact frame is preserved exactly. No member
   * is re-solved through `computeSnapTransform`.
   *
   * Unlike the single-part rotate, the requested world `axis` is honoured — a
   * component has no external mate to constrain it. `options.pivot` overrides
   * the default, which is the grabbed part's active joint contact (so a module
   * pivots where it will attach), falling back to that part's origin.
   */
  rotateConnectedGroup: (
    instanceId: string,
    axis: Vec3,
    deltaRadians: number,
    options?: { pivot?: Vec3 },
  ) => void
  /**
   * Move the selected part by a world-space delta (arrow-key nudge). One undo
   * step per call. Deliberately does NOT auto-snap — nudging is for precise
   * placement, and re-snapping would yank the part straight back. Stale mates
   * still break (breakOnMove) so nudging a pin out of a hole frees the hole.
   */
  nudgeSelected: (delta: Vec3) => void
  /**
   * Move a part AND everything mated to it by one world-space delta — the
   * manual's "build a module, then attach it" flow, where the module has to
   * travel as one body.
   *
   * RIGID TRANSLATE, by construction. Every member gets the identical delta and
   * no rotation, and a mate always has both endpoints inside the component, so
   * every joint in the assembly keeps the exact contact geometry it had:
   * internal gaps do not change by one float. That is why this deliberately
   * does NOT re-solve each part through `computeSnapTransform` — re-seating
   * parts whose relative poses are already correct could only introduce drift,
   * and it would cost one solve per part per drag frame.
   *
   * For the same reason it does not consult `isJointPositionLocked` and does
   * not prune mates: that lock stops ONE part being dragged out of its joints,
   * which is not what is happening here. Nothing is stressed, so there is
   * nothing to break and nothing to protect against.
   */
  moveConnectedGroup: (instanceId: string, delta: Vec3) => void
  /**
   * Rigid translate of an EXPLICIT id list, as one undo step. The primitive
   * behind `moveConnectedGroup` and behind every group gesture — a drag, the
   * Move Pad, Alt+arrows — so they all move a group the same way.
   */
  moveParts: (instanceIds: string[], delta: Vec3, label?: string) => void
  /**
   * The ids one MOVE gesture on `instanceId` should carry. There is exactly one
   * of these so a drag, an arrow key, and the Move Pad never disagree about
   * what "the group" is:
   *
   *   1. an explicit multi-selection containing the part — the user picked
   *      these parts by hand, and that beats any inferred grouping;
   *   2. `[instanceId]` alone when the part's joint position is UNLOCKED —
   *      unlocking is the documented "let me pull this one part out" escape
   *      hatch, and group-moving it would silently take that away;
   *   3. otherwise the connected component, so a mated part carries its
   *      assembly (the default for a joined part, which used to refuse to move).
   */
  moveGroupIdsFor: (instanceId: string) => string[]
  /**
   * Transient rigid translate for a LIVE drag: every entry is placed at its
   * recorded drag-start position plus one world delta.
   *
   * Absolute-from-origins, not incremental, so a long drag cannot accumulate
   * float error across frames. No history, no persist, no snap solve, no mate
   * pruning — the caller owns the transaction and calls `trySnapGroup` on
   * release. (Do NOT route a drag through `moveConnectedGroup`: it opens and
   * closes a history transaction, which would commit an undo entry per frame.)
   */
  dragGroupTo: (origins: GroupDragOrigin[], delta: Vec3) => void
  /**
   * Seat a group that was just dragged: snap the GRABBED part normally (with
   * the rest of the group excluded as targets), then apply the exact rigid
   * transform that seat produced — the same rotation about the grabbed origin
   * and the same translation — to every other member.
   *
   * Rigid for the same reason `moveConnectedGroup` is: one transform for the
   * whole body means every internal contact frame is carried along untouched,
   * so the assembly the user built stays bit-for-bit intact while the part
   * they grabbed lands in its new hole.
   */
  trySnapGroup: (instanceId: string, memberIds: string[]) => void
  /** Instance ids joined to `instanceId` by a chain of mates, including itself. */
  connectedGroupOf: (instanceId: string) => string[]
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

/**
 * Re-derive the restored scene's transforms from its mates.
 *
 * The autosave blob stores each part's pose verbatim, so a scene saved before
 * a seating correction would keep its OLD poses for ever — the user opens
 * their own robot and every pin is still floating, with no way to fix it short
 * of re-snapping each joint by hand. That is exactly what was reported from
 * the deployed site on 2026-07-29. A mate is the durable fact; the transform
 * is derived, so we re-derive it on restore through the one shared solver.
 */
const restored = autosaved
  ? reseatAssemblyFromMates(autosaved.parts, autosaved.connections)
  : null

export const useAssemblyStore = create<AssemblyStore>((set, get) => ({
  projectName: autosaved?.projectName ?? 'My Robot',
  parts: restored?.parts ?? autosaved?.parts ?? [],
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
  snapThreshold: INITIAL_PIN_SEATING.snapSearchDistance,
  pinSeating: INITIAL_PIN_SEATING,
  pinSeatingUserDefaults: INITIAL_PIN_SEATING_USER_DEFAULTS,
  pinSeatingProjectOverrides: {},
  moveStep: 0.25,
  rotationStepDeg: 15,
  basicDragAxis: 'ground',
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

  updatePartTransform: (instanceId, position, rotation, options) => {
    const state = get()
    const current = state.parts.find((p) => p.instanceId === instanceId)
    if (!current) return
    let nextPosition = position
    let nextRotation = rotation
    let jointOffAxis: boolean | null = null
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
      if (frame) {
        const pose = poseKeepingJoint(current, frame, rotation)
        nextPosition = pose.position
        nextRotation = pose.rotation
        jointOffAxis = pose.offAxis
      } else {
        nextPosition = current.position
      }
    }
    const parts = state.parts.map((p) =>
      p.instanceId === instanceId
        ? { ...p, position: nextPosition, rotation: nextRotation }
        : p,
    )
    // Same question and same tolerance `rotateSelected` asks before it swings a
    // part on its joint, reached here from the rotate gizmo and the Properties
    // "Rotation (degrees)" editor instead of from Q/E. Without it, typing a
    // rotation onto a part held by two pins stretched the second mate 0.26105
    // and the loader then seated that part's children off the bent parent.
    if (jointOffAxis !== null) {
      const error = worstMateErrorAfterMove(
        instanceId,
        parts,
        state.connections,
        state.pinSeating,
      )
      if (error > state.pinSeating.simulatedMoveTolerance) {
        set({ statusMessage: overConstrainedRotationMessage(error) })
        return
      }
    }
    set({
      parts,
      ...(jointOffAxis ? { statusMessage: JOINT_AXIS_ONLY_MESSAGE } : {}),
    })
    // Live drag frames stream through here and must not hit localStorage 60
    // times a second; a typed edit or a gizmo release is a COMMIT and has to
    // survive a reload, which it did not before (measured: a rotation typed in
    // the Properties panel was still the old one after a page load).
    if (options?.commit) persist(parts, state.projectName, state.connections)
  },

  trySnap: (instanceId, options) => {
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
    // Members of a dragged assembly that must travel with the seat. The grabbed
    // part is never its own follower.
    const followers = new Set(options?.rigidFollowers ?? [])
    followers.delete(instanceId)

    // 1. Snap to the nearest compatible point (occupied targets are skipped, so
    //    a second pin can't land in a hole that's already taken). Re-snapping
    //    replaces any mate that reused either snap point — no accumulation.
    if (state.snapEnabled) {
      // The dragged part always keeps its own points (they are the SOURCE side
      // of the search); only other parts can be excluded as targets.
      const excluded = new Set(options?.excludeTargetInstanceIds ?? [])
      excluded.delete(instanceId)
      const all = buildAllWorldSnapPoints(
        excluded.size === 0
          ? state.parts
          : state.parts.filter((p) => !excluded.has(p.instanceId)),
      )
      const result = findNearestCompatibleSnap(instanceId, all, {
        maxDistance: state.snapThreshold,
        occupied: occupiedSet(state.connections, state.parts),
        excludeSourceSnapKeys: options?.excludeSourceSnapKeys,
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
        // Carry the rest of a dragged assembly by the SAME transform, before
        // anything downstream reads `parts` — the mate prune below and the
        // history snapshot both have to see the finished scene.
        parts = applyRigidFollow(
          parts,
          followers,
          { position: dragged.position, rotation: dragged.rotation },
          { position, rotation },
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
    // The break tolerance is DELIBERATELY not `snapThreshold`: the search
    // slider says how far Auto Snap may reach, never whether a stored joint is
    // still sound. Passing the slider here let a mate stretched by a whole
    // beam thickness survive, and widening the slider to 1.0 kept a 0.9
    // stretch "intact" (both measured 2026-07-28).
    if (state.breakOnMove) {
      connections = pruneBrokenMatesForInstance(
        instanceId,
        parts,
        connections,
        state.pinSeating.mateBreakTolerance,
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
      if (
        candidate.placement.preservedMateError >
        state.pinSeating.simulatedMoveTolerance
      )
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
        Math.max(
          state.pinSeating.mateBreakTolerance,
          state.pinSeating.simulatedMoveTolerance,
        ),
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
                ? 'Move Mode: this part is joined, so moving it moves the whole assembly. Unlock Position to move it alone.'
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
    // The slider and the calibration's search distance are the same knob shown
    // in two places; keep them in step so neither view goes stale.
    set((state) => ({
      snapThreshold,
      pinSeating: { ...state.pinSeating, snapSearchDistance: snapThreshold },
    }))
  },

  // ---- Snap & Joint Calibration -> Pin Seating -----------------------------
  // Apply: update the live scene immediately. Nothing is persisted here, so a
  // user can experiment and reload to get their saved default back.
  setPinSeating: (patch) => {
    set((state) => {
      const pinSeating: PinSeatingCalibration = {
        ...state.pinSeating,
        ...sanitizePinSeatingCalibration(patch),
      }
      return {
        pinSeating,
        snapThreshold: pinSeating.snapSearchDistance,
        statusMessage: 'Pin seating calibration applied.',
      }
    })
  },

  savePinSeatingAsUserDefault: () => {
    const state = get()
    // Persist only what differs from shipped, so a future change to the
    // shipped defaults still reaches users who never touched that field.
    const diff = calibrationDiff(state.pinSeating)
    saveUserPinSeatingCalibration(diff)
    set({
      pinSeatingUserDefaults: diff,
      statusMessage: 'Saved as your default pin seating calibration.',
    })
  },

  resetPinSeatingToShipped: () => {
    clearUserPinSeatingCalibration()
    set({
      pinSeating: { ...SHIPPED_PIN_SEATING_CALIBRATION },
      pinSeatingUserDefaults: {},
      pinSeatingProjectOverrides: {},
      snapThreshold: SHIPPED_PIN_SEATING_CALIBRATION.snapSearchDistance,
      statusMessage: 'Pin seating reset to the shipped defaults.',
    })
  },

  setPinSeatingProjectOverride: (patch) => {
    set((state) => {
      const overrides = sanitizePinSeatingCalibration(patch)
      const pinSeating = resolvePinSeatingCalibration(
        state.pinSeatingUserDefaults,
        overrides,
      )
      return {
        pinSeatingProjectOverrides: overrides,
        pinSeating,
        snapThreshold: pinSeating.snapSearchDistance,
        statusMessage: Object.keys(overrides).length
          ? 'Pin seating override saved with this project.'
          : 'Project pin seating override cleared.',
      }
    })
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

  setBasicDragAxis: (axis) => {
    set({
      basicDragAxis: axis,
      statusMessage:
        axis === 'height'
          ? 'Drag axis: Height (Y) — drag a part straight up or down'
          : 'Drag axis: Ground (X/Z) — drag a part across the grid',
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
    // Project overrides are the TOP calibration layer, so reloading a project
    // reproduces exactly the seating it was saved with. A project without
    // overrides falls back to this browser's saved defaults, not to whatever
    // the previous project happened to set.
    const projectOverrides = sanitizePinSeatingCalibration(project.pinSeating)
    const pinSeating = resolvePinSeatingCalibration(
      get().pinSeatingUserDefaults,
      projectOverrides,
    )
    // Re-derive poses from the mates rather than trusting the stored ones, so
    // a project saved before a seating correction opens CORRECT instead of
    // frozen at its old geometry. See `reseatAssemblyFromMates`.
    const reseated = reseatAssemblyFromMates(project.parts, project.connections, {
      calibration: pinSeating,
    })
    const reseatNote =
      reseated.movedCount > 0
        ? ` — ${reseated.movedCount} part${reseated.movedCount === 1 ? '' : 's'} re-seated`
        : ''
    // Parts deliberately left where they were (join-in-place, or a mate too far
    // out to be a seating error). Reported rather than folded into "re-seated":
    // a silent skip is how a half-repaired assembly used to look identical to a
    // fully repaired one.
    const skippedNote =
      reseated.skippedCount > 0
        ? `, ${reseated.skippedCount} left in place`
        : ''
    set({
      projectName: project.projectName,
      parts: reseated.parts,
      connections: project.connections,
      pinSeatingProjectOverrides: projectOverrides,
      pinSeating,
      snapThreshold: pinSeating.snapSearchDistance,
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
      statusMessage: `Loaded "${project.projectName}" (history cleared)${removedNote}${reseatNote}${skippedNote}`,
      // Same policy as clearProject: keep the clipboard, restart the offset
      // sequence against the newly loaded scene.
      pasteCount: 0,
      multiSelectIds: [],
      multiSelectAnchor: null,
      historyPast: [],
      historyFuture: [],
      historyTransaction: null,
    })
    persist(reseated.parts, project.projectName, project.connections)
  },

  exportProject: () => {
    const { projectName, parts, connections, pinSeatingProjectOverrides } = get()
    return serializeProject(
      projectName,
      parts,
      connections,
      pinSeatingProjectOverrides,
    )
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

    // A part held by TWO joints has no rotational freedom left — two pins into
    // the same beam is the standard anti-spin mount, and the pivot is only
    // mate[0]. Swinging it about that one joint stretches the others, which used
    // to happen silently and get written to the file (measured 0.26105 on a
    // two-pin mount, still reported as "Rotated selected part around its joint",
    // and the loader then seated its children off the bent parent). Same
    // question and same calibrated tolerance Joint Mode already asks before it
    // moves an anchored part — see `simulatedMoveTolerance`.
    if (jointFrame) {
      const error = worstMateErrorAfterMove(
        id,
        rotated,
        state.connections,
        state.pinSeating,
      )
      if (error > state.pinSeating.simulatedMoveTolerance) {
        set({ statusMessage: overConstrainedRotationMessage(error) })
        return
      }
    }

    // Group the rotation and any follow-on re-snap into one undo step.
    get().beginHistoryTransaction('Rotate Part')
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

  flipSelected: (options) => {
    const state = get()
    const id = state.selectedInstanceId
    if (!id) return
    const target = state.parts.find((p) => p.instanceId === id)
    if (!target) return

    // A part in a pin joint cannot be turned over without leaving the pin: the
    // joint's only freedom is the spin about its own axis. The honest flip
    // there is the HALF TURN, which is what a builder means by "flip this beam"
    // once it is on a pin — it swaps which end sticks out. Previously the axis
    // argument was silently discarded and this landed as a quarter turn about
    // the joint axis, making Q, E and Flip three buttons with one behaviour.
    const jointFrame = options?.center
      ? null
      : activeJointFrameForInstance(
          state.parts,
          state.connections,
          target,
          state.activeMateId[id],
        )
    if (jointFrame) {
      get().rotateSelected([1, 0, 0], Math.PI)
      // Report as a flip either way — including when the shared over-constraint
      // gate refused it, so the message matches the button the user pressed.
      const status = get().statusMessage
      if (/around its joint/.test(status)) {
        set({ statusMessage: 'Flipped selected part (half turn on its joint)' })
      } else if (status.startsWith('Cannot rotate')) {
        set({ statusMessage: status.replace('Cannot rotate', 'Cannot flip') })
      }
      return
    }
    get().rotateSelected([1, 0, 0], Math.PI / 2, options)
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
          'Part is locked by a joint. Alt+arrows move the whole assembly, or Unlock Position to nudge this part alone.',
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
      connections = pruneBrokenMatesForInstance(
        id,
        parts,
        connections,
        state.pinSeating.mateBreakTolerance,
      )
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

  connectedGroupOf: (instanceId) => {
    const state = get()
    return connectedComponentOf(instanceId, state.parts, state.connections)
  },

  moveConnectedGroup: (instanceId, delta) => {
    const state = get()
    get().moveParts(
      connectedComponentOf(instanceId, state.parts, state.connections),
      delta,
    )
  },

  moveParts: (instanceIds, delta, label) => {
    const state = get()
    if (instanceIds.length === 0) return
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return
    const members = new Set(
      instanceIds.filter((id) => state.parts.some((p) => p.instanceId === id)),
    )
    if (members.size === 0) return

    get().beginHistoryTransaction(label ?? 'Move Assembly')
    const parts = state.parts.map((p) =>
      members.has(p.instanceId)
        ? {
            ...p,
            position: [
              p.position[0] + delta[0],
              p.position[1] + delta[1],
              p.position[2] + delta[2],
            ] as Vec3,
          }
        : p,
    )
    set({
      parts,
      statusMessage: `Moved ${members.size} part${
        members.size === 1 ? '' : 's'
      } by [${delta.map((n) => Number(n.toFixed(3))).join(', ')}]`,
    })
    get().finishHistoryTransaction(label ?? 'Move Assembly')
    persist(parts, get().projectName, get().connections)
  },

  moveGroupIdsFor: (instanceId) => {
    const state = get()
    if (!state.parts.some((p) => p.instanceId === instanceId)) return []
    // 1. A hand-built multi-selection wins — the user already said what "these
    //    parts" means, and it may deliberately span unconnected sub-assemblies.
    const selection = get().getSelectionIds()
    if (selection.length > 1 && selection.includes(instanceId)) return selection
    // 2. Explicitly unlocked: the documented way to pull ONE part out of its
    //    joints. Group-moving it here would remove the only gesture that can.
    if (state.jointPositionUnlocked[instanceId]) return [instanceId]
    // 3. Otherwise the whole mated assembly travels together.
    return connectedComponentOf(instanceId, state.parts, state.connections)
  },

  dragGroupTo: (origins, delta) => {
    if (origins.length === 0) return
    const state = get()
    const byId = new Map(origins.map((o) => [o.instanceId, o.position]))
    const parts = state.parts.map((p) => {
      const origin = byId.get(p.instanceId)
      if (!origin) return p
      return {
        ...p,
        position: [
          origin[0] + delta[0],
          origin[1] + delta[1],
          origin[2] + delta[2],
        ] as Vec3,
      }
    })
    set({ parts })
  },

  trySnapGroup: (instanceId, memberIds) => {
    const members = memberIds.includes(instanceId)
      ? memberIds
      : [instanceId, ...memberIds]
    if (members.length < 2) {
      get().trySnap(instanceId)
      return
    }
    const state = get()
    const memberSet = new Set(members)
    const mateCountBefore = state.connections.length

    // Points that hold the group TO ITSELF. `occupied` only gates the target
    // side of a search, so without this the assembly's own joints are valid
    // sources: seating the module onto a target beam re-mated the pin from its
    // own beam to the target and left the rest of the module behind (measured
    // on a beam-pin-beam module, 2026-08-05). Occupancy groups are included,
    // so the far face of a through-hole is protected with the near one.
    const internalKeys = buildOccupiedSnapSet(
      state.connections.filter(
        (c) => memberSet.has(c.aInstanceId) && memberSet.has(c.bInstanceId),
      ),
      state.parts,
    )

    // WHICH member seats. A single-part drag has only one candidate source;
    // an assembly has one per member, and the part the user happened to grab
    // is usually NOT the one that plugs in — you grab a beam and attach by the
    // pin sticking out of the far end. Picking the anchor by search rather
    // than by grab is what makes "build a module, then attach it" work.
    //
    // The pass is a plain best-of over the same search the single-part path
    // uses, so ranking, the Basic-Mode confidence gate and the overlap gate
    // all stay in one place; the winner is then seated through `trySnap`
    // itself, which redoes the search for that one part.
    let anchor = instanceId
    if (state.snapEnabled) {
      const outside = state.parts.filter((p) => !memberSet.has(p.instanceId))
      const outsidePoints = buildAllWorldSnapPoints(outside)
      if (outsidePoints.length > 0) {
        const occupied = occupiedSet(state.connections, state.parts)
        let best: { id: string; score: number; distance: number } | null = null
        for (const id of members) {
          const part = state.parts.find((p) => p.instanceId === id)
          const def = part ? getPartDefinition(part.partId) : undefined
          if (!part || !def) continue
          const result = findNearestCompatibleSnap(
            id,
            [...getWorldSnapPoints(part, def), ...outsidePoints],
            {
              maxDistance: state.snapThreshold,
              occupied,
              excludeSourceSnapKeys: internalKeys,
              basicMode: state.easyMode,
              parts: state.parts,
              connections: state.connections,
            },
          )
          if (!result) continue
          if (
            !best ||
            result.score < best.score - 1e-6 ||
            (Math.abs(result.score - best.score) < 1e-6 &&
              result.distance < best.distance)
          ) {
            best = { id, score: result.score, distance: result.distance }
          }
        }
        if (best) anchor = best.id
      }
    }

    const followers = members.filter((id) => id !== anchor)
    get().trySnap(anchor, {
      excludeTargetInstanceIds: followers,
      rigidFollowers: followers,
      excludeSourceSnapKeys: internalKeys,
    })
    set({
      statusMessage:
        get().connections.length > mateCountBefore
          ? `Assembly snapped on — ${members.length} parts placed as one body`
          : `Moved ${members.length} connected parts`,
    })
  },

  rotateConnectedGroup: (instanceId, axis, deltaRadians, options) => {
    const state = get()
    const group = connectedComponentOf(instanceId, state.parts, state.connections)
    if (group.length === 0 || deltaRadians === 0) return
    const axisV = new THREE.Vector3(...axis)
    if (axisV.lengthSq() < 1e-12) return
    const members = new Set(group)
    const target = state.parts.find((p) => p.instanceId === instanceId)!

    // Default pivot: the joint the grabbed part hangs on, so turning a module
    // pivots where it will actually attach rather than around a bbox centre.
    // Falls back to the grabbed part's own origin for a free-floating module.
    const jointFrame = activeJointFrameForInstance(
      state.parts,
      state.connections,
      target,
      state.activeMateId[instanceId],
    )
    const pivot = options?.pivot
      ? new THREE.Vector3(...options.pivot)
      : (jointFrame?.pivot.clone() ?? new THREE.Vector3(...target.position))
    const deltaQ = new THREE.Quaternion().setFromAxisAngle(
      axisV.normalize(),
      deltaRadians,
    )

    get().beginHistoryTransaction('Rotate Assembly')
    const parts = state.parts.map((p) =>
      members.has(p.instanceId)
        ? { ...p, ...rigidRotateAboutPivot(p, pivot, deltaQ) }
        : p,
    )
    const deg = Math.round((deltaRadians * 180) / Math.PI)
    set({
      parts,
      statusMessage:
        group.length === 1
          ? `Rotated 1 part ${deg}°`
          : `Rotated ${group.length} connected parts ${deg}° as one assembly`,
    })
    get().finishHistoryTransaction('Rotate Assembly')
    persist(parts, get().projectName, get().connections)
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
        statusMessage:
          'Joint position locked. Dragging now moves the whole assembly, and the part still rotates around the pin.',
      })
    } else {
      unlocked[instanceId] = true
      set({
        jointPositionUnlocked: unlocked,
        selectedInstanceId: instanceId,
        statusMessage:
          'Joint position unlocked. Dragging now moves THIS part alone, out of its joints. Right-click or long-press to lock again.',
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
    if (!jointFrame) {
      const parts = state.parts.map((p) =>
        p.instanceId === instanceId ? { ...p, rotation } : p,
      )
      set({ parts, statusMessage: 'Rotated selected part' })
      persist(parts, state.projectName, state.connections)
      return
    }

    const pose = poseKeepingJoint(instance, jointFrame, rotation)
    const parts = state.parts.map((p) =>
      p.instanceId === instanceId
        ? { ...p, position: pose.position, rotation: pose.rotation }
        : p,
    )
    const error = worstMateErrorAfterMove(
      instanceId,
      parts,
      state.connections,
      state.pinSeating,
    )
    if (error > state.pinSeating.simulatedMoveTolerance) {
      set({ statusMessage: overConstrainedRotationMessage(error) })
      return
    }
    set({
      parts,
      statusMessage: pose.offAxis ? JOINT_AXIS_ONLY_MESSAGE : 'Rotating around joint',
    })
    // This is the rotate gizmo's COMMIT (Viewport calls it on drag end), and
    // nothing downstream persisted — a gizmo rotation was gone after a reload.
    persist(parts, state.projectName, state.connections)
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
    const parts = state.parts.map((p) =>
      p.instanceId === instanceId ? { ...p, position, rotation } : p,
    )
    // The Angle slider renders for any part with a REVOLUTE mate, and a part
    // can easily hold one alongside another joint — a beam carrying a
    // free-spinning shaft that is also pinned to a second beam is an ordinary
    // build. Swinging it about the shaft stretched the pin mate 0.26105 with no
    // message at all, and the loader then seated its children off the bent
    // parent. Same gate as Q/E: measure, and refuse rather than bend.
    const error = worstMateErrorAfterMove(
      instanceId,
      parts,
      state.connections,
      state.pinSeating,
    )
    if (error > state.pinSeating.simulatedMoveTolerance) {
      set({ statusMessage: overConstrainedRotationMessage(error) })
      return
    }
    set({ parts })
    persist(parts, state.projectName, state.connections)
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
