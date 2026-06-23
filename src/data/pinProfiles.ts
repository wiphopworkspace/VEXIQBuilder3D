import type {
  PartDefinition,
  SnapPointDefinition,
  SnapPointType,
  Vec3,
} from '../types/assembly'
import { PIN_CLEARANCE, SNAP_CALIBRATION } from './snapCalibration'

export type PinConnectorFamily =
  | 'connector-pin'
  | 'capped-connector-pin'
  | 'idler-pin'
  | 'unknown-pin'

export type PinMetadataQuality =
  | 'curated'
  | 'measured'
  | 'estimated'
  | 'needs-calibration'

export type PinProfileEnd = {
  id: string
  label: string
  position: Vec3
  axis: Vec3
  seatPlanePosition: Vec3
  seatPlaneNormal: Vec3
  compatibleWith: SnapPointType[]
  // VEX IQ plastic layers this side passes through (cap side = 0).
  usableLayers?: number
  seatClearance?: number
  finalSeatAdjustment?: number
  sourceSideSeatAdjustment?: number
  targetSideSeatAdjustment?: number
}

export type PinProfile = {
  key: string
  displayName: string
  family: PinConnectorFamily
  metadataQuality: PinMetadataQuality
  // True for cap/flange pins (0xN) that only insert on one side.
  capped?: boolean
  match: {
    partNumbers?: string[]
    nameIncludes?: string[]
    idIncludes?: string[]
  }
  localAxis: Vec3
  beamToBeamFaceClearance: number
  curatedNeedsReview?: boolean
  notes?: string[]
  ends: PinProfileEnd[]
  intermediate?: Array<{
    id: string
    type: SnapPointType
    position: Vec3
    axis: Vec3
  }>
}

const PIN_SEAT = SNAP_CALIBRATION.defaultPinSeatOffset
const COMPATIBLE_HOLE: SnapPointType[] = ['hole']

function profileBeamClearance(key: string): number {
  switch (key) {
    case 'pin1x1':
      return PIN_CLEARANCE.pin1x1.beamToBeamFaceClearance
    case 'pin1x2':
      return PIN_CLEARANCE.pin1x2.beamToBeamFaceClearance
    case 'pin0x2':
      return PIN_CLEARANCE.pin0x2.beamToBeamFaceClearance
    case 'pin0x3':
      return PIN_CLEARANCE.pin0x3.beamToBeamFaceClearance
    default:
      return PIN_CLEARANCE.defaultBeamToBeamFaceClearance
  }
}

function end(
  id: 'pin-front' | 'pin-back',
  label: string,
  seatZ: number,
  axisZ: -1 | 1,
  finalSeatAdjustment: number,
  usableLayers: number,
): PinProfileEnd {
  const axis: Vec3 = [0, 0, axisZ]
  const position: Vec3 = [0, 0, seatZ + axisZ * PIN_SEAT]
  const seatPlanePosition: Vec3 = [0, 0, seatZ]
  return {
    id,
    label,
    position,
    axis,
    seatPlanePosition,
    seatPlaneNormal: axis,
    compatibleWith: COMPATIBLE_HOLE,
    usableLayers,
    seatClearance: SNAP_CALIBRATION.pinFaceClearance,
    finalSeatAdjustment,
    sourceSideSeatAdjustment: finalSeatAdjustment,
    targetSideSeatAdjustment: finalSeatAdjustment,
  }
}

function twoEndedProfile(opts: {
  key: string
  displayName: string
  partNumbers: string[]
  nameIncludes: string[]
  idIncludes?: string[]
  family: PinConnectorFamily
  metadataQuality: PinMetadataQuality
  // Measured flange/seat plane Z per side (defaults to ∓seatSpacing about 0).
  seatSpacing?: number
  frontSeatZ?: number
  backSeatZ?: number
  frontLayers: number
  backLayers: number
  finalSeatAdjustmentFront: number
  finalSeatAdjustmentBack: number
  curatedNeedsReview?: boolean
  notes?: string[]
}): PinProfile {
  const spacing = opts.seatSpacing ?? 0
  const frontSeatZ = opts.frontSeatZ ?? -spacing
  const backSeatZ = opts.backSeatZ ?? spacing
  return {
    key: opts.key,
    displayName: opts.displayName,
    family: opts.family,
    metadataQuality: opts.metadataQuality,
    match: {
      partNumbers: opts.partNumbers,
      nameIncludes: opts.nameIncludes,
      idIncludes: opts.idIncludes,
    },
    localAxis: [0, 0, 1],
    beamToBeamFaceClearance: profileBeamClearance(opts.key),
    curatedNeedsReview: opts.curatedNeedsReview,
    notes: opts.notes,
    ends: [
      end('pin-front', 'Front seat', frontSeatZ, -1, opts.finalSeatAdjustmentFront, opts.frontLayers),
      end('pin-back', 'Back seat', backSeatZ, 1, opts.finalSeatAdjustmentBack, opts.backLayers),
    ],
  }
}

