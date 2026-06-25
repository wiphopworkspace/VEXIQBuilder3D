// Central Mate Connector resolver for the CAD-lite Advanced workflow.
//
// Auto Snap / Joint Mode / Pin Mode still use `getSnapPoints(def)` and
// `computeSnapTransform(...)`. This file builds a richer, quality-labelled
// connector layer for picking/editing mates in Advanced Mode.

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
  MateConnectorDefinition,
  MateConnectorFallbackFrame,
  MateConnectorQuality,
  MateConnectorProjectRef,
  MateConnectorSource,
  MateConnectorType,
} from '../types/mate'
import { getMateConnectorOverrideDefinitions } from '../data/mateConnectorOverrides'
import { manualMateConnectorDefinitionsForPart } from '../data/manualMateConnectors'
import { getWorldSnapPoints } from './snap'

function vec(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z]
}

function connectorTypesForSnap(snap: RuntimeSnapPoint): MateConnectorType {
  switch (snap.type) {
    case 'hole':
    case 'axleHole':
      return 'hole'
    case 'pin':
    case 'connector':
      return 'pin'
    case 'axle':
      return 'axle'
    case 'motorShaft':
      return 'shaft'
    case 'wheelCenter':
      return 'wheel'
    case 'gearCenter':
      return 'gear'
    default:
      return 'inferred'
  }
}

function snapSourceToConnectorSource(snap: RuntimeSnapPoint): MateConnectorSource {
  switch (snap.snapSource) {
    case 'curated':
    case 'partDefinition':
      return 'snapPoint'
    case 'generatedFallback':
      return 'generated'
    case 'boundsInferred':
      return 'boundsInferred'
    default:
      return 'generated'
  }
}

function snapQuality(snap: RuntimeSnapPoint): MateConnectorQuality {
  if (snap.snapSource === 'curated') {
    return snap.curatedNeedsReview || snap.approximate
      ? 'needsCalibration'
      : 'verified'
  }
  if (snap.snapSource === 'partDefinition') {
    return snap.approximate ? 'needsCalibration' : 'measured'
  }
  if (snap.snapSource === 'generatedFallback') return 'estimated'
  if (snap.snapSource === 'boundsInferred') return 'needsCalibration'
  return snap.approximate ? 'needsCalibration' : 'estimated'
}

/** Compatibility classes for the manual CAD-lite Mate tool. */
export function compatibleConnectorTypes(
  type: MateConnectorType,
): MateConnectorType[] {
  switch (type) {
    case 'hole':
      return ['pin', 'axle', 'shaft', 'surface', 'manual', 'face']
    case 'pin':
      return ['hole', 'surface', 'manual', 'face']
    case 'axle':
      return ['hole', 'wheel', 'gear', 'shaft', 'manual']
    case 'shaft':
      return ['hole', 'wheel', 'gear', 'axle', 'manual']
    case 'wheel':
    case 'gear':
      return ['axle', 'shaft', 'manual']
    case 'electronicsPort':
      return ['electronicsPort', 'manual', 'surface']
    case 'face':
    case 'surface':
    case 'manual':
    case 'inferred':
    default:
      return [
        'hole',
        'pin',
        'face',
        'axle',
        'shaft',
        'gear',
        'wheel',
        'electronicsPort',
        'surface',
        'manual',
        'inferred',
      ]
  }
}

export function connectorsCompatible(
  a: MateConnector,
  b: MateConnector,
): boolean {
  return (
    a.compatibleWith.includes(b.type) ||
    b.compatibleWith.includes(a.type)
  )
}

export function qualityRank(quality: MateConnectorQuality): number {
  switch (quality) {
    case 'verified':
      return 0
    case 'measured':
      return 1
    case 'estimated':
      return 2
    case 'needsCalibration':
      return 3
    default:
      return 3
  }
}

function sourceRank(source: MateConnectorSource): number {
  switch (source) {
    case 'curated':
      return 0
    case 'snapPoint':
      return 1
    case 'manual':
      return 1.5
    case 'generated':
      return 2
    case 'boundsInferred':
      return 3
    case 'surfacePick':
      return 4
    case 'fallback':
      return 5
    default:
      return 4
  }
}

export function connectorConfidenceLabel(connector: MateConnector): string {
  if (connector.quality === 'needsCalibration') return 'Needs Calibration'
  return connector.quality[0].toUpperCase() + connector.quality.slice(1)
}

