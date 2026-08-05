import * as THREE from 'three'
import type {
  ConnectionMate,
  MateFrameDefinition,
  PartDefinition,
  PartInstanceData,
  RuntimeSnapPoint,
  SnapMetadataSource,
  SnapPointDefinition,
  SnapPointType,
  Vec3,
} from '../types/assembly'
import { getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'
import { SNAP_CALIBRATION } from '../data/snapCalibration'
import { parseRectPart } from '../data/partFamilies'
import {
  SHIPPED_PIN_SEATING_CALIBRATION,
  type PinSeatingCalibration,
} from '../data/seatingCalibration'

/**
 * Canonical snap-point compatibility matrix (the single source of truth).
 *   hole            <- pin, connector          (pins only — never shafts)
 *   pin             -> hole
 *   connector       -> hole
 *   axle (station)  -> axleHole, wheelCenter, gearCenter, shaftSupportBore
 *   axleHole        -> axle                    (square driven bore)
 *   wheelCenter     -> axle
 *   gearCenter      -> axle
 *   motorShaft      -> shaftEnd                (drive SOCKET — shaft ends only;
 *                                              pins/idlers/bores are rejected)
 *   shaftEnd        -> motorShaft
 *   shaftSupportBore-> axle                    (free-spinning pass-through)
 *
 * 2026-07-14 shaft pass: `motorShaft` no longer accepts axle stations or
 * gear/wheel centers directly — a shaft END seats in the socket, and driven
 * components mount on the shaft. Old saved mates still load (load validation
 * checks snap ids, not types).
 */
export const SNAP_COMPATIBILITY: Record<SnapPointType, SnapPointType[]> = {
  hole: ['pin', 'connector'],
  pin: ['hole'],
  connector: ['hole'],
  axle: ['axleHole', 'wheelCenter', 'gearCenter', 'shaftSupportBore'],
  axleHole: ['axle'],
  wheelCenter: ['axle'],
  gearCenter: ['axle'],
  motorShaft: ['shaftEnd'],
  shaftEnd: ['motorShaft'],
  shaftSupportBore: ['axle'],
}

/**
 * Mechanical meaning of a shaft-family mate, used for status text and for
 * tagging free-spinning support mates as revolute joints.
 */
export type ShaftMateKind =
  | 'motor-drive'
  | 'rotation-locked'
  | 'free-spinning'

export function shaftMateKind(
  a: SnapPointType,
  b: SnapPointType,
): ShaftMateKind | null {
  const pair = (x: SnapPointType, y: SnapPointType) =>
    (a === x && b === y) || (a === y && b === x)
  if (pair('shaftEnd', 'motorShaft')) return 'motor-drive'
  if (
    pair('axle', 'axleHole') ||
    pair('axle', 'gearCenter') ||
    pair('axle', 'wheelCenter')
  ) {
    return 'rotation-locked'
  }
  if (pair('axle', 'shaftSupportBore')) return 'free-spinning'
  return null
}

/** Bidirectional type compatibility — either type accepting the other counts. */
export function typesCompatible(a: SnapPointType, b: SnapPointType): boolean {
  return (
    (SNAP_COMPATIBILITY[a]?.includes(b) ?? false) ||
    (SNAP_COMPATIBILITY[b]?.includes(a) ?? false)
  )
}

// Snap threshold in world units. A snap point within this distance of a
// compatible target will snap into place.
export const SNAP_THRESHOLD = SNAP_CALIBRATION.pinSnapThreshold

// Reusable scratch objects.
const _matrix = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _euler = new THREE.Euler()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _local = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _up = new THREE.Vector3()

function composeFromInstance(instance: PartInstanceData): THREE.Matrix4 {
  _pos.set(...instance.position)
  _euler.set(...instance.rotation)
  _quat.setFromEuler(_euler)
  _scale.set(...instance.scale)
  return _matrix.compose(_pos, _quat, _scale)
}

/** Stable occupancy key for a snap point. */
export function snapKey(instanceId: string, snapId: string): string {
  return `${instanceId}::${snapId}`
}

function snapOccupancyGroup(
  parts: PartInstanceData[] | undefined,
  instanceId: string,
  snapId: string,
): string {
  if (!parts) return snapId
  const instance = parts.find((p) => p.instanceId === instanceId)
  const definition = instance ? getPartDefinition(instance.partId) : undefined
  const snap = definition
    ? getSnapPoints(definition).find((s) => s.id === snapId)
    : undefined
  return snap?.occupancyGroup ?? snapId
}

function snapIdsInOccupancyGroup(
  parts: PartInstanceData[] | undefined,
  instanceId: string,
  snapId: string,
): string[] {
  if (!parts) return [snapId]
  const instance = parts.find((p) => p.instanceId === instanceId)
  const definition = instance ? getPartDefinition(instance.partId) : undefined
  if (!definition) return [snapId]
  const snaps = getSnapPoints(definition)
  const snap = snaps.find((s) => s.id === snapId)
  if (!snap?.occupancyGroup) return [snapId]
  return snaps
    .filter((s) => s.occupancyGroup === snap.occupancyGroup)
    .map((s) => s.id)
}

/**
 * Occupied snap ids expanded by physical occupancy groups. A beam/plate hole
 * has separate front/back selectable snap markers, but both markers share the
 * same occupancy group and therefore block each other once mated.
 */
export function buildOccupiedSnapSet(
  connections: ConnectionMate[],
  parts?: PartInstanceData[],
): Set<string> {
  const set = new Set<string>()
  const addEndpoint = (instanceId: string, snapId: string) => {
    for (const id of snapIdsInOccupancyGroup(parts, instanceId, snapId)) {
      set.add(snapKey(instanceId, id))
    }
  }
  for (const c of connections) {
    addEndpoint(c.aInstanceId, c.aSnapId)
    addEndpoint(c.bInstanceId, c.bSnapId)
  }
  return set
}

/**
 * Rotate an Euler rotation by `angle` radians about a world axis, returning a
 * new Euler. Composing as quaternions (worldDelta * current) keeps "turn around
 * vertical" meaning world-Y even after the part has already been flipped — the
 * intuitive behavior for the Easy Mode rotate/flip buttons.
 */
export function rotateEulerAroundWorldAxis(
  rotation: Vec3,
  axis: Vec3,
  angle: number,
): Vec3 {
  const cur = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation))
  const delta = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(...axis).normalize(),
    angle,
  )
  const next = delta.multiply(cur).normalize()
  const e = new THREE.Euler().setFromQuaternion(next)
  return [e.x, e.y, e.z]
}

/**
 * Compute the world-space transform of every snap point on an instance.
 *
 * If a live `object3D` is provided (e.g. mid TransformControls drag), its
 * `matrixWorld` is used so the result tracks the moving object. Otherwise the
 * transform is composed from the stored instance position/rotation/scale.
 */
export function getWorldSnapPoints(
  instance: PartInstanceData,
  partDefinition: PartDefinition,
  object3D?: THREE.Object3D,
): RuntimeSnapPoint[] {
  let matrix: THREE.Matrix4
  const worldQuat = new THREE.Quaternion()
  if (object3D) {
    object3D.updateMatrixWorld(true)
    matrix = object3D.matrixWorld
    object3D.getWorldQuaternion(worldQuat)
  } else {
    matrix = composeFromInstance(instance)
    _euler.set(...instance.rotation)
    worldQuat.setFromEuler(_euler)
  }

  return getSnapPoints(partDefinition).map((snapPoint) => {
    _local.set(...snapPoint.position)
    const worldPosition = _local.clone().applyMatrix4(matrix)
    const localAxis = snapPoint.axis ?? snapPoint.normal
    const worldAxis = localAxis
      ? new THREE.Vector3(...localAxis).applyQuaternion(worldQuat).normalize()
      : undefined
    const localFrame = mateFrame(snapPoint)
    const worldMatePosition = new THREE.Vector3(...localFrame.position).applyMatrix4(
      matrix,
    )
    const worldMateAxis = localMateAxis(snapPoint)
      ?.applyQuaternion(worldQuat)
      .normalize()
    const worldMateUp = localMateUp(snapPoint)
      ?.applyQuaternion(worldQuat)
      .normalize()
    const localSeatFrame = seatFrame(snapPoint)
    const worldSeatPosition = new THREE.Vector3(
      ...localSeatFrame.position,
    ).applyMatrix4(matrix)
    const worldSeatAxis = localSeatAxis(snapPoint)
      ?.applyQuaternion(worldQuat)
      .normalize()
    const worldFacePosition = new THREE.Vector3(
      ...localFacePosition(snapPoint),
    ).applyMatrix4(matrix)
    return {
      ...snapPoint,
      instanceId: instance.instanceId,
      worldPosition,
      worldQuaternion: worldQuat.clone(),
      worldAxis,
      worldMatePosition,
      worldMateAxis,
      worldMateUp,
      worldSeatPosition,
      worldSeatAxis,
      worldFacePosition,
    }
  })
}

