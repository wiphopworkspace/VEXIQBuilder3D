import type {
  PartDefinition,
  SnapPointDefinition,
  SnapPointType,
  Vec3,
} from '../types/assembly'
import { PIN_CLEARANCE, SNAP_CALIBRATION } from './snapCalibration'

export type PinProfileEnd = {
  id: string
  label: string
  position: Vec3
  axis: Vec3
  seatPlanePosition: Vec3
  seatPlaneNormal: Vec3
  compatibleWith: SnapPointType[]
  seatClearance?: number
  finalSeatAdjustment?: number
  sourceSideSeatAdjustment?: number
  targetSideSeatAdjustment?: number
}

export type PinProfile = {
  key: string
  displayName: string
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
const LONG_PIN_SEAT_SPACING = SNAP_CALIBRATION.beamHolePitch / 2
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
    seatClearance: SNAP_CALIBRATION.pinFaceClearance,
    finalSeatAdjustment,
    sourceSideSeatAdjustment: finalSeatAdjustment,
    targetSideSeatAdjustment: finalSeatAdjustment,
  }
}

function twoEndedProfile({
  key,
  displayName,
  partNumbers,
  nameIncludes,
  idIncludes,
  seatSpacing,
  finalSeatAdjustmentFront,
  finalSeatAdjustmentBack,
  curatedNeedsReview,
  notes,
}: {
  key: string
  displayName: string
  partNumbers: string[]
  nameIncludes: string[]
  idIncludes?: string[]
  seatSpacing: number
  finalSeatAdjustmentFront: number
  finalSeatAdjustmentBack: number
  curatedNeedsReview?: boolean
  notes?: string[]
}): PinProfile {
  return {
    key,
    displayName,
    match: {
      partNumbers,
      nameIncludes,
      idIncludes,
    },
    localAxis: [0, 0, 1],
    beamToBeamFaceClearance: profileBeamClearance(key),
    curatedNeedsReview,
    notes,
    ends: [
      end(
        'pin-front',
        'Front seat',
        -seatSpacing,
        -1,
        finalSeatAdjustmentFront,
      ),
      end(
        'pin-back',
        'Back seat',
        seatSpacing,
        1,
        finalSeatAdjustmentBack,
      ),
    ],
  }
}

export const PIN_PROFILES: PinProfile[] = [
  twoEndedProfile({
    key: 'pin1x1',
    displayName: '1x1 Connector Pin',
    partNumbers: ['228-2500-060', '228-2500-2260'],
    nameIncludes: ['1x1', 'pin'],
    seatSpacing: 0,
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin1x1.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin1x1.backFinalSeatAdjustment,
    notes: [
      'converted GLB shaft measured along local Z',
      'two-ended pin with central shoulder/seat frame',
    ],
  }),
  twoEndedProfile({
    key: 'pin1x2',
    displayName: '1x2 Connector Pin',
    partNumbers: ['228-2500-061', '228-2500-2261', '228-2500-098'],
    nameIncludes: ['1x2', 'pin'],
    seatSpacing: LONG_PIN_SEAT_SPACING,
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin1x2.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin1x2.backFinalSeatAdjustment,
    curatedNeedsReview: true,
    notes: [
      'LDCad reference shows a 1.5M pin; seat spacing uses one app half-pitch',
      'needs visual calibration against the converted GLB shoulders',
    ],
  }),
  twoEndedProfile({
    key: 'pin0x2',
    displayName: '0x2 Connector Pin',
    partNumbers: [
      '228-2500-086',
      '228-2500-084',
      '228-2500-090',
      '228-2500-2258',
    ],
    nameIncludes: ['0x2', 'pin'],
    seatSpacing: 0,
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin0x2.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin0x2.backFinalSeatAdjustment,
    curatedNeedsReview: true,
    notes: [
      'LDCad reference identifies a 1M 0x2 pin family',
      'two-ended snap metadata is conservative until visually calibrated',
    ],
  }),
  twoEndedProfile({
    key: 'pin0x3',
    displayName: '0x3 Connector Pin',
    partNumbers: ['228-2500-087', '228-2500-097', '228-2500-085'],
    nameIncludes: ['0x3', 'pin'],
    seatSpacing: LONG_PIN_SEAT_SPACING,
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin0x3.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin0x3.backFinalSeatAdjustment,
    curatedNeedsReview: true,
    notes: [
      'LDCad reference identifies a 1.5M 0x3 pin family',
      'seat spacing uses one app half-pitch and needs visual review',
    ],
  }),
]

function lowerText(def: PartDefinition): string {
  return `${def.id} ${def.name} ${def.partNumber ?? ''}`.toLowerCase()
}

function includesAll(text: string, terms: string[] | undefined): boolean {
  return !!terms?.length && terms.every((term) => text.includes(term))
}

export function matchPinProfile(def: PartDefinition): PinProfile | null {
  const text = lowerText(def)
  for (const profile of PIN_PROFILES) {
    if (
      def.partNumber &&
      profile.match.partNumbers?.includes(def.partNumber)
    ) {
      return profile
    }
    if (includesAll(text, profile.match.idIncludes)) return profile
    if (includesAll(text, profile.match.nameIncludes)) return profile
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
