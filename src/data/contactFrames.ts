/**
 * Mechanical contact frames for pin-family snap endpoints.
 *
 * The app distinguishes FIVE things that used to blur together. Keep them
 * separate — every historical seating bug came from treating two of them as
 * one value:
 *
 *   1. VISUAL MARKER      `snap.position` — where the clickable dot is drawn.
 *   2. SNAP ACQUISITION   marker-to-marker distance, used only to FIND a
 *                         candidate within the search radius.
 *   3. MECHANICAL CONTACT the plane that physically touches: a pin's
 *      PLANE            shoulder/cap, a receiver's outer face or internal
 *                         seating plane. For a deep socket this is NOT the
 *                         marker (the Smart Motor socket marker is the MOUTH,
 *                         0.232 above its seated plane).
 *   4. SEATED POSE        the transform that puts (3) of both endpoints
 *                         together plus the calibrated offset.
 *   5. VALIDATION         how far (3) may drift before a mate is stretched or
 *      TOLERANCE          broken — see `seatingCalibration.ts`.
 *
 * This module exposes (3) explicitly so seating, validation, the inventory
 * report and the debug overlay all read ONE description instead of each
 * re-deriving contact depth from scattered optional fields.
 */
import type {
  PartDefinition,
  SnapMetadataSource,
  SnapPointDefinition,
  SnapPointType,
  Vec3,
} from '../types/assembly'
import { NON_MECHANICAL_REGIONS, getSnapPoints } from './snapOverrides'
import { matchPinProfile } from './pinProfiles'
import { SNAP_CALIBRATION } from './snapCalibration'

/** Which side of a mechanical connection an endpoint plays. */
export type ContactRole = 'insert' | 'receive'

/** Family of a pin-side endpoint. Drives the report and the test matrix. */
export type PinConnectorFamily =
  | 'connector-pin' // 1x1 / 2x2 / 3x3 / 1x2 — flanged, two-ended
  | 'capped-pin' // 0x2 / 0x3 — cap outside, single shaft in
  | 'idler-pin' // smooth, free-spinning
  | 'corner-connector-peg' // moulded peg on a corner connector body
  | 'standoff-pin' // standoff / extender end pins
  | 'barrel-connector' // shaft bushing barrel and similar
  | 'sheet-pin'
  | 'unclassified-pin'

/** Family of a receiving endpoint. */
export type ReceiverFamily =
  | 'beam-plate-hole' // staggered grid through-hole on a rect beam/plate
  | 'measured-hole' // mesh-measured through-hole on a specialty part
  | 'electronics-mount' // motor / brain / sensor mechanical mounting hole
  | 'corner-connector-hole'
  | 'unclassified-hole'

/**
 * Explicit mechanical description of one snap endpoint. Every field is
 * derivable from part metadata — nothing here is guessed at runtime.
 */
export type MechanicalContactFrame = {
  snapId: string
  type: SnapPointType
  role: ContactRole
  /** Local-space insertion axis (points INTO the receiver for both sides). */
  insertionAxis: Vec3
  /** Local-space origin of the plane that physically touches. */
  contactPlaneOrigin: Vec3
  /** Local-space outward normal of that plane. */
  contactPlaneNormal: Vec3
  /** Radial centre of the feature (marker position projected on the axis). */
  radialCenter: Vec3
  /** How deep the feature is along the axis (socket depth / part thickness). */
  seatedDepth: number
  /** Allowed axial rotations in degrees; 360 = a single fixed roll. */
  allowedRollStepDeg: number
  /** Calibrated seat offset baked into the part metadata, if any. */
  calibratedSeatOffset: number
  /** Where the contact plane came from — the auditable provenance. */
  contactPlaneSource: 'seatFrame' | 'facePosition' | 'marker'
  occupancyGroup: string
  /** False for declared non-mechanical volumes (Smart Cable ports etc.). */
  mechanical: boolean
  /** Which metadata layer produced this endpoint. */
  metadataSource: SnapMetadataSource
  /**
   * True when the endpoint is a positionally-uncertain fallback
   * (`approximate`, `boundsInferred` or `generatedFallback`). These are
   * deliberately gated out of Basic-Mode Auto Snap and are NOT production
   * mechanical endpoints — the contact inventory reports them but does not
   * fail on them, because their contact plane is a placeholder by design.
   */
  reviewGated: boolean
  pinFamily?: PinConnectorFamily
  receiverFamily?: ReceiverFamily
  /** True when this endpoint's metadata is complete enough to ship. */
  calibrationComplete: boolean
  /** Human-readable reasons `calibrationComplete` is false. */
  issues: string[]
}