/** World snap points for every instance, composed from stored transforms. */
export function buildAllWorldSnapPoints(
  parts: PartInstanceData[],
  getDef: typeof getPartDefinition = getPartDefinition,
): RuntimeSnapPoint[] {
  const out: RuntimeSnapPoint[] = []
  for (const instance of parts) {
    const def = getDef(instance.partId)
    if (!def) continue
    out.push(...getWorldSnapPoints(instance, def))
  }
  return out
}

function isCompatible(
  a: SnapPointDefinition,
  b: SnapPointDefinition,
): boolean {
  return typesCompatible(a.type, b.type)
}

function mateFrame(snap: SnapPointDefinition): MateFrameDefinition {
  return {
    position: snap.mateFrame?.position ?? snap.position,
    axis: snap.mateFrame?.axis ?? snap.axis ?? snap.normal ?? [0, 0, 1],
    up: snap.mateFrame?.up,
  }
}

function seatFrame(snap: SnapPointDefinition): MateFrameDefinition {
  const frame = mateFrame(snap)
  if (snap.seatFrame) {
    return {
      position: snap.seatFrame.position,
      axis: snap.seatFrame.axis ?? frame.axis,
      up: snap.seatFrame.up ?? frame.up,
    }
  }
  if (snap.seatPosition) {
    return {
      position: snap.seatPosition,
      axis: frame.axis,
      up: frame.up,
    }
  }

  const correction = snap.insertionDepthCorrection ?? 0
  if (Math.abs(correction) < 1e-10) return frame

  const axis = new THREE.Vector3(...frame.axis)
  if (axis.lengthSq() < 1e-10) return frame
  axis.normalize()
  return {
    position: [
      frame.position[0] - axis.x * correction,
      frame.position[1] - axis.y * correction,
      frame.position[2] - axis.z * correction,
    ],
    axis: frame.axis,
    up: frame.up,
  }
}

function localFacePosition(snap: SnapPointDefinition): Vec3 {
  return snap.facePosition ?? mateFrame(snap).position
}

function localSeatPosition(snap: SnapPointDefinition): THREE.Vector3 {
  return new THREE.Vector3(...seatFrame(snap).position)
}

function localContactPosition(snap: SnapPointDefinition): THREE.Vector3 {
  if (snap.role === 'receive' || snap.type === 'hole') {
    return new THREE.Vector3(...localFacePosition(snap))
  }
  return localSeatPosition(snap)
}

function localMateAxis(snap: SnapPointDefinition): THREE.Vector3 | null {
  const axis = snap.mateFrame?.axis ?? snap.axis ?? snap.normal
  if (!axis) return null
  _axis.set(...axis)
  if (_axis.lengthSq() < 1e-10) return null
  return _axis.clone().normalize()
}

function localMateUp(snap: SnapPointDefinition): THREE.Vector3 | null {
  const up = snap.mateFrame?.up
  if (!up) return null
  _up.set(...up)
  if (_up.lengthSq() < 1e-10) return null
  return _up.clone().normalize()
}

export type NearestSnap = {
  dragged: RuntimeSnapPoint
  target: RuntimeSnapPoint
  distance: number
  score: number
}

function worldMateAxis(snap: RuntimeSnapPoint): THREE.Vector3 | null {
  if (snap.worldMateAxis && snap.worldMateAxis.lengthSq() >= 1e-10) {
    return snap.worldMateAxis.clone().normalize()
  }
  const axis = localMateAxis(snap)
  if (!axis) return null
  return axis.applyQuaternion(snap.worldQuaternion).normalize()
}

function worldMateUp(snap: RuntimeSnapPoint): THREE.Vector3 | null {
  if (snap.worldMateUp && snap.worldMateUp.lengthSq() >= 1e-10) {
    return snap.worldMateUp.clone().normalize()
  }
  const up = localMateUp(snap)
  if (!up) return null
  return up.applyQuaternion(snap.worldQuaternion).normalize()
}

function localSeatAxis(snap: SnapPointDefinition): THREE.Vector3 | null {
  const axis = snap.seatFrame?.axis ?? snap.mateFrame?.axis ?? snap.axis ?? snap.normal
  if (!axis) return null
  _axis.set(...axis)
  if (_axis.lengthSq() < 1e-10) return null
  return _axis.clone().normalize()
}

/**
 * World CONTACT position of a runtime snap point — the plane that actually
 * mates (receiving face for hole/receive-side snaps, seat frame for
 * insert-side snaps), not the visual marker. Deep sockets make the difference
 * matter: the Smart Motor socket's marker is the socket MOUTH while its
 * contact plane sits 0.232 deeper inside, so marker-to-marker distance reads
 * ~0.23 on a perfectly seated shaft. Any "are these two points already
 * aligned?" decision must compare contact positions, never markers.
 */
export function worldSnapContactPosition(snap: RuntimeSnapPoint): THREE.Vector3 {
  if (snap.role === 'receive' || snap.type === 'hole') {
    return snap.worldFacePosition?.clone() ?? snap.worldMatePosition.clone()
  }
  return snap.worldSeatPosition?.clone() ?? snap.worldMatePosition.clone()
}

const worldTargetContactPosition = worldSnapContactPosition

function isHoleLikeSnap(snap: SnapPointDefinition): boolean {
  return snap.type === 'hole' || snap.role === 'receive'
}

function isPinLikeSnap(snap: SnapPointDefinition): boolean {
  return (
    snap.type === 'pin' ||
    snap.type === 'connector' ||
    snap.id === 'pin-front' ||
    snap.id === 'pin-back'
  )
}

function resolveRuntimeSnap(
  parts: PartInstanceData[],
  instanceId: string,
  snapId: string,
): RuntimeSnapPoint | null {
  const instance = parts.find((p) => p.instanceId === instanceId)
  const definition = instance ? getPartDefinition(instance.partId) : undefined
  if (!instance || !definition) return null
  return (
    getWorldSnapPoints(instance, definition).find((snap) => snap.id === snapId) ??
    null
  )
}

/**
 * REMOVED 2026-07-28 (second seating owner) — do not reintroduce.
 *
 * `resolveBeamToBeamClearanceCorrection` used to fire whenever a receiver was
 * mated to a pin whose OTHER side already carried one, and force the two
 * receivers' faces to sit exactly `beamToBeamFaceClearance` (0.010) apart. That
 * made it a SECOND owner of the axial seating correction, and it silently
 * overrode the endpoint metadata: measured on a 1x1 pin, it moved the second
 * beam by +0.020 so the two beams ended 0.010 apart — while the pin's real
 * central collar is 0.070 thick. The collar was 86% swallowed by the beams.
 *
 * With every pin-side contact plane now on its MEASURED stopping surface
 * (`pinContactPlanes.ts`), the separation between two receivers joined through
 * a pin falls out of the pin's own geometry — 0.070 for the 1x1/2x2/3x3 collar
 * — and needs no correction at all. `beamToBeamFaceClearance` survives only as
 * a Properties-panel readout of the historical measured value.
 */

