import type {
  PartCategory,
  ProceduralKind,
  SnapPointDefinition,
  Vec3,
} from '../types/assembly'
import { SNAP_CALIBRATION, beamFaceOffset } from '../data/snapCalibration'

// VEX IQ uses a regular hole pitch. We model 1 hole pitch = 0.5 world units,
// which matches the mm->world scale baked into the converted GLB models.
export const HOLE_PITCH = SNAP_CALIBRATION.beamHolePitch

/**
 * Infer a beam/plate hole count from a part name or id.
 *   "2x6" => 6, "1x10" => 10, "Beam 6" => 6, "Beam 12" => 12, "12x Pitch" => 12.
 * Falls back to 6 when nothing is detected.
 */
export function inferHoleCount(text: string): number {
  const t = text.toLowerCase()
  const grid = t.match(/(\d+)\s*x\s*(\d+)/)
  if (grid) return Math.max(parseInt(grid[1], 10), parseInt(grid[2], 10))
  const beamN = t.match(/beam\s*(\d+)/)
  if (beamN) return parseInt(beamN[1], 10)
  const pitch = t.match(/(\d+)\s*x\s*pitch/)
  if (pitch) return parseInt(pitch[1], 10)
  return 6
}

/** A row of `hole` snap points on both receiving faces. */
export function makeBeamHoles(count: number): SnapPointDefinition[] {
  const holes: SnapPointDefinition[] = []
  const start = -((count - 1) / 2) * HOLE_PITCH
  const z = beamFaceOffset(SNAP_CALIBRATION.defaultBeamHoleDepth)
  const pushHoleFace = (
    i: number,
    position: Vec3,
    axis: Vec3,
    normal: Vec3,
    id = `hole-${i}`,
  ) => {
    holes.push({
      id,
      type: 'hole',
      role: 'receive',
      position,
      axis,
      normal,
      facePosition: position,
      mateFrame: {
        position,
        axis,
        up: [0, 1, 0],
      },
      receivingDepth: SNAP_CALIBRATION.defaultBeamHoleDepth,
      occupancyGroup: `hole-${i}`,
      compatibleWith: ['pin', 'connector'],
      radius: HOLE_PITCH * 0.28,
      approximate: true,
      snapSource: 'generatedFallback',
    })
  }
  for (let i = 0; i < count; i++) {
    const x = start + i * HOLE_PITCH
    pushHoleFace(i, [x, 0, z], [0, 0, -1], [0, 0, 1])
    pushHoleFace(i, [x, 0, -z], [0, 0, 1], [0, 0, -1], `hole-${i}-back`)
  }
  return holes
}

/** Pin mate frames along the shaft axis, facing outward along X. */
export function makePinSnaps(): SnapPointDefinition[] {
  const seat = SNAP_CALIBRATION.defaultPinSeatOffset
  const correction = SNAP_CALIBRATION.pinInsertionDepthCorrection
  const frontFinalSeatAdjustment =
    SNAP_CALIBRATION.pinFrontFinalSeatAdjustment
  const backFinalSeatAdjustment = SNAP_CALIBRATION.pinBackFinalSeatAdjustment
  const frontSeat: Vec3 = [-seat + correction, 0, 0]
  const backSeat: Vec3 = [seat - correction, 0, 0]
  return [
    {
      id: 'pin-front',
      type: 'pin',
      role: 'insert',
      position: [-seat, 0, 0],
      axis: [-1, 0, 0],
      normal: [-1, 0, 0],
      mateFrame: {
        position: [-seat, 0, 0],
        axis: [-1, 0, 0],
        up: [0, 1, 0],
      },
      seatFrame: {
        position: frontSeat,
        axis: [-1, 0, 0],
        up: [0, 1, 0],
      },
      seatPosition: frontSeat,
      alignMode: 'same',
      insertionDepth: SNAP_CALIBRATION.defaultPinInsertionDepth,
      insertionDepthCorrection: correction,
      finalSeatAdjustment: frontFinalSeatAdjustment,
      sourceSideSeatAdjustment: frontFinalSeatAdjustment,
      targetSideSeatAdjustment: frontFinalSeatAdjustment,
      seatOffset: 0,
      compatibleWith: ['hole'],
      approximate: true,
      snapSource: 'generatedFallback',
    },
    {
      id: 'pin-back',
      type: 'pin',
      role: 'insert',
      position: [seat, 0, 0],
      axis: [1, 0, 0],
      normal: [1, 0, 0],
      mateFrame: {
        position: [seat, 0, 0],
        axis: [1, 0, 0],
        up: [0, 1, 0],
      },
      seatFrame: {
        position: backSeat,
        axis: [1, 0, 0],
        up: [0, 1, 0],
      },
      seatPosition: backSeat,
      alignMode: 'same',
      insertionDepth: SNAP_CALIBRATION.defaultPinInsertionDepth,
      insertionDepthCorrection: correction,
      finalSeatAdjustment: backFinalSeatAdjustment,
      sourceSideSeatAdjustment: backFinalSeatAdjustment,
      targetSideSeatAdjustment: backFinalSeatAdjustment,
      seatOffset: 0,
      compatibleWith: ['hole'],
      approximate: true,
      snapSource: 'generatedFallback',
    },
  ]
}