/** Lower score is better for picking / tie-breaking. */
export function mateConnectorScore(
  connector: MateConnector,
  options: {
    distance?: number
    source?: MateConnector | null
    occupied?: boolean
    facingDot?: number
  } = {},
): number {
  const distance = options.distance ?? 0
  const compatibilityPenalty =
    options.source && !connectorsCompatible(options.source, connector)
      ? 10
      : 0
  const occupiedPenalty = options.occupied ? 4 : 0
  const facingPenalty =
    options.facingDot === undefined
      ? 0
      : (1 - Math.min(1, Math.abs(options.facingDot))) * 0.05
  return (
    distance +
    qualityRank(connector.quality) * 0.15 +
    sourceRank(connector.source) * 0.05 +
    compatibilityPenalty +
    occupiedPenalty +
    facingPenalty
  )
}

function transformForInstance(
  instance: PartInstanceData,
  object3D?: THREE.Object3D,
): { matrix: THREE.Matrix4; quaternion: THREE.Quaternion; inverse: THREE.Matrix4 } {
  const matrix = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const inverse = new THREE.Matrix4()
  if (object3D) {
    object3D.updateMatrixWorld(true)
    matrix.copy(object3D.matrixWorld)
    object3D.getWorldQuaternion(quaternion)
  } else {
    matrix.compose(
      new THREE.Vector3(...instance.position),
      quaternion.setFromEuler(new THREE.Euler(...instance.rotation)),
      new THREE.Vector3(...instance.scale),
    )
  }
  inverse.copy(matrix).invert()
  return { matrix, quaternion, inverse }
}

/**
 * Build an orthonormal world frame from a primary axis (`z`) and an optional up
 * hint. Returns unit, approximately orthogonal x/y/z.
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

function connectorFromDefinition(
  instance: PartInstanceData,
  definition: MateConnectorDefinition,
  object3D?: THREE.Object3D,
): MateConnector {
  const { matrix, quaternion } = transformForInstance(instance, object3D)
  const origin = new THREE.Vector3(...definition.origin).applyMatrix4(matrix)
  const z = new THREE.Vector3(...definition.axisZ)
    .applyQuaternion(quaternion)
    .normalize()
  const yHint = definition.axisY
    ? new THREE.Vector3(...definition.axisY).applyQuaternion(quaternion)
    : undefined
  const frame = orthoFrame(z, yHint)
  return {
    id: definition.id,
    partInstanceId: instance.instanceId,
    origin: vec(origin),
    axisX: definition.axisX
      ? vec(
          new THREE.Vector3(...definition.axisX)
            .applyQuaternion(quaternion)
            .normalize(),
        )
      : vec(frame.x),
    axisY: vec(frame.y),
    axisZ: vec(frame.z),
    type: definition.type,
    source: definition.source,
    quality: definition.quality,
    compatibleWith: definition.compatibleWith,
    snapId: definition.snapId,
    occupancyGroup: definition.occupancyGroup,
    label: definition.label ?? definition.id,
    replacesConnectorId: definition.replacesConnectorId,
  }
}

function connectorFromFallbackFrame(
  instance: PartInstanceData,
  ref: MateConnectorProjectRef,
): MateConnector | null {
  const frame = ref.fallbackFrame
  if (!frame) return null
  const { matrix, quaternion } = transformForInstance(instance)
  const origin = new THREE.Vector3(...frame.origin).applyMatrix4(matrix)
  let z = frame.zAxis
    ? new THREE.Vector3(...frame.zAxis)
    : new THREE.Vector3(0, 0, 1)
  if (frame.quaternion) {
    z = new THREE.Vector3(0, 0, 1).applyQuaternion(
      new THREE.Quaternion(...frame.quaternion),
    )
  }
  z.applyQuaternion(quaternion).normalize()
  const yHint = frame.yAxis
    ? new THREE.Vector3(...frame.yAxis).applyQuaternion(quaternion)
    : undefined
  const built = orthoFrame(z, yHint)
  const x = frame.xAxis
    ? new THREE.Vector3(...frame.xAxis).applyQuaternion(quaternion).normalize()
    : built.x
  const y = frame.yAxis
    ? new THREE.Vector3(...frame.yAxis).applyQuaternion(quaternion).normalize()
    : built.y
  return {
    id: ref.connectorId,
    partInstanceId: instance.instanceId,
    origin: vec(origin),
    axisX: vec(x),
    axisY: vec(y),
    axisZ: vec(built.z),
    type: ref.type,
    source: 'fallback',
    quality: 'needsCalibration',
    compatibleWith:
      ref.compatibleWith.length > 0
        ? ref.compatibleWith
        : compatibleConnectorTypes(ref.type),
    snapId: ref.snapId,
    occupancyGroup: ref.occupancyGroup,
    label: ref.label ?? `${ref.connectorId} (fallback)`,
  }
}

/** Convert a resolved world snap point into a Mate Connector frame. */
export function snapPointToConnector(
  instanceId: string,
  snap: RuntimeSnapPoint,
): MateConnector {
  const z = snap.worldMateAxis ?? snap.worldAxis ?? new THREE.Vector3(0, 0, 1)
  const frame = orthoFrame(z.clone(), snap.worldMateUp?.clone())
  const type = connectorTypesForSnap(snap)
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
    compatibleWith: compatibleConnectorTypes(type),
    snapId: snap.id,
    occupancyGroup: snap.occupancyGroup,
    label: snap.pinProfileDisplayName ?? snap.id,
  }
}

