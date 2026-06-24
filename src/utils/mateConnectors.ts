// Mate Connector helpers for the CAD-lite Advanced workflow.
//
// These derive world-space Mate Connector frames from existing snap points and
// implement the manual Fastened Mate transform. This is the ADVANCED manual
// tool only; Auto Snap / Joint Mode / Pin Mode still use `computeSnapTransform`
// and are not touched here.

import * as THREE from 'three'
import type {
  PartDefinition,
  PartInstanceData,
  RuntimeSnapPoint,
  Vec3,
} from '../types/assembly'
import type {
  FastenedMateParams,
  MateConnector,
  MateConnectorQuality,
  MateConnectorSource,
  MateConnectorType,
} from '../types/mate'
import { getWorldSnapPoints } from './snap'

function vec(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z]
}

function snapTypeToConnectorType(snap: RuntimeSnapPoint): MateConnectorType {
  if (snap.type === 'hole' || snap.type === 'axleHole') return 'hole'
  if (snap.type === 'pin' || snap.type === 'connector') return 'pin'
  return 'face'
}

function snapSourceToConnectorSource(snap: RuntimeSnapPoint): MateConnectorSource {
  switch (snap.snapSource) {
    case 'curated':
    case 'partDefinition':
      return 'curated'
    case 'generatedFallback':
      return 'generated'
    case 'boundsInferred':
      return 'boundsInferred'
    default:
      return 'curated'
  }
}

function snapQuality(snap: RuntimeSnapPoint): MateConnectorQuality {
  if (snap.snapSource === 'curated') {
    return snap.curatedNeedsReview ? 'needsCalibration' : 'verified'
  }
  if (snap.snapSource === 'partDefinition') return 'measured'
  if (snap.approximate) return 'needsCalibration'
  if (snap.snapSource === 'generatedFallback') return 'estimated'
  if (snap.snapSource === 'boundsInferred') return 'estimated'
  return 'estimated'
}

/** Permissive compatibility — the manual tool allows most pairings. */
function compatibleTypes(type: MateConnectorType): MateConnectorType[] {
  if (type === 'hole') return ['pin', 'surface', 'manual', 'face']
  if (type === 'pin') return ['hole', 'surface', 'manual', 'face']
  return ['hole', 'pin', 'face', 'surface', 'manual', 'inferred']
}

/**
 * Build an orthonormal world frame from a primary axis (`z`) and an optional up
 * hint. Returns unit, (approximately) orthogonal x/y/z.
 */
function orthoFrame(
  z: THREE.Vector3,
  upHint?: THREE.Vector3,
): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const zz =
    z.lengthSq() > 1e-10 ? z.clone().normalize() : new THREE.Vector3(0, 0, 1)
  let ref =
    upHint && upHint.lengthSq() > 1e-10
      ? upHint.clone().normalize()
      : Math.abs(zz.dot(new THREE.Vector3(0, 1, 0))) < 0.9
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0)
  let x = new THREE.Vector3().crossVectors(ref, zz)
  if (x.lengthSq() < 1e-10) {
    ref = new THREE.Vector3(1, 0, 0)
    x = new THREE.Vector3().crossVectors(ref, zz)
  }
  x.normalize()
  const y = new THREE.Vector3().crossVectors(zz, x).normalize()
  return { x, y, z: zz }
}

/** Convert a resolved world snap point into a Mate Connector frame. */
export function snapPointToConnector(
  instanceId: string,
  snap: RuntimeSnapPoint,
): MateConnector {
  const z = snap.worldMateAxis ?? snap.worldAxis ?? new THREE.Vector3(0, 0, 1)
  const frame = orthoFrame(z.clone(), snap.worldMateUp?.clone())
  const type = snapTypeToConnectorType(snap)
  return {
    id: snap.id,
    partInstanceId: instanceId,
    origin: vec(snap.worldMatePosition),
    axisX: vec(frame.x),
    axisY: vec(frame.y),
    axisZ: vec(frame.z),
    type,
    source: snapSourceToConnectorSource(snap),
    quality: snapQuality(snap),
    compatibleWith: compatibleTypes(type),
    snapId: snap.id,
    occupancyGroup: snap.occupancyGroup,
    label: snap.pinProfileDisplayName ?? snap.id,
  }
}

/** All Mate Connectors for one instance, resolved to world space. */
export function connectorsForInstance(
  instance: PartInstanceData,
  definition: PartDefinition,
  object3D?: THREE.Object3D,
): MateConnector[] {
  return getWorldSnapPoints(instance, definition, object3D).map((s) =>
    snapPointToConnector(instance.instanceId, s),
  )
}

/**
 * Create a temporary surface connector from a raycast hit (point + world
 * normal). Used when the user clicks part geometry away from any snap dot.
 */