const PIN_TYPES: SnapPointType[] = ['pin', 'connector']

export function isPinSideType(type: SnapPointType): boolean {
  return PIN_TYPES.includes(type)
}

export function isPinReceiverType(type: SnapPointType): boolean {
  return type === 'hole'
}

/** True when this endpoint participates in the pin insertion system at all. */
export function isPinSystemEndpoint(snap: SnapPointDefinition): boolean {
  return isPinSideType(snap.type) || isPinReceiverType(snap.type)
}

function vecOf(v: Vec3 | undefined, fallback: Vec3): Vec3 {
  if (!v) return fallback
  const len = Math.hypot(v[0], v[1], v[2])
  if (len < 1e-10) return fallback
  return [v[0] / len, v[1] / len, v[2] / len]
}

function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]]
}

/**
 * Local contact-plane origin. MUST match `localContactPosition` in
 * `utils/snap.ts` — that function is what the solver actually uses, and this
 * description would be a lie if the two diverged. The shared rule: a receiving
 * endpoint contacts on its `facePosition`, an inserting endpoint on its seat
 * frame (shoulder / cap plane).
 */
export function contactPlaneOriginOf(snap: SnapPointDefinition): {
  origin: Vec3
  source: 'seatFrame' | 'facePosition' | 'marker'
} {
  const isReceive = snap.role === 'receive' || snap.type === 'hole'
  if (isReceive) {
    if (snap.facePosition) {
      return { origin: snap.facePosition, source: 'facePosition' }
    }
    return {
      origin: snap.mateFrame?.position ?? snap.position,
      source: 'marker',
    }
  }
  if (snap.seatFrame?.position) {
    return { origin: snap.seatFrame.position, source: 'seatFrame' }
  }
  if (snap.seatPosition) {
    return { origin: snap.seatPosition, source: 'seatFrame' }
  }
  const correction = snap.insertionDepthCorrection ?? 0
  const base = snap.mateFrame?.position ?? snap.position
  if (Math.abs(correction) > 1e-10) {
    const axis = vecOf(
      snap.mateFrame?.axis ?? snap.axis ?? snap.normal,
      [0, 0, 1],
    )
    return {
      origin: [
        base[0] - axis[0] * correction,
        base[1] - axis[1] * correction,
        base[2] - axis[2] * correction,
      ],
      source: 'seatFrame',
    }
  }
  return { origin: base, source: 'marker' }
}

function classifyPinFamily(
  def: PartDefinition,
  snap: SnapPointDefinition,
): PinConnectorFamily {
  if (snap.id.startsWith('peg-')) return 'corner-connector-peg'
  const profile = matchPinProfile(def)
  if (profile) {
    switch (profile.family) {
      case 'connector-pin':
        return 'connector-pin'
      case 'capped-connector-pin':
        return 'capped-pin'
      case 'idler-pin':
        return 'idler-pin'
      default:
        break
    }
  }
  const text = `${def.id} ${def.name}`.toLowerCase()
  if (text.includes('standoff')) return 'standoff-pin'
  if (text.includes('sheet pin')) return 'sheet-pin'
  if (snap.id === 'barrel' || text.includes('bushing')) return 'barrel-connector'
  if (text.includes('idler')) return 'idler-pin'
  return 'unclassified-pin'
}

function classifyReceiverFamily(
  def: PartDefinition,
  snap: SnapPointDefinition,
): ReceiverFamily {
  if (snap.id.startsWith('mhole-')) return 'measured-hole'
  if (snap.id.startsWith('mount-')) return 'electronics-mount'
  if (def.category === 'Electronics') return 'electronics-mount'
  if (/corner/i.test(def.name)) return 'corner-connector-hole'
  if (/^hole-/.test(snap.id)) return 'beam-plate-hole'
  return 'unclassified-hole'
}