function mergeConnector(
  out: MateConnector[],
  connector: MateConnector,
): MateConnector[] {
  const replaceId = connector.replacesConnectorId ?? connector.id
  const existingIndex = out.findIndex(
    (c) => c.id === replaceId || c.id === connector.id,
  )
  if (existingIndex === -1) return [...out, connector]

  const existing = out[existingIndex]
  // Curated connector overrides are highest priority. Manual saved corrections
  // can replace snap/generated/bounds connectors, but not curated overrides.
  if (existing.source === 'curated' && connector.source !== 'curated') {
    return out
  }
  const next = [...out]
  next[existingIndex] = {
    ...connector,
    id: connector.replacesConnectorId ? replaceId : connector.id,
  }
  return next
}

/**
 * Central connector resolver.
 *
 * Layer order:
 * 1. Curated connector overrides (`mateConnectorOverrides.ts`)
 * 2. Existing snap points from `getSnapPoints(def)` via `getWorldSnapPoints`
 * 3. Generated VEX patterns already represented by snap metadata
 * 4. Saved manual connector corrections from localStorage
 * 5. Surface-pick fallback is created interactively by `surfaceConnector`
 */
export function getMateConnectorsForPart(
  instance: PartInstanceData,
  definition: PartDefinition,
  object3D?: THREE.Object3D,
): MateConnector[] {
  let out: MateConnector[] = []

  for (const override of getMateConnectorOverrideDefinitions(definition)) {
    out = mergeConnector(out, connectorFromDefinition(instance, override, object3D))
  }

  for (const snap of getWorldSnapPoints(instance, definition, object3D)) {
    out = mergeConnector(out, snapPointToConnector(instance.instanceId, snap))
  }

  for (const manual of manualMateConnectorDefinitionsForPart(definition)) {
    out = mergeConnector(out, connectorFromDefinition(instance, manual, object3D))
  }

  return out.sort((a, b) => mateConnectorScore(a) - mateConnectorScore(b))
}

/** Back-compatible name used by existing components. */
export function connectorsForInstance(
  instance: PartInstanceData,
  definition: PartDefinition,
  object3D?: THREE.Object3D,
): MateConnector[] {
  return getMateConnectorsForPart(instance, definition, object3D)
}