export function surfaceConnector(
  instanceId: string,
  worldPoint: THREE.Vector3,
  worldNormal: THREE.Vector3,
): MateConnector {
  const frame = orthoFrame(worldNormal.clone())
  return {
    id: `surface-${Date.now().toString(36)}`,
    partInstanceId: instanceId,
    origin: vec(worldPoint),
    axisX: vec(frame.x),
    axisY: vec(frame.y),
    axisZ: vec(frame.z),
    type: 'surface',
    source: 'surfacePick',
    quality: 'estimated',
    compatibleWith: compatibleTypes('surface'),
    label: 'Surface point',
  }
}

/** Find a connector by id on an instance (re-resolves to current transform). */
export function findConnector(
  instance: PartInstanceData,
  definition: PartDefinition,
  connectorId: string,
): MateConnector | null {
  return (
    connectorsForInstance(instance, definition).find(
      (c) => c.id === connectorId,
    ) ?? null
  )
}

/**
 * Fastened Mate solver (manual Advanced tool).
 *
 * Aligns the moving part's `source` connector frame onto the fixed `target`
 * connector frame, then applies the editor's offset / roll / flip / gap. By
 * default the source axis is aligned ANTI-parallel to the target axis (a pin
 * driving into a hole, or two faces meeting) — `flipPrimary` makes them
 * same-direction. Returns the moving instance's new position + Euler rotation.
 *
 * This intentionally does NOT call `computeSnapTransform`: that pipeline bakes
 * in pin seat depth and beam-to-beam clearance, which would fight the user's
 * explicit gap/offset here. The shared pipeline still governs Auto/Joint/Pin.
 */
export function computeFastenedMateTransform(
  movingInstance: PartInstanceData,
  source: MateConnector,
  target: MateConnector,
  params: FastenedMateParams,
): { position: Vec3; rotation: Vec3 } {
  const pos0 = new THREE.Vector3(...movingInstance.position)
  const q0 = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...movingInstance.rotation),
  )

  const sOrigin = new THREE.Vector3(...source.origin)
  const sZ = new THREE.Vector3(...source.axisZ).normalize()
  const sY = new THREE.Vector3(...source.axisY).normalize()

  const tOrigin = new THREE.Vector3(...target.origin)
  const tX = new THREE.Vector3(...target.axisX).normalize()
  const tY = new THREE.Vector3(...target.axisY).normalize()
  const tZ = new THREE.Vector3(...target.axisZ).normalize()

  // Desired world direction of the moving source axis.
  const desiredZ = params.flipPrimary ? tZ.clone() : tZ.clone().negate()

  // 1. Primary alignment: source axis → desired axis.
  const qAlign = new THREE.Quaternion().setFromUnitVectors(sZ, desiredZ)

  // 2. Secondary (roll reference) alignment: source up → target up, about axis.
  const sYp = sY
    .clone()
    .applyQuaternion(qAlign)
    .projectOnPlane(desiredZ)
  let desiredUp = tY.clone().projectOnPlane(desiredZ)
  if (params.flipSecondary) desiredUp.negate()
  let qUp = new THREE.Quaternion()
  if (sYp.lengthSq() > 1e-8 && desiredUp.lengthSq() > 1e-8) {
    sYp.normalize()
    desiredUp.normalize()
    const cross = new THREE.Vector3().crossVectors(sYp, desiredUp)
    const angle = Math.atan2(cross.dot(desiredZ), sYp.dot(desiredUp))
    qUp = new THREE.Quaternion().setFromAxisAngle(desiredZ, angle)
  }

  // 3. User roll about the axis.
  const qRoll = new THREE.Quaternion().setFromAxisAngle(
    desiredZ,
    (params.rollDeg * Math.PI) / 180,
  )

  // Apply align → up → roll (right-most applied first).
  const qDelta = qRoll.clone().multiply(qUp).multiply(qAlign)
  const newQuat = qDelta.clone().multiply(q0).normalize()

  // Place the source origin: target origin + planar offsets + axial gap. The
  // axial term uses the target's outward normal so positive gap separates.
  const desiredSourceOrigin = tOrigin
    .clone()
    .addScaledVector(tX, params.offsetX)
    .addScaledVector(tY, params.offsetY)
    .addScaledVector(tZ, params.offsetZ + params.targetGap)

  const sourceLocal = sOrigin.clone().sub(pos0).applyQuaternion(qDelta)
  const newPos = desiredSourceOrigin.clone().sub(sourceLocal)

  const euler = new THREE.Euler().setFromQuaternion(newQuat)
  return {
    position: [newPos.x, newPos.y, newPos.z],
    rotation: [euler.x, euler.y, euler.z],
  }
}