/**
 * Capped connector pins (0x2, 0x3): a flange/cap on one end that does NOT enter a
 * hole, plus a single shaft that inserts the other way through N layers. Modeled
 * with one insert end whose seat plane is the cap's inner face; the insert axis
 * is +Z so the shared 'same'-mode alignment drives the shaft into the beam and
 * leaves the cap OUTSIDE the face. Marked needs-calibration until visually
 * confirmed (the cap-face depth is bin-approximate from the GLB profiler).
 */
function cappedProfile(opts: {
  key: string
  displayName: string
  partNumbers: string[]
  nameIncludes: string[]
  capInnerZ: number
  usableLayers: number
  notes?: string[]
}): PinProfile {
  return {
    key: opts.key,
    displayName: opts.displayName,
    family: 'capped-connector-pin',
    metadataQuality: 'needs-calibration',
    capped: true,
    match: { partNumbers: opts.partNumbers, nameIncludes: opts.nameIncludes },
    localAxis: [0, 0, 1],
    beamToBeamFaceClearance: profileBeamClearance(opts.key),
    curatedNeedsReview: true,
    notes: opts.notes,
    // Single insert end. Id stays 'pin-front' for save/load compatibility, but
    // the label makes clear a capped pin has ONE insert side and one fixed cap.
    ends: [
      end('pin-front', 'Insert end (capped shaft)', opts.capInnerZ, 1, 0, opts.usableLayers),
    ],
  }
}

export const PIN_PROFILES: PinProfile[] = [
  twoEndedProfile({
    key: 'pin1x1',
    displayName: '1x1 Connector Pin',
    partNumbers: ['228-2500-060', '228-2500-2260'],
    nameIncludes: ['1x1', 'pin'],
    family: 'connector-pin',
    metadataQuality: 'curated',
    seatSpacing: 0,
    frontLayers: 1,
    backLayers: 1,
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin1x1.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin1x1.backFinalSeatAdjustment,
    notes: [
      'converted GLB shaft measured along local Z',
      'central flange measured at z=0 (symmetric, one layer each side)',
    ],
  }),
  twoEndedProfile({
    key: 'pin2x2',
    displayName: '2x2 Connector Pin',
    partNumbers: ['228-2500-062'],
    nameIncludes: ['2x2', 'pin'],
    family: 'connector-pin',
    metadataQuality: 'measured',
    seatSpacing: 0,
    frontLayers: 2,
    backLayers: 2,
    // Measured central flange at z=0 with shafts to ±0.47 — identical seat model
    // to the calibrated 1x1, just longer shafts (two layers each side).
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin1x1.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin1x1.backFinalSeatAdjustment,
    notes: [
      'measured central flange at z=0; shafts extend to ±0.47',
      'seat model identical to the calibrated 1x1; longer shafts only',
    ],
  }),
  twoEndedProfile({
    key: 'pin1x2',
    displayName: '1x2 Connector Pin',
    partNumbers: ['228-2500-061', '228-2500-2261', '228-2500-098'],
    nameIncludes: ['1x2', 'pin'],
    family: 'connector-pin',
    metadataQuality: 'measured',
    // Measured flange off-centre at z≈-0.12 (1-layer side -Z, 2-layer side +Z),
    // replacing the previous symmetric ±0.25 half-pitch guess.
    frontSeatZ: -0.122,
    backSeatZ: -0.122,
    frontLayers: 1,
    backLayers: 2,
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin1x2.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin1x2.backFinalSeatAdjustment,
    curatedNeedsReview: true,
    notes: [
      'measured flange off-centre at z≈-0.12; seat plane uses the measured flange',
      'final seated depth still needs a visual review',
    ],
  }),
  // Spherical-cap variant must be matched BEFORE the flat 0x2 (whose nameIncludes
  // ['0x2','pin'] would otherwise catch it) — its cap geometry/depth differs.
  cappedProfile({
    key: 'pin0x2SphericalCap',
    displayName: '0x2 Connector Pin with Spherical Cap',
    partNumbers: ['228-2500-090'],
    nameIncludes: ['spherical', 'pin'],
    capInnerZ: -0.13,
    usableLayers: 2,
    notes: [
      'measured spherical cap on the -Z end (different depth from the flat 0x2)',
      'spherical cap seat is approximate — needs visual calibration',
    ],
  }),
  cappedProfile({
    key: 'pin0x2',
    displayName: '0x2 Connector Pin',
    partNumbers: ['228-2500-086', '228-2500-084', '228-2500-2258'],
    nameIncludes: ['0x2', 'pin'],
    capInnerZ: -0.19,
    usableLayers: 2,
    notes: [
      'measured cap disk at z≈-0.22 (-Z end); single shaft inserts +Z through 2 layers',
      'cap is not hole-compatible; cap-face depth needs visual calibration',
    ],
  }),
  cappedProfile({
    key: 'pin0x3',
    displayName: '0x3 Connector Pin',
    partNumbers: ['228-2500-087', '228-2500-097', '228-2500-085'],
    nameIncludes: ['0x3', 'pin'],
    capInnerZ: -0.30,
    usableLayers: 3,
    notes: [
      'measured cap disk at z≈-0.34 (-Z end); single shaft inserts +Z through 3 layers',
      'cap is not hole-compatible; cap-face depth needs visual calibration',
    ],
  }),
]