/** Axle snap points along the shaft. Generated VEX GLBs use local Z. */
export function makeAxleSnaps(lengthHoles = 2): SnapPointDefinition[] {
  const count = Math.max(2, Math.round(lengthHoles))
  const half = ((count - 1) * HOLE_PITCH) / 2
  const compatibleWith: SnapPointDefinition['compatibleWith'] = [
    'axleHole',
    'wheelCenter',
    'gearCenter',
    'motorShaft',
  ]
  const out: SnapPointDefinition[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      id: `axle-${i}`,
      type: 'axle',
      position: [0, 0, -half + i * HOLE_PITCH],
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: {
        position: [0, 0, -half + i * HOLE_PITCH],
        axis: [0, 0, 1],
        up: [0, 1, 0],
      },
      compatibleWith,
      radius: HOLE_PITCH * 0.22,
      approximate: true,
      snapSource: 'generatedFallback',
    })
  }
  return out
}

/** A single center snap for wheels/gears that slides onto an axle. */
export function makeCenterSnap(
  type: 'wheelCenter' | 'gearCenter',
): SnapPointDefinition[] {
  return [
    {
      id: 'center',
      type,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: {
        position: [0, 0, 0],
        axis: [0, 0, 1],
        up: [0, 1, 0],
      },
      compatibleWith: ['axle', 'motorShaft'],
      radius: HOLE_PITCH * 0.2,
      approximate: true,
      snapSource: 'generatedFallback',
    },
  ]
}

/** A single motor output shaft. */
export function makeMotorShaftSnap(): SnapPointDefinition[] {
  return [
    {
      id: 'motor-shaft',
      type: 'motorShaft',
      position: [0, 0, HOLE_PITCH * 0.8],
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: {
        position: [0, 0, HOLE_PITCH * 0.8],
        axis: [0, 0, 1],
        up: [0, 1, 0],
      },
      compatibleWith: ['axle', 'gearCenter', 'wheelCenter'],
      radius: HOLE_PITCH * 0.2,
      approximate: true,
      snapSource: 'generatedFallback',
    },
  ]
}

/**
 * Generate fallback snap points for a part that has no manual snap metadata.
 * Driven primarily by the procedural kind (which distinguishes a motor from a
 * generic electronics box), falling back to the broad category.
 */
export function generateSnapPoints(
  category: PartCategory,
  procedural: ProceduralKind,
  holeCount = 6,
): SnapPointDefinition[] {
  switch (procedural) {
    case 'beam':
    case 'plate':
      return makeBeamHoles(holeCount)
    case 'pin':
      return makePinSnaps()
    case 'axle':
      return makeAxleSnaps(holeCount)
    case 'wheel':
      return makeCenterSnap('wheelCenter')
    case 'gear':
      return makeCenterSnap('gearCenter')
    case 'motor':
      return makeMotorShaftSnap()
    default:
      break
  }
  // Procedural kind was generic (box/brain/connector) — use the category.
  switch (category) {
    case 'Beams':
    case 'Plates':
      return makeBeamHoles(holeCount)
    case 'Pins':
      return makePinSnaps()
    case 'Axles':
      return makeAxleSnaps(holeCount)
    case 'Wheels':
      return makeCenterSnap('wheelCenter')
    case 'Gears':
      return makeCenterSnap('gearCenter')
    default:
      // Electronics (non-motor) / Connectors / Game Elements / Misc: no snaps.
      return []
  }
}