/** Measured face-to-face separation two receivers get through a given pin. */
export function pinFlangeSeparation(
  parts: PartInstanceData[],
  pinInstanceId: string,
): number | null {
  const front = resolveRuntimeSnap(parts, pinInstanceId, 'pin-front')
  const back = resolveRuntimeSnap(parts, pinInstanceId, 'pin-back')
  if (!front || !back) return null
  return worldSnapContactPosition(front).distanceTo(
    worldSnapContactPosition(back),
  )
}

function correctionDepthContribution(snap: RuntimeSnapPoint): number {
  if (snap.seatFrame || snap.seatPosition) return 0
  return snap.insertionDepthCorrection ?? 0
}

function sourceSideSeatAdjustment(snap: RuntimeSnapPoint): number {
  return snap.sourceSideSeatAdjustment ?? snap.finalSeatAdjustment ?? 0
}

function targetSideSeatAdjustment(snap: RuntimeSnapPoint): number {
  return snap.targetSideSeatAdjustment ?? snap.finalSeatAdjustment ?? 0
}

function seatedDepthContributions(
  sourceSnap: RuntimeSnapPoint,
  targetSnap: RuntimeSnapPoint,
): { source: number; target: number; total: number } {
  const source =
    (sourceSnap.insertionDepth ?? 0) +
    (sourceSnap.seatOffset ?? 0) +
    correctionDepthContribution(sourceSnap) +
    sourceSideSeatAdjustment(sourceSnap)
  const target =
    (targetSnap.insertionDepth ?? 0) +
    (targetSnap.seatOffset ?? 0) +
    correctionDepthContribution(targetSnap) +
    targetSideSeatAdjustment(targetSnap)
  return {
    source,
    target,
    total: source + target,
  }
}

function formatDebugVec(v: THREE.Vector3 | null): string {
  if (!v) return 'none'
  return (
    `[${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}]`
  )
}

function resolveAlignMode(
  sourceSnap: SnapPointDefinition,
  targetSnap: SnapPointDefinition,
): 'same' | 'opposite' | 'nearest' {
  if (sourceSnap.alignMode) return sourceSnap.alignMode
  if (targetSnap.alignMode) return targetSnap.alignMode
  if (
    sourceSnap.type === 'pin' &&
    targetSnap.type === 'hole' &&
    (sourceSnap.role === 'shoulder' || targetSnap.role === 'receive')
  ) {
    return 'same'
  }
  return 'opposite'
}

function metadataQualityPenalty(source: SnapMetadataSource | undefined): number {
  switch (source) {
    case 'curated':
      return 0
    case 'partDefinition':
      return 0.015
    case 'generatedFallback':
      return 0.05
    case 'boundsInferred':
      return 0.08
    default:
      return 0.06
  }
}

function compatibilityPriorityPenalty(
  source: RuntimeSnapPoint,
  target: RuntimeSnapPoint,
): number {
  const a = source.type
  const b = target.type
  if (
    (a === 'pin' && b === 'hole') ||
    (a === 'hole' && b === 'pin')
  ) {
    return -0.035
  }
  // Shaft-family preferences: the motor socket is the strongest attractor for
  // a shaft end, driven bores beat nearby measured pin holes, and support
  // bores rank slightly below driven bores so a gear near both prefers the
  // rotation-locked seat.
  if (
    (a === 'shaftEnd' && b === 'motorShaft') ||
    (b === 'shaftEnd' && a === 'motorShaft')
  ) {
    return -0.04
  }
  if (
    (a === 'axle' &&
      (b === 'wheelCenter' || b === 'gearCenter' || b === 'axleHole')) ||
    (b === 'axle' &&
      (a === 'wheelCenter' || a === 'gearCenter' || a === 'axleHole'))
  ) {
    return -0.03
  }
  if (
    (a === 'axle' && b === 'shaftSupportBore') ||
    (b === 'axle' && a === 'shaftSupportBore')
  ) {
    return -0.015
  }
  return 0
}

function snapCandidateScore(
  source: RuntimeSnapPoint,
  target: RuntimeSnapPoint,
  distance: number,
): number {
  return (
    distance +
    metadataQualityPenalty(source.snapSource) +
    metadataQualityPenalty(target.snapSource) +
    compatibilityPriorityPenalty(source, target)
  )
}

// Positional confidence only. `curatedNeedsReview` is intentionally NOT here: it
// flags data (e.g. a pin's seat depth) that should be visually reviewed but whose
// position is known, so such snaps should still seat freely in Basic/Auto Snap.
function lowConfidenceSnap(snap: RuntimeSnapPoint): boolean {
  return (
    snap.snapSource === 'boundsInferred' ||
    snap.snapSource === 'generatedFallback' ||
    snap.approximate === true
  )
}

/**
 * Deep-overlap rejection for Auto Snap candidates.
 *
 * Plain rectangular beams/plates have exact box bounds (parseRectPart), so a
 * candidate placement that would bury one rect part inside another can be
 * detected with an OBB SAT test and skipped in favor of the next candidate.
 * The tolerance sits above the intentional seat pre-loads (stacked pin seats
 * interpenetrate up to ~0.020 by the calibrated 1x2 convention) but far below
 * a real collision (a same-plane beam overlap is a full 0.24 thickness).
 * Non-rect parts (pins, wheels, specialty shapes) are never tested — pins are
 * MEANT to sit inside holes.
 */
const SNAP_OVERLAP_TOLERANCE = 0.05

function rectHalfExtents(partId: string): THREE.Vector3 | null {
  const def = getPartDefinition(partId)
  const rect = def ? parseRectPart(def) : null
  if (!rect) return null
  return new THREE.Vector3(
    (rect.length * SNAP_CALIBRATION.beamHolePitch) / 2,
    (rect.width * SNAP_CALIBRATION.beamHolePitch) / 2,
    SNAP_CALIBRATION.beamHalfThickness,
  )
}

/**
 * Minimal separating-axis penetration depth between two oriented boxes.
 * Returns 0 when separated. Standard 15-axis SAT (3 + 3 face normals, 9 edge
 * cross products).
 */
function obbPenetrationDepth(
  aCenter: THREE.Vector3,
  aQuat: THREE.Quaternion,
  aHalf: THREE.Vector3,
  bCenter: THREE.Vector3,
  bQuat: THREE.Quaternion,
  bHalf: THREE.Vector3,
): number {
  const aAxes = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(aQuat),
    new THREE.Vector3(0, 1, 0).applyQuaternion(aQuat),
    new THREE.Vector3(0, 0, 1).applyQuaternion(aQuat),
  ]
  const bAxes = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(bQuat),
    new THREE.Vector3(0, 1, 0).applyQuaternion(bQuat),
    new THREE.Vector3(0, 0, 1).applyQuaternion(bQuat),
  ]
  const aHalfArr = [aHalf.x, aHalf.y, aHalf.z]
  const bHalfArr = [bHalf.x, bHalf.y, bHalf.z]
  const d = bCenter.clone().sub(aCenter)

  let minOverlap = Infinity
  const testAxis = (axis: THREE.Vector3): boolean => {
    const lenSq = axis.lengthSq()
    if (lenSq < 1e-8) return true // degenerate cross product — skip
    const n = axis.clone().multiplyScalar(1 / Math.sqrt(lenSq))
    let ra = 0
    let rb = 0
    for (let i = 0; i < 3; i++) {
      ra += aHalfArr[i] * Math.abs(aAxes[i].dot(n))
      rb += bHalfArr[i] * Math.abs(bAxes[i].dot(n))
    }
    const overlap = ra + rb - Math.abs(d.dot(n))
    if (overlap <= 0) return false // separated
    if (overlap < minOverlap) minOverlap = overlap
    return true
  }

  for (const axis of aAxes) if (!testAxis(axis)) return 0
  for (const axis of bAxes) if (!testAxis(axis)) return 0
  for (const a of aAxes) {
    for (const b of bAxes) {
      if (!testAxis(new THREE.Vector3().crossVectors(a, b))) return 0
    }
  }
  return minOverlap
}

/**
 * True when placing the moving rect part at `position`/`rotation` would bury it
 * inside another rect part deeper than the seat-pre-load tolerance.
 */
