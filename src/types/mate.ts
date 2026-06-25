// CAD-lite Mate Connector model (Phase 1).
//
// A Mate Connector is a local coordinate frame on a part used by the Advanced
// (CAD-lite) workflow: pick a source connector, pick a target connector, open
// the Mate Editor, then apply a Fastened Mate.
//
// Snap metadata in `snapOverrides.ts` remains the source of truth. Mate
// Connectors are a thin presentation/interaction layer derived from world snap
// points (or created on the fly from a mesh surface pick). They never replace
// `getSnapPoints(def)` or `computeSnapTransform(...)`.

import type { Vec3 } from './assembly'

export type MateConnectorType =
  | 'hole'
  | 'pin'
  | 'face'
  | 'axle'
  | 'shaft'
  | 'gear'
  | 'wheel'
  | 'electronicsPort'
  | 'surface'
  | 'manual'
  | 'inferred'

export type MateConnectorSource =
  | 'curated'
  | 'snapPoint'
  | 'generated'
  | 'boundsInferred'
  | 'surfacePick'
  | 'manual'
  | 'fallback'

export type MateConnectorQuality =
  | 'verified'
  | 'measured'
  | 'estimated'
  | 'needsCalibration'

/**
 * A local coordinate frame on a part instance, resolved to WORLD space.
 *
 * `axisZ` is the mate/insertion axis (a hole's outward face normal, a pin's
 * shaft direction). `axisX`/`axisY` span the contact plane and give the editor
 * a roll reference. All three are unit vectors and (approximately) orthonormal.
 */
export type MateConnector = {
  id: string
  partInstanceId: string
  // World-space frame.
  origin: Vec3
  axisX: Vec3
  axisY: Vec3
  axisZ: Vec3
  type: MateConnectorType
  source: MateConnectorSource
  quality: MateConnectorQuality
  compatibleWith: MateConnectorType[]
  // Present when this connector came from an existing snap point. Required for a
  // stored, save/load-able mate (and occupancy). Surface/manual picks omit it.
  snapId?: string
  // Shared physical occupancy key (front/back faces of one through-hole).
  occupancyGroup?: string
  label?: string
  /**
   * Optional pointer to the connector this manual/calibrated connector is
   * intended to replace. Lets saved corrections override approximate generated
   * connectors without changing the original snap metadata.
   */
  replacesConnectorId?: string
}

/** A reusable connector frame in PART-LOCAL coordinates. */
export type MateConnectorDefinition = {
  id: string
  origin: Vec3
  axisX?: Vec3
  axisY?: Vec3
  axisZ: Vec3
  type: MateConnectorType
  compatibleWith: MateConnectorType[]
  quality: MateConnectorQuality
  source: Exclude<MateConnectorSource, 'surfacePick'>
  snapId?: string
  occupancyGroup?: string
  label?: string
  replacesConnectorId?: string
}

export type MateConnectorFallbackFrame = {
  /** Part-local connector origin. */
  origin: Vec3
  /** Part-local frame axes. */
  xAxis?: Vec3
  yAxis?: Vec3
  zAxis?: Vec3
  quaternion?: [number, number, number, number]
}

/**
 * Project-persisted connector identity + fallback frame. This makes mates
 * survive when the endpoint is manual, surface-picked, generated, or no longer
 * resolvable from the current connector library.
 */
export type MateConnectorProjectRef = {
  connectorId: string
  partInstanceId: string
  partDefId?: string
  snapId?: string
  source: MateConnectorSource
  quality: MateConnectorQuality
  type: MateConnectorType
  compatibleWith: MateConnectorType[]
  fallbackFrame?: MateConnectorFallbackFrame
  manualConnectorId?: string
  occupancyGroup?: string
  label?: string
}

/** A picked connector together with the part it belongs to. */
export type MatePick = {
  instanceId: string
  connector: MateConnector
}

/** Tunable parameters for a Fastened Mate, edited in the Mate Editor. */
export type FastenedMateParams = {
  // Planar offsets in the target connector frame (world units).
  offsetX: number
  offsetY: number
  // Offset along the mate axis (world units), in addition to targetGap.
  offsetZ: number
  // Roll about the mate axis (degrees).
  rollDeg: number
  // Invert the primary (axis) alignment: face-to-face vs. same-direction.
  flipPrimary: boolean
  // Invert the secondary (up) alignment: 180° roll reference flip.
  flipSecondary: boolean
  // Desired separation along the mate axis (world units).
  targetGap: number
}

export const DEFAULT_FASTENED_MATE_PARAMS: FastenedMateParams = {
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  rollDeg: 0,
  flipPrimary: false,
  flipSecondary: false,
  targetGap: 0,
}

/** A persisted calibration for a source/target connector combination. */
export type CalibrationRecord = {
  id: string
  // Human-readable identity of the source connector.
  sourcePartNumber?: string
  sourcePartName: string
  sourceProfileKey?: string
  sourceConnectorId: string
  // Human-readable identity of the target connector.
  targetPartNumber?: string
  targetPartName: string
  targetProfileKey?: string
  targetConnectorId: string
  mateType: 'fastened'
  offsetX: number
  offsetY: number
  offsetZ: number
  rollDeg: number
  flipPrimary: boolean
  flipSecondary: boolean
  targetGap: number
  createdAt: number
  updatedAt: number
}