/**
 * Create a temporary surface connector from a raycast hit (point + world
 * normal). Used when the user clicks part geometry away from any connector dot.
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
    quality: 'needsCalibration',
    compatibleWith: compatibleConnectorTypes('surface'),
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
    getMateConnectorsForPart(instance, definition).find(
      (c) => c.id === connectorId,
    ) ?? null
  )
}

export function connectorProjectRef(
  instance: PartInstanceData,
  definition: PartDefinition,
  connector: MateConnector,
): MateConnectorProjectRef {
  const local = connectorToLocalDefinition(instance, connector, {
    id: connector.id,
    label: connector.label,
    quality: connector.quality,
    source: connector.source === 'surfacePick' ? 'manual' : connector.source,
    replacesConnectorId: connector.replacesConnectorId,
  })
  const fallbackFrame: MateConnectorFallbackFrame = {
    origin: local.origin,
    xAxis: local.axisX,
    yAxis: local.axisY,
    zAxis: local.axisZ,
  }
  return {
    connectorId: connector.id,
    partInstanceId: instance.instanceId,
    partDefId: definition.id,
    snapId: connector.snapId,
    source: connector.source,
    quality: connector.quality,
    type: connector.type,
    compatibleWith: connector.compatibleWith,
    fallbackFrame,
    manualConnectorId:
      connector.source === 'manual' || connector.source === 'surfacePick'
        ? connector.id
        : undefined,
    occupancyGroup: connector.occupancyGroup,
    label: connector.label,
  }
}

export function resolveConnectorRef(
  instance: PartInstanceData,
  definition: PartDefinition,
  ref: MateConnectorProjectRef | undefined,
): MateConnector | null {
  if (!ref) return null
  const connectors = getMateConnectorsForPart(instance, definition)
  const byId = connectors.find((c) => c.id === ref.connectorId)
  if (byId) return byId
  if (ref.snapId) {
    const bySnap = connectors.find((c) => c.snapId === ref.snapId)
    if (bySnap) return bySnap
  }
  if (ref.manualConnectorId) {
    const byManual = connectors.find((c) => c.id === ref.manualConnectorId)
    if (byManual) return byManual
  }
  return connectorFromFallbackFrame(instance, ref)
}

export function connectorRefUsesFallback(
  instance: PartInstanceData,
  definition: PartDefinition,
  ref: MateConnectorProjectRef | undefined,
): boolean {
  if (!ref?.fallbackFrame) return false
  const connectors = getMateConnectorsForPart(instance, definition)
  if (connectors.some((c) => c.id === ref.connectorId)) return false
  if (ref.snapId && connectors.some((c) => c.snapId === ref.snapId)) return false
  if (
    ref.manualConnectorId &&
    connectors.some((c) => c.id === ref.manualConnectorId)
  ) {
    return false
  }
  return true
}

/** Convert a WORLD connector frame to a reusable PART-LOCAL definition. */
export function connectorToLocalDefinition(
  instance: PartInstanceData,
  connector: MateConnector,
  options: {
    id?: string
    label?: string
    quality?: MateConnectorQuality
    source?: MateConnectorDefinition['source']
    replacesConnectorId?: string
  } = {},
): MateConnectorDefinition {
  const { inverse, quaternion } = transformForInstance(instance)
  const invQ = quaternion.clone().invert()
  const localOrigin = new THREE.Vector3(...connector.origin).applyMatrix4(inverse)
  const localX = new THREE.Vector3(...connector.axisX)
    .applyQuaternion(invQ)
    .normalize()
  const localY = new THREE.Vector3(...connector.axisY)
    .applyQuaternion(invQ)
    .normalize()
  const localZ = new THREE.Vector3(...connector.axisZ)
    .applyQuaternion(invQ)
    .normalize()
  const id = options.id ?? connector.id
  return {
    id,
    origin: vec(localOrigin),
    axisX: vec(localX),
    axisY: vec(localY),
    axisZ: vec(localZ),
    type: connector.type,
    compatibleWith: connector.compatibleWith,
    quality: options.quality ?? connector.quality,
    source: options.source ?? 'manual',
    snapId: connector.snapId,
    occupancyGroup: connector.occupancyGroup,
    label: options.label ?? connector.label ?? id,
    replacesConnectorId: options.replacesConnectorId ?? connector.replacesConnectorId,
  }
}

export function connectorWithFramePatch(
  connector: MateConnector,
  patch: {
    origin?: Vec3
    axisZ?: Vec3
    rollDeg?: number
    type?: MateConnectorType
    compatibleWith?: MateConnectorType[]
    quality?: MateConnectorQuality
    label?: string
  },
): MateConnector {
  const origin = patch.origin ?? connector.origin
  const z = new THREE.Vector3(...(patch.axisZ ?? connector.axisZ))
  if (z.lengthSq() < 1e-10) z.set(0, 0, 1)
  z.normalize()
  const currentY = new THREE.Vector3(...connector.axisY)
  const frame = orthoFrame(z, currentY)
  const roll = new THREE.Quaternion().setFromAxisAngle(
    frame.z,
    ((patch.rollDeg ?? 0) * Math.PI) / 180,
  )
  const x = frame.x.clone().applyQuaternion(roll).normalize()
  const y = frame.y.clone().applyQuaternion(roll).normalize()
  const type = patch.type ?? connector.type
  return {
    ...connector,
    origin,
    axisX: vec(x),
    axisY: vec(y),
    axisZ: vec(frame.z),
    type,
    compatibleWith: patch.compatibleWith ?? connector.compatibleWith,
    quality: patch.quality ?? connector.quality,
    label: patch.label ?? connector.label,
  }
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

  // 1. Primary alignment: source axis -> desired axis.
  const qAlign = new THREE.Quaternion().setFromUnitVectors(sZ, desiredZ)

  // 2. Secondary (roll reference) alignment: source up -> target up, about axis.
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

  // Apply align -> up -> roll (right-most applied first).
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