function placementDeeplyOverlaps(
  movingInstance: PartInstanceData,
  movingHalf: THREE.Vector3,
  position: Vec3,
  rotation: Vec3,
  parts: PartInstanceData[],
): boolean {
  const movingCenter = new THREE.Vector3(...position)
  const movingQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...rotation),
  )
  for (const other of parts) {
    if (other.instanceId === movingInstance.instanceId) continue
    const otherHalf = rectHalfExtents(other.partId)
    if (!otherHalf) continue // only rect-vs-rect is testable/enforced
    const depth = obbPenetrationDepth(
      movingCenter,
      movingQuat,
      movingHalf,
      new THREE.Vector3(...other.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...other.rotation)),
      otherHalf,
    )
    if (depth > SNAP_OVERLAP_TOLERANCE) return true
  }
  return false
}

/**
 * Find the nearest compatible snap pair between the dragged instance and any
 * other instance.
 *
 * When `parts` is provided and the dragged part is a plain rectangular
 * beam/plate, candidates whose final placement would deeply interpenetrate
 * another rect part are rejected and the next-best candidate wins (Auto Snap
 * overlap protection). Hole faces sit exactly one beam thickness apart — the
 * same spacing as pin layer seats — so near-tied candidates are common and one
 * of them may land the beam inside an occupied plane.
 */
export interface SnapSearchInfo {
  /**
   * True when at least one in-range compatible candidate existed but every
   * one was rejected by the overlap gate — callers can tell the user why no
   * snap happened instead of showing the generic no-snap state.
   */
  allRejectedByOverlap: boolean
}