function lowerText(def: PartDefinition): string {
  return `${def.id} ${def.name} ${def.partNumber ?? ''}`.toLowerCase()
}

function includesAll(text: string, terms: string[] | undefined): boolean {
  return !!terms?.length && terms.every((term) => text.includes(term))
}

/**
 * Idler pins are smooth/free-spinning, not flanged connector pins. When an idler
 * happens to match a connector profile (so it stays usable), present it as
 * needs-calibration so the UI never claims a confident 'measured' connector
 * profile for a part whose real geometry hasn't been verified as a connector.
 */
function withIdlerQuality(text: string, profile: PinProfile): PinProfile {
  if (!text.includes('idler')) return profile
  if (
    profile.metadataQuality === 'needs-calibration' &&
    profile.curatedNeedsReview
  ) {
    return profile
  }
  return {
    ...profile,
    metadataQuality: 'needs-calibration',
    curatedNeedsReview: true,
  }
}

export function matchPinProfile(def: PartDefinition): PinProfile | null {
  const text = lowerText(def)
  for (const profile of PIN_PROFILES) {
    if (
      def.partNumber &&
      profile.match.partNumbers?.includes(def.partNumber)
    ) {
      return withIdlerQuality(text, profile)
    }
    if (includesAll(text, profile.match.idIncludes)) {
      return withIdlerQuality(text, profile)
    }
    if (includesAll(text, profile.match.nameIncludes)) {
      return withIdlerQuality(text, profile)
    }
  }
  return null
}

export function pinProfileToSnapPoints(
  profile: PinProfile,
): SnapPointDefinition[] {
  const snaps: SnapPointDefinition[] = profile.ends.map((profileEnd) => ({
    id: profileEnd.id,
    type: 'pin',
    role: 'insert',
    position: profileEnd.position,
    axis: profileEnd.axis,
    normal: profileEnd.axis,
    mateFrame: {
      position: profileEnd.position,
      axis: profileEnd.axis,
      up: [0, 1, 0],
    },
    seatFrame: {
      position: profileEnd.seatPlanePosition,
      axis: profileEnd.seatPlaneNormal,
      up: [0, 1, 0],
    },
    seatPosition: profileEnd.seatPlanePosition,
    alignMode: 'same',
    insertionDepth: SNAP_CALIBRATION.defaultPinInsertionDepth,
    finalSeatAdjustment: profileEnd.finalSeatAdjustment,
    sourceSideSeatAdjustment: profileEnd.sourceSideSeatAdjustment,
    targetSideSeatAdjustment: profileEnd.targetSideSeatAdjustment,
    seatOffset: 0,
    pinProfileKey: profile.key,
    pinProfileDisplayName: profile.displayName,
    curatedNeedsReview: profile.curatedNeedsReview,
    compatibleWith: profileEnd.compatibleWith,
    approximate: profile.curatedNeedsReview,
  }))

  for (const intermediate of profile.intermediate ?? []) {
    snaps.push({
      id: intermediate.id,
      type: intermediate.type,
      role: 'center',
      position: intermediate.position,
      axis: intermediate.axis,
      normal: intermediate.axis,
      mateFrame: {
        position: intermediate.position,
        axis: intermediate.axis,
        up: [0, 1, 0],
      },
      pinProfileKey: profile.key,
      pinProfileDisplayName: profile.displayName,
      curatedNeedsReview: profile.curatedNeedsReview,
      compatibleWith: ['hole'],
      approximate: profile.curatedNeedsReview,
    })
  }

  return snaps
}

export function pinProfileSnapPointsForKey(
  key: string,
): SnapPointDefinition[] | null {
  const profile = PIN_PROFILES.find((p) => p.key === key)
  return profile ? pinProfileToSnapPoints(profile) : null
}
