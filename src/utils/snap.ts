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
import { PIN_CLEARANCE, SNAP_CALIBRATION } from '../data/snapCalibration'
import { parseRectPart } from '../data/partFamilies'

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

function worldTargetContactPosition(snap: RuntimeSnapPoint): THREE.Vector3 {
  if (snap.role === 'receive' || snap.type === 'hole') {
    return snap.worldFacePosition?.clone() ?? snap.worldMatePosition.clone()
  }
  return snap.worldSeatPosition?.clone() ?? snap.worldMatePosition.clone()
}

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

function oppositePinSide(snapId: string): string | null {
  if (snapId === 'pin-front') return 'pin-back'
  if (snapId === 'pin-back') return 'pin-front'
  return null
}

function beamToBeamClearanceForPinSnap(snap: SnapPointDefinition): number {
  switch (snap.pinProfileKey) {
    case 'pin1x1':
      return PIN_CLEARANCE.pin1x1.beamToBeamFaceClearance
    case 'pin1x2':
      return PIN_CLEARANCE.pin1x2.beamToBeamFaceClearance
    case 'pin0x2':
      return PIN_CLEARANCE.pin0x2.beamToBeamFaceClearance
    case 'pin0x3':
      return PIN_CLEARANCE.pin0x3.beamToBeamFaceClearance
    default:
      return SNAP_CALIBRATION.beamToBeamFaceClearance
  }
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

function otherMateEndpoint(
  mate: ConnectionMate,
  instanceId: string,
): { instanceId: string; snapId: string } | null {
  if (mate.aInstanceId === instanceId) {
    return { instanceId: mate.bInstanceId, snapId: mate.bSnapId }
  }
  if (mate.bInstanceId === instanceId) {
    return { instanceId: mate.aInstanceId, snapId: mate.aSnapId }
  }
  return null
}

function findMateOnOtherPinSide(
  pinInstanceId: string,
  currentPinSnapId: string,
  connections: ConnectionMate[],
): ConnectionMate | null {
  const opposite = oppositePinSide(currentPinSnapId)
  if (!opposite) return null
  return (
    connections.find(
      (mate) =>
        (mate.aInstanceId === pinInstanceId && mate.aSnapId === opposite) ||
        (mate.bInstanceId === pinInstanceId && mate.bSnapId === opposite),
    ) ?? null
  )
}

type FaceClearanceCorrection = {
  desiredClearance: number
  currentGap: number
  correction: number
  normal: THREE.Vector3
}

function resolveBeamToBeamClearanceCorrection({
  sourceSnap,
  targetSnap,
  sourceQuaternion,
  sourceOrigin,
  targetAxis,
  parts,
  connections,
}: {
  sourceSnap: RuntimeSnapPoint
  targetSnap: RuntimeSnapPoint
  sourceQuaternion: THREE.Quaternion
  sourceOrigin: THREE.Vector3
  targetAxis: THREE.Vector3 | null
  parts?: PartInstanceData[]
  connections?: ConnectionMate[]
}): FaceClearanceCorrection | null {
  if (!parts || !connections || !targetAxis) return null
  if (!isHoleLikeSnap(sourceSnap) || !isPinLikeSnap(targetSnap)) return null

  const oppositeMate = findMateOnOtherPinSide(
    targetSnap.instanceId,
    targetSnap.id,
    connections,
  )
  if (!oppositeMate) return null

  const fixedEndpoint = otherMateEndpoint(oppositeMate, targetSnap.instanceId)
  if (!fixedEndpoint) return null
  const fixedSnap = resolveRuntimeSnap(
    parts,
    fixedEndpoint.instanceId,
    fixedEndpoint.snapId,
  )
  if (!fixedSnap || !isHoleLikeSnap(fixedSnap)) return null

  const normal = targetAxis.clone().normalize()
  if (normal.lengthSq() < 1e-10) return null

  const movingFace = localContactPosition(sourceSnap)
    .applyQuaternion(sourceQuaternion)
    .add(sourceOrigin)
  const fixedFace = worldTargetContactPosition(fixedSnap)
  const currentGap = movingFace.clone().sub(fixedFace).dot(normal)
  const desiredClearance = beamToBeamClearanceForPinSnap(targetSnap)
  const correction = desiredClearance - currentGap

  return {
    desiredClearance,
    currentGap,
    correction,
    normal,
  }
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
): 'same' | 'opposite' {
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
  for (const source of dragged) {
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
 * Compute the new transform for the moving instance so its source contact
 * frame seats on the target receiving frame.
 *
 * - Position: the source seat frame is placed on the target face frame, so a
 *   pin's shoulder/cap can stop at the outside beam face while its shaft cue
 *   still defines the insertion direction.
 * - Orientation: when both snap points carry an `axis` (or legacy `normal`),
 *   the source axis is rotated onto the target axis. `alignMode` controls
 *   whether that means same-direction or opposite-direction alignment. When
 *   either axis is missing, the current rotation is preserved.
 *
 * This is intentionally a single rigid placement — not a constraint solver.
 */
export function computeSnapTransform(
  movingInstance: PartInstanceData,
  sourceSnap: RuntimeSnapPoint,
  targetSnap: RuntimeSnapPoint,
  opts: {
    alignNormals?: boolean
    alignMode?: 'same' | 'opposite'
    debug?: boolean
    parts?: PartInstanceData[]
    connections?: ConnectionMate[]
  } = {},
): { position: Vec3; rotation: Vec3 } {
  const alignNormals = opts.alignNormals ?? true
  const curQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...movingInstance.rotation),
  )
  let newQuat = curQuat.clone()
  let targetAxisForOffset = worldMateAxis(targetSnap)

  if (alignNormals) {
    const srcAxis = worldMateAxis(sourceSnap)
    const tgtAxis = targetAxisForOffset
    if (srcAxis && tgtAxis) {
      const mode = opts.alignMode ?? resolveAlignMode(sourceSnap, targetSnap)
      const desired =
        mode === 'same' ? tgtAxis : tgtAxis.clone().negate().normalize()
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
  const clearanceCorrection = resolveBeamToBeamClearanceCorrection({
    sourceSnap,
    targetSnap,
    sourceQuaternion: newQuat,
    sourceOrigin: newOrigin,
    targetAxis: targetAxisForOffset,
    parts: opts.parts,
    connections: opts.connections,
  })
  if (
    clearanceCorrection &&
    Math.abs(clearanceCorrection.correction) > 1e-10
  ) {
    newOrigin.add(
      clearanceCorrection.normal
        .clone()
        .multiplyScalar(clearanceCorrection.correction),
    )
  }
  if (opts.debug) {
    const finalSourceContact = localContactPosition(sourceSnap)
      .applyQuaternion(newQuat)
      .add(newOrigin)
    const expectedSourceContact = targetContact.clone()
    if (targetAxisForOffset && Math.abs(depth) > 1e-10) {
      expectedSourceContact.add(targetAxisForOffset.clone().multiplyScalar(depth))
    }
    if (clearanceCorrection) {
      expectedSourceContact.add(
        clearanceCorrection.normal
          .clone()
          .multiplyScalar(clearanceCorrection.correction),
      )
    }
    const finalGapEstimate = finalSourceContact.distanceTo(expectedSourceContact)
    const pinBackCorrection =
      sourceSnap.id === 'pin-back'
        ? contributions.source
        : targetSnap.id === 'pin-back'
          ? contributions.target
          : 0
    const correctedFaceGap = clearanceCorrection
      ? clearanceCorrection.currentGap + clearanceCorrection.correction
      : null
    console.debug(
      [
        'Snap depth debug:',
        `source=${sourceSnap.id}`,
        `target=${targetSnap.id}`,
        `sourceType=${sourceSnap.type}`,
        `targetType=${targetSnap.type}`,
        `sourceAdjustment=${contributions.source.toFixed(4)}`,
        `targetAdjustment=${contributions.target.toFixed(4)}`,
        `totalAdjustment=${contributions.total.toFixed(4)}`,
        `pinBackCorrection=${pinBackCorrection.toFixed(4)}`,
        `appliedAsTarget=${targetSnap.id === 'pin-back'}`,
        `axis=${formatDebugVec(targetAxisForOffset)}`,
        `finalGapEstimate=${finalGapEstimate.toFixed(4)}`,
        clearanceCorrection
          ? `interPartClearanceTarget=${clearanceCorrection.desiredClearance.toFixed(4)}`
          : null,
        clearanceCorrection
          ? `currentFaceGap=${clearanceCorrection.currentGap.toFixed(4)}`
          : null,
        clearanceCorrection
          ? `clearanceCorrection=${clearanceCorrection.correction.toFixed(4)}`
          : null,
        correctedFaceGap !== null
          ? `correctedFaceGap=${correctedFaceGap.toFixed(4)}`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  const e = new THREE.Euler().setFromQuaternion(newQuat)
  return {
    position: [newOrigin.x, newOrigin.y, newOrigin.z],
    rotation: [e.x, e.y, e.z],
  }
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

/**
 * Drop mates involving `instanceId` whose two snap points have been pulled
 * farther apart than `maxGap` — i.e. the part was manually moved away and the
 * mate no longer physically holds. Mates that still resolve close together (or
 * that can't be measured) are kept, so a freshly snapped mate (~0 gap) survives.
 */
export function pruneBrokenMatesForInstance(
  instanceId: string,
  parts: PartInstanceData[],
  connections: ConnectionMate[],
  maxGap: number = SNAP_THRESHOLD,
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