export function findNearestCompatibleSnap(
  draggedInstanceId: string,
  allWorldSnapPoints: RuntimeSnapPoint[],
  options: {
    maxDistance?: number
    occupied?: Set<string>
    /**
     * Snap keys on the DRAGGED part that may not be used as the source of a
     * new mate. `occupied` only ever gates the target side, because a normal
     * re-snap is allowed to reuse the dragged part's own point — that is how
     * pulling a pin out of one hole and into another works.
     *
     * A group move needs the opposite: the point a member is joined to its own
     * assembly by must not be re-consumed, or seating the assembly onto
     * something else silently replaces an internal mate and the "rigid" body
     * falls apart at exactly one joint. Measured: dragging a beam-pin-beam
     * module onto a target beam re-mated the pin from its own beam to the
     * target and left the module's first beam behind.
     */
    excludeSourceSnapKeys?: Set<string>
    basicMode?: boolean
    /** Current instances — enables deep-overlap candidate rejection. */
    parts?: PartInstanceData[]
    connections?: ConnectionMate[]
    /** Out-param: filled with why the search returned null (return type stays stable). */
    info?: SnapSearchInfo
  } = {},
): NearestSnap | null {
  if (options.info) options.info.allRejectedByOverlap = false
  const maxDistance = options.maxDistance ?? SNAP_THRESHOLD
  const occupied = options.occupied
  const dragged = allWorldSnapPoints.filter(
    (s) => s.instanceId === draggedInstanceId,
  )
  if (dragged.length === 0) return null

  const candidates: NearestSnap[] = []
  const excludeSource = options.excludeSourceSnapKeys
  for (const source of dragged) {
    if (excludeSource?.has(snapKey(source.instanceId, source.id))) continue
    for (const target of allWorldSnapPoints) {
      if (target.instanceId === draggedInstanceId) continue
      if (!isCompatible(source, target)) continue
      // Skip targets that are already mated (unless the caller allows it).
      if (occupied && occupied.has(snapKey(target.instanceId, target.id))) {
        continue
      }
      const distance = source.worldPosition.distanceTo(target.worldPosition)
      if (distance > maxDistance) continue
      // Basic Mode gates on POSITIONAL confidence: skip positionally
      // approximate/inferred metadata (e.g. electronics bbox mount holes), but
      // still allow curated parts whose only caveat is a seat-depth review
      // (every pin size) so they can Auto Snap. The Advanced Mate Tool can
      // pick/calibrate the approximate ones.
      if (
        options.basicMode &&
        (source.approximate ||
          target.approximate ||
          source.snapSource === 'boundsInferred' ||
          target.snapSource === 'boundsInferred')
      ) {
        continue
      }
      // Low-confidence metadata is still useful, but Basic/Auto Snap should not
      // reach across a large radius and force a questionable mate. The user can
      // still use Advanced Mate Tool + manual connector authoring for these.
      if (
        (lowConfidenceSnap(source) || lowConfidenceSnap(target)) &&
        distance > maxDistance * (options.basicMode ? 0.25 : 0.45)
      ) {
        continue
      }
      const score = snapCandidateScore(source, target, distance)
      candidates.push({ dragged: source, target, distance, score })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort(
    (a, b) =>
      Math.abs(a.score - b.score) < 1e-6
        ? a.distance - b.distance
        : a.score - b.score,
  )

  // Overlap gate: only when the caller supplied part instances and the moving
  // part has exact rect bounds. Everything else keeps the plain best candidate.
  const movingInstance = options.parts?.find(
    (p) => p.instanceId === draggedInstanceId,
  )
  const movingHalf = movingInstance
    ? rectHalfExtents(movingInstance.partId)
    : null
  if (!options.parts || !movingInstance || !movingHalf) return candidates[0]

  for (const candidate of candidates) {
    const { position, rotation } = computeSnapTransform(
      movingInstance,
      candidate.dragged,
      candidate.target,
      { parts: options.parts, connections: options.connections },
    )
    if (
      !placementDeeplyOverlaps(
        movingInstance,
        movingHalf,
        position,
        rotation,
        options.parts,
      )
    ) {
      return candidate
    }
  }
  // Every candidate would bury the part inside another part.
  if (options.info) options.info.allRejectedByOverlap = true
  return null
}

/**
 * One axial contribution to the seated pose, with the layer it came from.
 * The layers are exactly the calibration hierarchy: measured part geometry <
 * declared part metadata < shipped/user/project calibration.
 */
export type SeatingTerm = {
  source: string
  layer: 'measured-metadata' | 'metadata' | 'calibration'
  value: number
}

/**
 * Measurable outcome of one seating solve. Every "is this joint good?"
 * decision in the app reads these numbers rather than re-deriving geometry.
 */
export type SeatingDiagnostics = {
  /** Perpendicular distance between the two insertion axes at contact. */
  radialError: number
  /** Angle between the two insertion axes, in degrees. */
  angularErrorDeg: number
  /**
   * Signed distance between the two mechanical contact planes along the
   * insertion axis. > 0 floats the part off the face; < 0 pre-loads into it.
   */
  axialContactGap: number
  /** How far the contact planes pre-load into each other (= max(0, -gap)). */
  penetration: number
  /**
   * The overlap the calibration ASKED for — the documented render overlap plus
   * any user/project offset. Ships at 0 (exact surface contact).
   */
  intendedOverlap: number
  /**
   * Overlap beyond what was asked for: real, unwanted mesh interpenetration.
   * THIS is what `penetrationTolerance` gates, which is why that tolerance can
   * be tiny — an intended overlap must never buy headroom for a defect.
   */
  unintendedPenetration: number
  /**
   * |achieved - intended| along the axis. Pure numerical error; a healthy solve
   * keeps this at float noise (< 1e-9), so it separates "we meant to do that"
   * from "the maths drifted".
   */
  solverDeviation: number
  /** Every axial term with its provenance, in application order. */
  breakdown: SeatingTerm[]
  /** Calibrated seat offset contributed by part metadata. */
  appliedSeatOffset: number
  /** Extra uniform offset contributed by the user calibration setting. */
  appliedContactOffset: number
  /** Roll quantization actually in force (360 = a single fixed roll). */
  rollStepDeg: number
  /** Which receiving face was selected, as the sign of its outward normal. */
  receiverFaceSign: number
  alignMode: 'same' | 'opposite' | 'nearest'
  contactPlaneSource: { source: string; target: string }
}

export type SeatedPose = {
  position: Vec3
  rotation: Vec3
  diagnostics: SeatingDiagnostics
}

/** Verdict of checking a seating solve against the active tolerances. */
export type SeatingVerdict = {
  ok: boolean
  reasons: string[]
}

export function evaluateSeating(
  diagnostics: SeatingDiagnostics,
  calibration: PinSeatingCalibration = SHIPPED_PIN_SEATING_CALIBRATION,
): SeatingVerdict {
  const reasons: string[] = []
  if (diagnostics.radialError > calibration.radialTolerance) {
    reasons.push(
      `radial error ${diagnostics.radialError.toFixed(4)} > ${calibration.radialTolerance}`,
    )
  }
  if (diagnostics.angularErrorDeg > calibration.angularToleranceDeg) {
    reasons.push(
      `angular error ${diagnostics.angularErrorDeg.toFixed(2)}° > ${calibration.angularToleranceDeg}°`,
    )
  }
  // Measure the gap against what the calibration ASKED for, not against zero.
  // A user's fine adjustment is intent, not error; a part floating off its face
  // still fails because that is a deviation from intent too.
  if (diagnostics.solverDeviation > calibration.axialGapTolerance) {
    reasons.push(
      `contact gap ${diagnostics.axialContactGap.toFixed(5)} deviates ` +
        `${diagnostics.solverDeviation.toFixed(5)} from the intended ` +
        `${(diagnostics.axialContactGap - diagnostics.solverDeviation).toFixed(5)} ` +
        `> ${calibration.axialGapTolerance}`,
    )
  }
  // Gate the UNINTENDED component only. A deliberate render overlap or a
  // user's fine adjustment is not a defect, and must never be able to buy
  // headroom that hides one — which is exactly how `penetrationTolerance`
  // drifted up to 0.03 to accommodate the old stacked pre-load.
  if (diagnostics.unintendedPenetration > calibration.penetrationTolerance) {
    reasons.push(
      `unintended penetration ${diagnostics.unintendedPenetration.toFixed(5)} > ` +
        `${calibration.penetrationTolerance} (intended overlap ` +
        `${diagnostics.intendedOverlap.toFixed(5)})`,
    )
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * THE authoritative seated-pose solver. Auto Snap, Joint Mode, Pin Mode,
 * paste and project load all reach placement through this one function (via
 * `computeSnapTransform`); there is deliberately no second seating path.
 *
 * Steps, in order:
 *   1. align the insertion axes (`alignMode` picks same/opposite/nearest)
 *   2. resolve the nearest valid roll (exact-up, or quantized by `rollStepDeg`)
 *   3. align the MECHANICAL CONTACT PLANES — a pin's shoulder/cap onto the
 *      receiver's face or internal seating plane, never marker-to-marker
 *   4. apply the calibrated seat offset from part metadata
 *   5. apply the user's uniform contact offset (shipped default 0)
 *   6. apply the beam-to-beam clearance correction through a pin flange
 *   7. measure radial / angular / axial / penetration error separately
 *
 * The radial centres coincide by construction: step 3 places the source
 * contact ORIGIN on the target contact origin, and both origins are on their
 * feature's axis, so only the axial term is then adjusted.
 */
export function solveSeatedPose(
  movingInstance: PartInstanceData,
  sourceSnap: RuntimeSnapPoint,
  targetSnap: RuntimeSnapPoint,
  opts: {
    alignNormals?: boolean
    alignMode?: 'same' | 'opposite' | 'nearest'
    debug?: boolean
    parts?: PartInstanceData[]
    connections?: ConnectionMate[]
    /** Effective pin seating calibration; defaults to the shipped values. */
    calibration?: PinSeatingCalibration
  } = {},
): SeatedPose {
  const alignNormals = opts.alignNormals ?? true
  const calibration = opts.calibration ?? SHIPPED_PIN_SEATING_CALIBRATION
  const curQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...movingInstance.rotation),
  )
  let newQuat = curQuat.clone()
  let targetAxisForOffset = worldMateAxis(targetSnap)
  const resolvedAlignMode =
    opts.alignMode ?? resolveAlignMode(sourceSnap, targetSnap)
  const effectiveRollStep =
    sourceSnap.rollStepDeg ?? targetSnap.rollStepDeg ?? 360

  if (alignNormals) {
    const srcAxis = worldMateAxis(sourceSnap)
    const tgtAxis = targetAxisForOffset
    if (srcAxis && tgtAxis) {
      const mode = resolvedAlignMode
      // 'nearest' picks whichever direction needs the smaller rotation from the
      // staged orientation, so a deliberate 180° pre-flip on a symmetric shaft
      // mate survives (both insertions are physically valid).
      const desired =
        mode === 'same'
          ? tgtAxis
          : mode === 'nearest'
            ? srcAxis.dot(tgtAxis) >= 0
              ? tgtAxis
              : tgtAxis.clone().negate().normalize()
            : tgtAxis.clone().negate().normalize()
      const qDelta = new THREE.Quaternion().setFromUnitVectors(srcAxis, desired)
      newQuat = qDelta.multiply(curQuat).normalize()

      const sourceUpLocal = localMateUp(sourceSnap)
      const targetUpWorld = worldMateUp(targetSnap)
      if (sourceUpLocal && targetUpWorld) {
        const sourceUpWorld = sourceUpLocal.applyQuaternion(newQuat)
        const axis = desired.clone().normalize()
        const projectedSourceUp = sourceUpWorld
          .sub(axis.clone().multiplyScalar(sourceUpWorld.dot(axis)))
          .normalize()
        const projectedTargetUp = targetUpWorld
          .clone()
          .sub(axis.clone().multiplyScalar(targetUpWorld.dot(axis)))
          .normalize()
        if (
          projectedSourceUp.lengthSq() > 1e-10 &&
          projectedTargetUp.lengthSq() > 1e-10
        ) {
          const cross = new THREE.Vector3().crossVectors(
            projectedSourceUp,
            projectedTargetUp,
          )
          const angle = Math.atan2(
            axis.dot(cross),
            projectedSourceUp.dot(projectedTargetUp),
          )
          // Square-drive quantization: when either snap declares a roll step
          // (VEX IQ square shafts use 90°), only roll by the residual needed
          // to reach the NEAREST step-multiple relative orientation. The
          // user's preview roll stays visually stable (±half a step at most)
          // and the mate indexes in quarter turns instead of snapping to one
          // canonical up. Snaps without a roll step keep the exact-up align.
          const rollStep = sourceSnap.rollStepDeg ?? targetSnap.rollStepDeg
          let rollAngle = angle
          if (rollStep && rollStep > 0) {
            const step = (rollStep * Math.PI) / 180
            rollAngle = angle - Math.round(angle / step) * step
          }
          const roll = new THREE.Quaternion().setFromAxisAngle(axis, rollAngle)
          newQuat = roll.multiply(newQuat).normalize()
        }
      }
    }
  }

  // Place the origin so the rotated local source seat frame lands on the
  // target receiving face, then apply optional calibrated seated-depth offset.
  const localOffset = localContactPosition(sourceSnap).applyQuaternion(newQuat)
  const contributions = seatedDepthContributions(sourceSnap, targetSnap)
  const depth = contributions.total
  const targetContact = worldTargetContactPosition(targetSnap)
  const newOrigin = targetContact.clone().sub(localOffset)
  if (targetAxisForOffset && Math.abs(depth) > 1e-10) {
    newOrigin.add(targetAxisForOffset.clone().multiplyScalar(depth))
  }
  // User calibration — a uniform fine adjustment along the insertion axis, on
  // TOP of the part metadata's own calibrated seat offset. Shipped default is
  // 0: connector-family metadata stays the source of mechanical accuracy and
  // this is only a whole-library nudge. Applies to pin-family mates only.
  const contactOffset =
    isPinLikeSnap(sourceSnap) || isPinLikeSnap(targetSnap)
      ? calibration.pinContactOffset
      : 0
  if (targetAxisForOffset && Math.abs(contactOffset) > 1e-10) {
    newOrigin.add(targetAxisForOffset.clone().multiplyScalar(contactOffset))
  }
  // Itemised provenance of every axial term, in application order. This is the
  // breakdown the developer overlay and the inventory print: if a seated pose
  // is wrong, this says exactly which layer moved it.
  const breakdown: SeatingTerm[] = [
    { source: 'receiver contact face', layer: 'metadata', value: 0 },
    { source: 'connector stopping surface', layer: 'metadata', value: 0 },
    {
      source: `source endpoint (${sourceSnap.id}) seat offset`,
      layer: sourceSnap.contactPlaneMeasured ? 'measured-metadata' : 'metadata',
      value: contributions.source,
    },
    {
      source: `target endpoint (${targetSnap.id}) seat offset`,
      layer: targetSnap.contactPlaneMeasured ? 'measured-metadata' : 'metadata',
      value: contributions.target,
    },
    {
      source: 'user / project pin contact offset',
      layer: 'calibration',
      value: contactOffset,
    },
  ]
  const finalAxialCorrection = depth + contactOffset

  if (opts.debug) {
    console.debug(
      [
        'Seated pose breakdown:',
        `source=${sourceSnap.id}(${sourceSnap.type})`,
        `target=${targetSnap.id}(${targetSnap.type})`,
        `axis=${formatDebugVec(targetAxisForOffset)}`,
        ...breakdown.map((t) => `${t.source}[${t.layer}]=${t.value.toFixed(5)}`),
        `finalAxialCorrection=${finalAxialCorrection.toFixed(5)}`,
      ].join(' '),
    )
  }
  const e = new THREE.Euler().setFromQuaternion(newQuat)

  // ---- measure the achieved contact, separately per error mode -------------
  // Re-derive the source contact plane at the FINAL pose rather than trusting
  // the algebra above, so the diagnostics are an independent measurement.
  const finalSourceContact = localContactPosition(sourceSnap)
    .applyQuaternion(newQuat)
    .add(newOrigin)
  const measureAxis =
    targetAxisForOffset?.clone().normalize() ?? new THREE.Vector3(0, 0, 1)
  const contactDelta = finalSourceContact.clone().sub(targetContact)
  const axialContactGap = contactDelta.dot(measureAxis)
  const radialError = contactDelta
    .clone()
    .sub(measureAxis.clone().multiplyScalar(axialContactGap))
    .length()
  const finalSourceAxis = localMateAxis(sourceSnap)?.applyQuaternion(newQuat)
  let angularErrorDeg = 0
  if (finalSourceAxis && targetAxisForOffset) {
    const dot = THREE.MathUtils.clamp(
      finalSourceAxis.normalize().dot(measureAxis),
      -1,
      1,
    )
    // Both 'same' and 'opposite' alignments are exact when |dot| is 1; the
    // error is the deviation from the axis LINE, not from one direction.
    angularErrorDeg = (Math.acos(Math.abs(dot)) * 180) / Math.PI
  }
  const outwardNormal = targetSnap.normal
    ? new THREE.Vector3(...targetSnap.normal)
        .applyQuaternion(targetSnap.worldQuaternion)
        .normalize()
    : measureAxis.clone().negate()

  const penetration = Math.max(0, -axialContactGap)
  const intendedOverlap = Math.max(0, -finalAxialCorrection)
  return {
    position: [newOrigin.x, newOrigin.y, newOrigin.z],
    rotation: [e.x, e.y, e.z],
    diagnostics: {
      radialError,
      angularErrorDeg,
      axialContactGap,
      penetration,
      intendedOverlap,
      unintendedPenetration: Math.max(0, penetration - intendedOverlap),
      solverDeviation: Math.abs(axialContactGap - finalAxialCorrection),
      breakdown,
      appliedSeatOffset: depth,
      appliedContactOffset: contactOffset,
      rollStepDeg: effectiveRollStep,
      receiverFaceSign: outwardNormal.dot(measureAxis) < 0 ? 1 : -1,
      alignMode: resolvedAlignMode,
      contactPlaneSource: {
        source:
          sourceSnap.seatFrame || sourceSnap.seatPosition
            ? 'seatFrame'
            : 'marker',
        target: targetSnap.facePosition ? 'facePosition' : 'marker',
      },
    },
  }
}

/**
 * Shared final placement entry point — Auto Snap, Joint Mode, Pin Mode, paste
 * and project load all go through here. Thin wrapper over `solveSeatedPose`
 * that drops the diagnostics; callers that need the measured errors (the
 * verification suite, the contact debug overlay, mate validation) call
 * `solveSeatedPose` directly. There is exactly one seating implementation.
 */
export function computeSnapTransform(
  movingInstance: PartInstanceData,
  sourceSnap: RuntimeSnapPoint,
  targetSnap: RuntimeSnapPoint,
  opts: {
    alignNormals?: boolean
    alignMode?: 'same' | 'opposite' | 'nearest'
    debug?: boolean
    parts?: PartInstanceData[]
    connections?: ConnectionMate[]
    calibration?: PinSeatingCalibration
  } = {},
): { position: Vec3; rotation: Vec3 } {
  const { position, rotation } = solveSeatedPose(
    movingInstance,
    sourceSnap,
    targetSnap,
    opts,
  )
  return { position, rotation }
}

/**
 * World position of a single snap point by id (used by Pin Mode to place a pin
 * exactly at a clicked hole).
 */
export function getWorldSnapPointById(
  instance: PartInstanceData,
  partDefinition: PartDefinition,
  snapPointId: string,
): THREE.Vector3 | null {
  const snapPoint = getSnapPoints(partDefinition).find(
    (s) => s.id === snapPointId,
  )
  if (!snapPoint) return null
  const matrix = composeFromInstance(instance)
  return localContactPosition(snapPoint).applyMatrix4(matrix)
}

/**
 * Enforce "at most one mate per snap point".
 *
 * Removes any existing connection that already uses either of the new mate's
 * two snap points. When part metadata provides an occupancy group, grouped
 * front/back snap markers on the same physical hole also replace each other.
 * This makes re-snapping *replace* a connection instead of accumulating
 * duplicates and leaking occupancy.
 */
export function replaceMateForSnapPoints(
  connections: ConnectionMate[],
  mate: ConnectionMate,
  parts?: PartInstanceData[],
): ConnectionMate[] {
  const usesPoint = (
    c: ConnectionMate,
    instanceId: string,
    snapId: string,
  ): boolean => {
    const sameEndpoint = (otherInstanceId: string, otherSnapId: string) => {
      if (otherInstanceId !== instanceId) return false
      if (otherSnapId === snapId) return true
      return (
        snapOccupancyGroup(parts, otherInstanceId, otherSnapId) ===
        snapOccupancyGroup(parts, instanceId, snapId)
      )
    }
    return sameEndpoint(c.aInstanceId, c.aSnapId) || sameEndpoint(c.bInstanceId, c.bSnapId)
  }

  return [
    ...connections.filter(
      (c) =>
        !usesPoint(c, mate.aInstanceId, mate.aSnapId) &&
        !usesPoint(c, mate.bInstanceId, mate.bSnapId),
    ),
    mate,
  ]
}

/** World-space distance between a mate's two snap points, or null if unresolved. */
export function mateWorldGap(
  mate: ConnectionMate,
  parts: PartInstanceData[],
  getDef: typeof getPartDefinition = getPartDefinition,
): number | null {
  const resolve = (instanceId: string, snapId: string) => {
    const inst = parts.find((p) => p.instanceId === instanceId)
    const def = inst ? getDef(inst.partId) : undefined
    if (!inst || !def) return null
    return getWorldSnapPointById(inst, def, snapId)
  }
  const a = resolve(mate.aInstanceId, mate.aSnapId)
  const b = resolve(mate.bInstanceId, mate.bSnapId)
  if (!a || !b) return null
  return a.distanceTo(b)
}

/**
 * Measured signed face gap between the two parts a pin joins (its front- and
 * back-side hole mates), projected onto the pin axis. Returns null unless the
 * pin has hole mates on both sides. Lets the UI report the ACHIEVED beam-to-beam
 * clearance, not just the target calibration constant.
 */
export function measurePinBeamToBeamGap(
  pinInstanceId: string,
  parts: PartInstanceData[],
  connections: ConnectionMate[],
): number | null {
  const pinMates = connections.filter(
    (c) => c.aInstanceId === pinInstanceId || c.bInstanceId === pinInstanceId,
  )
  if (pinMates.length < 2) return null

  const faces: THREE.Vector3[] = []
  let axis: THREE.Vector3 | null = null
  for (const mate of pinMates) {
    const pinIsA = mate.aInstanceId === pinInstanceId
    const pinSnapId = pinIsA ? mate.aSnapId : mate.bSnapId
    const beamInstanceId = pinIsA ? mate.bInstanceId : mate.aInstanceId
    const beamSnapId = pinIsA ? mate.bSnapId : mate.aSnapId
    const beamSnap = resolveRuntimeSnap(parts, beamInstanceId, beamSnapId)
    if (!beamSnap || !isHoleLikeSnap(beamSnap)) continue
    faces.push(worldTargetContactPosition(beamSnap))
    if (!axis) {
      const pinSnap = resolveRuntimeSnap(parts, pinInstanceId, pinSnapId)
      axis = pinSnap ? worldMateAxis(pinSnap) : null
    }
  }
  if (faces.length < 2 || !axis || axis.lengthSq() < 1e-10) return null
  return Math.abs(faces[0].clone().sub(faces[1]).dot(axis.clone().normalize()))
}

/** How intact a STORED mate is, measured on the mechanical contact frames. */
export type MateHealth = 'seated' | 'stretched' | 'broken' | 'unresolved'

export type MateValidation = {
  health: MateHealth
  /** Contact-frame separation, or null when an endpoint no longer resolves. */
  contactGap: number | null
  /** Perpendicular component of that separation. */
  radialError: number | null
  /** True only when the mate is within the mechanical contact tolerances. */
  intact: boolean
  reason?: string
}

/**
 * Validate one stored mate against the MECHANICAL CONTACT FRAMES.
 *
 * This deliberately does NOT consult the snap search radius. Before
 * 2026-07-28 "is this mate intact?" was answered by `pruneBrokenMatesForInstance`
 * with the user's snap-distance slider, so a mate stretched by a whole beam
 * thickness (0.245) counted as intact at the 0.35 default — and raising the
 * slider to 1.0 kept a 0.9 stretch "intact" (both measured). A search radius
 * says what Auto Snap may REACH FOR; it can never make a stretched joint sound.
 *
 * `seated` — within the contact tolerances; the joint is mechanically closed.
 * `stretched` — still stored and still within the break tolerance, but no
 *   longer touching. Surfaced to the user rather than silently accepted.
 * `broken` — beyond the break tolerance; the joint has come apart.
 */
export function validateMate(
  mate: ConnectionMate,
  parts: PartInstanceData[],
  calibration: PinSeatingCalibration = SHIPPED_PIN_SEATING_CALIBRATION,
  getDef: typeof getPartDefinition = getPartDefinition,
): MateValidation {
  const resolveSnap = (instanceId: string, snapId: string) => {
    const inst = parts.find((p) => p.instanceId === instanceId)
    const def = inst ? getDef(inst.partId) : undefined
    if (!inst || !def) return null
    return (
      getWorldSnapPoints(inst, def).find((s) => s.id === snapId) ?? null
    )
  }
  const a = resolveSnap(mate.aInstanceId, mate.aSnapId)
  const b = resolveSnap(mate.bInstanceId, mate.bSnapId)
  if (!a || !b) {
    return {
      health: 'unresolved',
      contactGap: null,
      radialError: null,
      intact: false,
      reason: 'an endpoint no longer resolves to a snap point',
    }
  }
  const pa = worldSnapContactPosition(a)
  const pb = worldSnapContactPosition(b)
  const delta = pa.clone().sub(pb)
  const contactGap = delta.length()
  const axis =
    worldMateAxis(b) ?? worldMateAxis(a) ?? new THREE.Vector3(0, 0, 1)
  const axial = delta.dot(axis)
  const radialError = delta
    .clone()
    .sub(axis.clone().multiplyScalar(axial))
    .length()

  if (contactGap > calibration.mateBreakTolerance) {
    return {
      health: 'broken',
      contactGap,
      radialError,
      intact: false,
      reason: `contact frames ${contactGap.toFixed(4)} apart (break tolerance ${calibration.mateBreakTolerance})`,
    }
  }
  const withinAxial =
    Math.abs(axial) <=
    Math.max(calibration.axialGapTolerance, calibration.penetrationTolerance)
  const withinRadial = radialError <= calibration.radialTolerance
  if (withinAxial && withinRadial) {
    return { health: 'seated', contactGap, radialError, intact: true }
  }
  return {
    health: 'stretched',
    contactGap,
    radialError,
    intact: false,
    reason: `contact frames ${contactGap.toFixed(4)} apart (seated tolerance ${calibration.axialGapTolerance})`,
  }
}

/**
 * Drop mates involving `instanceId` whose two snap points have been pulled
 * farther apart than `maxGap` — i.e. the part was manually moved away and the
 * mate no longer physically holds. Mates that still resolve close together (or
 * that can't be measured) are kept, so a freshly snapped mate (~0 gap) survives.
 *
 * `maxGap` is the STORED-MATE BREAK TOLERANCE
 * (`PinSeatingCalibration.mateBreakTolerance`), never the snap search radius —
 * callers must not pass the user's snap-distance slider here.
 */
export function pruneBrokenMatesForInstance(
  instanceId: string,
  parts: PartInstanceData[],
  connections: ConnectionMate[],
  maxGap: number = SHIPPED_PIN_SEATING_CALIBRATION.mateBreakTolerance,
  getDef: typeof getPartDefinition = getPartDefinition,
): ConnectionMate[] {
  return connections.filter((c) => {
    const involved =
      c.aInstanceId === instanceId || c.bInstanceId === instanceId
    if (!involved) return true
    const gap = mateWorldGap(c, parts, getDef)
    // Keep when still close, or when we can't measure (avoid surprise removals).
    return gap === null || gap <= maxGap
  })
}

/**
 * One edge of the mate graph, seen from ONE of its two parts. `ownSnapId`
 * belongs to the part this edge is listed under; `otherSnapId` to `other`.
 */
export type MateGraphEdge = {
  other: string
  ownSnapId: string
  otherSnapId: string
  mate: ConnectionMate
}

/**
 * Undirected adjacency over the mate graph: each mate becomes two edges, one
 * per endpoint. A mate naming a part that is not in `parts` is dropped — a
 * dangling endpoint is not a connection.
 */
function buildMateAdjacency(
  parts: PartInstanceData[],
  connections: ConnectionMate[],
): Map<string, MateGraphEdge[]> {
  const known = new Set(parts.map((p) => p.instanceId))
  const neighbours = new Map<string, MateGraphEdge[]>()
  const push = (
    from: string,
    other: string,
    ownSnapId: string,
    otherSnapId: string,
    mate: ConnectionMate,
  ) => {
    const list = neighbours.get(from) ?? []
    list.push({ other, ownSnapId, otherSnapId, mate })
    neighbours.set(from, list)
  }
  for (const c of connections) {
    if (!known.has(c.aInstanceId) || !known.has(c.bInstanceId)) continue
    push(c.aInstanceId, c.bInstanceId, c.aSnapId, c.bSnapId, c)
    push(c.bInstanceId, c.aInstanceId, c.bSnapId, c.aSnapId, c)
  }
  return neighbours
}

/**
 * THE mate-graph traversal. Breadth-first from `rootId`, returning every
 * instance id this call discovered, root first — which is also the order in
 * which an assembly can be rebuilt outward from an anchor.
 *
 * There is deliberately only one of these in the codebase. `connectedComponentOf`
 * and `reseatAssemblyFromMates` walk the same graph for different reasons, and a
 * second copy would be free to disagree about what "connected" means (dangling
 * endpoints, both mate directions, a part reachable only through a stale mate).
 *
 * `opts.visited` lets a caller share one claim-set across several roots, so a
 * part already handled by an earlier component is never re-visited. It is
 * MUTATED. `opts.onTreeEdge` fires once per BFS tree edge, before the child is
 * claimed; returning `false` leaves that child undiscovered so another edge may
 * still reach it (a stale mate must not consume a part's only chance of being
 * placed).
 */
function traverseMateGraph(
  rootId: string,
  neighbours: Map<string, MateGraphEdge[]>,
  opts: {
    visited?: Set<string>
    onTreeEdge?: (parentId: string, edge: MateGraphEdge) => boolean | void
  } = {},
): string[] {
  const visited = opts.visited ?? new Set<string>()
  if (visited.has(rootId)) return []
  visited.add(rootId)
  const discovered = [rootId]
  const queue = [rootId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const edge of neighbours.get(parentId) ?? []) {
      if (visited.has(edge.other)) continue
      if (opts.onTreeEdge && opts.onTreeEdge(parentId, edge) === false) continue
      visited.add(edge.other)
      discovered.push(edge.other)
      queue.push(edge.other)
    }
  }
  return discovered
}

/**
 * Every part joined to `instanceId` through a chain of mates, INCLUDING itself,
 * in breadth-first order. An unmated part is its own component (`[instanceId]`);
 * an id that is not in `parts` has no component at all (`[]`).
 *
 * This is the physical body a user sees: a mate is a rigid connection, so the
 * component is the set of parts that must move together for every joint in it
 * to survive. Group move, and the load-time re-seat, both mean this by
 * "assembly".
 */
export function connectedComponentOf(
  instanceId: string,
  parts: PartInstanceData[],
  connections: ConnectionMate[],
): string[] {
  if (!parts.some((p) => p.instanceId === instanceId)) return []
  return traverseMateGraph(instanceId, buildMateAdjacency(parts, connections))
}

/**
 * Rebuild every mated part's transform FROM ITS MATES.
 *
 * WHY THIS EXISTS. A project file (and the autosave blob) stores each part's
 * position/rotation verbatim, and `loadProject` used to restore them as-is. So
 * a correction to the seating geometry only ever reached NEW snaps — every
 * scene that already existed kept the poses it was saved with, for ever. After
 * the 2026-07-29 stopping-surface correction that meant a user opening their
 * own robot still saw every pin floating, and no amount of fixing the metadata
 * could reach them. Reported from the deployed site.
 *
 * A mate is the durable fact ("these two features are joined"); the transform
 * is DERIVED from it. So on load we re-derive it through the one shared
 * solver, exactly as if the user had re-snapped every joint by hand.
 *
 * Algorithm: treat the mate graph as an assembly tree. Parts with no mates
 * never move. In each connected component the first part in `parts` order is
 * the anchor (deterministic, and it keeps the scene where the user left it);
 * every other part is placed by the shared `traverseMateGraph` walk from that
 * anchor, child seated onto already-placed parent. A mate whose snap points no
 * longer resolve is skipped rather than guessed at.
 */
export function reseatAssemblyFromMates(
  parts: PartInstanceData[],
  connections: ConnectionMate[],
  opts: { calibration?: PinSeatingCalibration; maxCorrection?: number } = {},
): {
  parts: PartInstanceData[]
  movedCount: number
  maxDelta: number
  /** Parts left at their stored pose because a mate looked deliberate. */
  skippedCount: number
} {
  // A JOIN-IN-PLACE mate is a deliberate record that two parts are connected
  // WHERE THEY ALREADY ARE, even though they do not line up (see the 2026-07-20
  // Joint Mode preservation work). Re-seating those would silently undo the
  // user's intent, so this pass only corrects mates that were CLOSE ENOUGH in
  // the saved file to be a seating error rather than a deliberate misalignment.
  //
  // MEASURE THE MATE, NOT THE MOVE (fixed 2026-08-03). This gate used to
  // compare how far the PART moves, which is wrong in a way that only shows up
  // on deep assemblies: the child is compared against its stored pose while its
  // parent has already been corrected, so the distance ACCUMULATES down the
  // chain. Measured on a beam-pin-beam-pin-beam-pin-beam stack saved before the
  // 2026-08-03 seating corrections, the moves ran 0.0301 / 0.0602 / 0.0903 /
  // 0.1204 — so the third stacked beam tripped the 0.12 cap, kept its stale
  // pose, and every part beyond it was then seated onto a wrong parent. The
  // loader still reported success. (The old comment claimed "every
  // stopping-surface correction in the catalog is <= 0.045"; that stopped being
  // true when the receiver-side correction landed, and it was never the right
  // quantity to bound anyway.)
  //
  // The mate's OWN misalignment in the saved file is depth-independent — the
  // same stack measures 0.03010 on every one of its six mates, at any depth —
  // so it bounds exactly what this gate is trying to detect. `contactGap` (not
  // `mateWorldGap`) because it is the MECHANICAL contact-frame separation,
  // which is 0 for a seated mate by construction; marker distance is a snap
  // ACQUISITION metric and is non-zero on seated deep-socket mates.
  const calibration = opts.calibration ?? SHIPPED_PIN_SEATING_CALIBRATION
  const maxCorrection = opts.maxCorrection ?? calibration.simulatedMoveTolerance
  if (parts.length === 0 || connections.length === 0) {
    return { parts, movedCount: 0, maxDelta: 0, skippedCount: 0 }
  }

  const byId = new Map(parts.map((p) => [p.instanceId, { ...p }]))
  const neighbours = buildMateAdjacency(parts, connections)

  // Misalignment of each mate AS SAVED. Computed once against the untouched
  // `parts`, never against the partially re-seated `byId`, so it cannot pick up
  // a parent's correction.
  const storedMisalignment = new Map<string, number | null>()
  for (const c of connections) {
    storedMisalignment.set(c.id, validateMate(c, parts, calibration).contactGap)
  }

  let movedCount = 0
  let maxDelta = 0
  let skippedCount = 0
  const placed = new Set<string>()

  for (const seed of parts) {
    if (placed.has(seed.instanceId)) continue
    if (!neighbours.has(seed.instanceId)) continue // unmated: never moves
    // One shared `placed` set across every seed, so each component is walked
    // exactly once and the FIRST part in `parts` order anchors it.
    traverseMateGraph(seed.instanceId, neighbours, {
      visited: placed,
      onTreeEdge: (parentId, edge) => {
        const child = byId.get(edge.other)!
        const parent = byId.get(parentId)!
        const childDef = getPartDefinition(child.partId)
        const parentDef = getPartDefinition(parent.partId)
        // Leave the child undiscovered: another mate may still reach it.
        if (!childDef || !parentDef) return false

        // `ownSnapId` on this edge belongs to the PARENT, `otherSnapId` to the
        // child — the edge was pushed from the parent's side.
        const targetSnap = getWorldSnapPoints(parent, parentDef).find(
          (s) => s.id === edge.ownSnapId,
        )
        const sourceSnap = getWorldSnapPoints(child, childDef).find(
          (s) => s.id === edge.otherSnapId,
        )
        if (!targetSnap || !sourceSnap) return false // stale mate — leave the part put

        // Deliberate join-in-place? Judged on how far out THIS mate was in the
        // saved file — a fixed property of the stored data, independent of how
        // deep in the assembly tree the part sits.
        const misalignment = storedMisalignment.get(edge.mate.id) ?? null
        if (misalignment === null || misalignment > maxCorrection) {
          // Deliberate (or unmeasurable) — keep the stored pose, but carry on
          // traversing from where the part actually is.
          skippedCount += 1
          return true
        }

        const solved = computeSnapTransform(child, sourceSnap, targetSnap, {
          parts: [...byId.values()],
          connections,
          calibration: opts.calibration,
        })
        const delta = Math.hypot(
          solved.position[0] - child.position[0],
          solved.position[1] - child.position[1],
          solved.position[2] - child.position[2],
        )
        if (delta > 1e-6) {
          movedCount += 1
          if (delta > maxDelta) maxDelta = delta
        }
        byId.set(child.instanceId, {
          ...child,
          position: solved.position,
          rotation: solved.rotation,
        })
        return true
      },
    })
  }

  return {
    parts: parts.map((p) => byId.get(p.instanceId) ?? p),
    movedCount,
    maxDelta,
    skippedCount,
  }
}