/** True when the local point sits inside a declared non-mechanical volume. */
export function insideNonMechanicalVolume(
  def: PartDefinition,
  point: Vec3,
): boolean {
  const key = def.partNumber ?? def.id
  const regions =
    NON_MECHANICAL_REGIONS[key] ?? NON_MECHANICAL_REGIONS[def.id] ?? []
  return regions.some(
    (r) =>
      point[0] >= r.min[0] &&
      point[0] <= r.max[0] &&
      point[1] >= r.min[1] &&
      point[1] <= r.max[1] &&
      point[2] >= r.min[2] &&
      point[2] <= r.max[2],
  )
}

/**
 * Describe one snap endpoint as a mechanical contact frame, or null when the
 * endpoint takes no part in the pin insertion system.
 */
export function describeContactFrame(
  def: PartDefinition,
  snap: SnapPointDefinition,
): MechanicalContactFrame | null {
  if (!isPinSystemEndpoint(snap)) return null

  const isReceive = snap.role === 'receive' || snap.type === 'hole'
  const role: ContactRole = isReceive ? 'receive' : 'insert'
  const insertionAxis = vecOf(
    snap.mateFrame?.axis ?? snap.axis ?? snap.normal,
    [0, 0, 1],
  )
  const { origin, source } = contactPlaneOriginOf(snap)
  // The receiving face's outward normal opposes its inward insertion axis; an
  // inserting endpoint's shoulder faces the way it travels.
  const contactPlaneNormal = isReceive
    ? vecOf(snap.normal, negate(insertionAxis))
    : insertionAxis

  const issues: string[] = []
  if (!snap.axis && !snap.normal && !snap.mateFrame?.axis) {
    issues.push('no insertion axis (axis/normal/mateFrame.axis all missing)')
  }
  if (role === 'insert' && source === 'marker') {
    issues.push(
      'no seat frame — the contact plane falls back to the visual marker',
    )
  }
  if (role === 'receive' && !snap.facePosition) {
    issues.push('no facePosition — the contact plane falls back to the marker')
  }
  if (role === 'receive' && (snap.receivingDepth ?? 0) <= 0) {
    issues.push('no receivingDepth')
  }
  if (!snap.compatibleWith || snap.compatibleWith.length === 0) {
    issues.push('empty compatibleWith')
  }

  const mechanical = !insideNonMechanicalVolume(def, origin)
  if (!mechanical) issues.push('inside a declared non-mechanical region')

  const seatedDepth =
    role === 'receive'
      ? (snap.receivingDepth ?? SNAP_CALIBRATION.beamReceivingDepth)
      : SNAP_CALIBRATION.beamReceivingDepth

  return {
    snapId: snap.id,
    type: snap.type,
    role,
    insertionAxis,
    contactPlaneOrigin: origin,
    contactPlaneNormal,
    radialCenter: snap.mateFrame?.position ?? snap.position,
    seatedDepth,
    allowedRollStepDeg: snap.rollStepDeg ?? 360,
    calibratedSeatOffset:
      snap.sourceSideSeatAdjustment ?? snap.finalSeatAdjustment ?? 0,
    contactPlaneSource: source,
    occupancyGroup: snap.occupancyGroup ?? snap.id,
    mechanical,
    metadataSource: snap.snapSource ?? 'partDefinition',
    reviewGated:
      snap.approximate === true ||
      snap.snapSource === 'boundsInferred' ||
      snap.snapSource === 'generatedFallback',
    pinFamily: role === 'insert' ? classifyPinFamily(def, snap) : undefined,
    receiverFamily:
      role === 'receive' ? classifyReceiverFamily(def, snap) : undefined,
    calibrationComplete: issues.length === 0,
    issues,
  }
}

/** Every pin-system contact frame on a part. */
export function contactFramesForPart(
  def: PartDefinition,
): MechanicalContactFrame[] {
  const out: MechanicalContactFrame[] = []
  for (const snap of getSnapPoints(def)) {
    const frame = describeContactFrame(def, snap)
    if (frame) out.push(frame)
  }
  return out
}
