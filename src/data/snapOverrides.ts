import type {
  PartDefinition,
  SnapMetadataSource,
  SnapPointDefinition,
  SnapPointType,
} from '../types/assembly'
import { SNAP_CALIBRATION, beamFaceOffset } from './snapCalibration'
import { HOLE_PITCH } from '../utils/snapPointGenerator'
import { parseRectPart } from './partFamilies'
import { getAuthoredSnapOverride } from './authoredSnapOverrides'
import { getPinSeatOverride, hasAnyPinSeatOverride } from './pinSeatOverrides'
import {
  matchPinProfile,
  pinProfileSnapPointsForKey,
  pinProfileToSnapPoints,
} from './pinProfiles'
import {
  MEASURED_PART_HOLES,
  MEASURED_SUPPLEMENTAL_HOLES,
  type MeasuredHole,
} from './measuredPartHoles'

/**
 * A `width` x `length` grid of beam/plate holes on both receiving faces.
 *
 * Holes are pitch-spaced and centered on the model (matching how GLBs are
 * rendered re-centered on their bounding box). Measured from the GLBs, each
 * in-plane axis spans ≈ count * pitch, so an odd count puts a hole on the
 * centerline and an even count does not — exactly the real VEX IQ layout.
 *
 *   width  = rows along local Y (first number in a "WxL" name)
 *   length = columns along local X (second number)
 *
 * Single-wide parts keep `hole-<col>` ids on the +Z/front face (back-compat
 * with saved projects); the opposite face gets `-back` ids. Both sides share
 * an occupancy group so one physical through-hole cannot be mated twice.
 */
function makeBeamGridOverrides(
  width: number,
  length: number,
  depth: number = SNAP_CALIBRATION.defaultBeamHoleDepth,
): SnapPointDefinition[] {
  const z = beamFaceOffset(depth)
  const out: SnapPointDefinition[] = []
  const oneWide = width === 1
  const holeFace = (
    x: number,
    y: number,
    zPos: number,
    id: string,
    axis: [number, number, number],
    normal: [number, number, number],
    occupancyGroup: string,
  ): SnapPointDefinition => {
    const position: [number, number, number] = [x, y, zPos]
    return {
      id,
      type: 'hole',
      role: 'receive',
      position,
      axis,
      normal,
      facePosition: position,
      mateFrame: { position, axis, up: [0, 1, 0] },
      receivingDepth: depth,
      occupancyGroup,
      compatibleWith: ['pin', 'connector'],
      radius: HOLE_PITCH * 0.28,
    }
  }
  const pushHole = (x: number, y: number, id: string) => {
    out.push(
      holeFace(x, y, z, id, [0, 0, -1], [0, 0, 1], id),
      holeFace(x, y, -z, `${id}-back`, [0, 0, 1], [0, 0, -1], id),
    )
  }

  // Grid A — the standard W x L hole grid (full-pitch spacing, centered).
  for (let r = 0; r < width; r++) {
    const y = (r - (width - 1) / 2) * HOLE_PITCH
    for (let c = 0; c < length; c++) {
      const x = (c - (length - 1) / 2) * HOLE_PITCH
      pushHole(x, y, oneWide ? `hole-${c}` : `hole-${r}-${c}`)
    }
  }

  // Grid B — the half-pitch-offset (W-1) x (L-1) grid sitting at each cell
  // center. Measured from the GLB meshes, real VEX IQ beams/plates carry this
  // interlocking second set of holes (e.g. a 2x6 beam has a 5-hole center row,
  // a 3x3 plate has a 2x2 offset grid). Count = W*L + (W-1)*(L-1).
  for (let r = 0; r < width - 1; r++) {
    const y = (r - (width - 2) / 2) * HOLE_PITCH
    for (let c = 0; c < length - 1; c++) {
      const x = (c - (length - 2) / 2) * HOLE_PITCH
      pushHole(x, y, `hole-mid-${r}-${c}`)
    }
  }

  // 1-wide even-length beams (1x2, 1x4, 1x6, …) carry one extra hole on the
  // centerline — there's no offset row to hold it, but the hole is real.
  if (oneWide && length % 2 === 0) {
    pushHole(0, 0, 'hole-center')
  }

  return out
}

/** Back-compat single-row helper (1 x count). */
function makeBeamHoleOverrides(
  count: number,
  depth: number = SNAP_CALIBRATION.defaultBeamHoleDepth,
): SnapPointDefinition[] {
  return makeBeamGridOverrides(1, count, depth)
}

function makeZAxisPinSeatSnaps(
  approximate = false,
): SnapPointDefinition[] {
  const seat = SNAP_CALIBRATION.defaultPinSeatOffset
  const correction = SNAP_CALIBRATION.pinInsertionDepthCorrection
  const frontFinalSeatAdjustment =
    SNAP_CALIBRATION.pinFrontFinalSeatAdjustment
  const backFinalSeatAdjustment = SNAP_CALIBRATION.pinBackFinalSeatAdjustment
  const frontSeat: [number, number, number] = [0, 0, -seat + correction]
  const backSeat: [number, number, number] = [0, 0, seat - correction]
  return [
    {
      id: 'pin-front',
      type: 'pin',
      role: 'insert',
      position: [0, 0, -seat],
      axis: [0, 0, -1],
      normal: [0, 0, -1],
      mateFrame: {
        position: [0, 0, -seat],
        axis: [0, 0, -1],
        up: [0, 1, 0],
      },
      seatFrame: {
        position: frontSeat,
        axis: [0, 0, -1],
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
      approximate,
    },
    {
      id: 'pin-back',
      type: 'pin',
      role: 'insert',
      position: [0, 0, seat],
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: {
        position: [0, 0, seat],
        axis: [0, 0, 1],
        up: [0, 1, 0],
      },
      seatFrame: {
        position: backSeat,
        axis: [0, 0, 1],
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
      approximate,
    },
  ]
}

function makeAxisSnapSeries(
  count: number,
  axis: [number, number, number],
  point: (offset: number) => [number, number, number],
): SnapPointDefinition[] {
  const snapCount = Math.max(2, Math.round(count))
  const half = ((snapCount - 1) * HOLE_PITCH) / 2
  const compatibleWith: SnapPointDefinition['compatibleWith'] = [
    'axleHole',
    'wheelCenter',
    'gearCenter',
    'motorShaft',
  ]
  return Array.from({ length: snapCount }, (_, i) => {
    const position = point(-half + i * HOLE_PITCH)
    return {
      id: `axle-${i}`,
      type: 'axle',
      role: 'insert',
      position,
      axis,
      normal: axis,
      mateFrame: {
        position,
        axis,
        up: [0, 1, 0],
      },
      compatibleWith,
      radius: HOLE_PITCH * 0.22,
    }
  })
}

function makeXAxisAxleSnaps(count: number): SnapPointDefinition[] {
  return makeAxisSnapSeries(count, [1, 0, 0], (offset) => [offset, 0, 0])
}

function makeZAxisAxleSnaps(count: number): SnapPointDefinition[] {
  return makeAxisSnapSeries(count, [0, 0, 1], (offset) => [0, 0, offset])
}

function makeZAxisCenterSnap(
  type: 'wheelCenter' | 'gearCenter' | 'axleHole',
): SnapPointDefinition[] {
  const seatOffset =
    type === 'wheelCenter'
      ? SNAP_CALIBRATION.wheelCenterSeatOffset
      : type === 'gearCenter'
        ? SNAP_CALIBRATION.gearCenterSeatOffset
        : 0
  return [
    {
      id: 'center',
      type,
      role: 'center',
      position: [0, 0, 0],
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: {
        position: [0, 0, 0],
        axis: [0, 0, 1],
        up: [0, 1, 0],
      },
      alignMode: 'same',
      seatOffset,
      compatibleWith: ['axle', 'motorShaft'],
      radius: HOLE_PITCH * 0.2,
    },
  ]
}

function makeZAxisMotorShaftSnap(): SnapPointDefinition[] {
  return [
    {
      id: 'motor-shaft',
      type: 'motorShaft',
      role: 'insert',
      position: [0, 0, HOLE_PITCH * 0.8],
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: {
        position: [0, 0, HOLE_PITCH * 0.8],
        axis: [0, 0, 1],
        up: [0, 1, 0],
      },
      alignMode: 'same',
      compatibleWith: ['axle', 'gearCenter', 'wheelCenter'],
      radius: HOLE_PITCH * 0.2,
    },
  ]
}

// A layout exposes mount holes on ONE face axis only. Parts whose holes sit on
// several faces (e.g. the Dual Motor Support Cap, which also has holes on its
// top and ends) currently expose just their primary mount face — this is an
// intentional limitation of the single-`faceAxis` model.
type ElectronicsMountLayout = {
  // Half-extent from the center to the mounting face along `faceAxis`. The hole
  // markers sit on that face.
  halfDepth: number
  // In-plane mount positions. The two coordinates map to the axes perpendicular
  // to `faceAxis`, in ascending order: faceAxis 'z' -> (x, y), 'y' -> (x, z),
  // 'x' -> (y, z).
  points: Array<[number, number]>
  // Axis the mount sockets open along. Default 'z' (legacy front/back faces).
  faceAxis?: 'x' | 'y' | 'z'
  // 'both' = a front+back through-hole pair sharing one occupancy group (legacy
  // default). 'positive'/'negative' = a single blind socket on the +face / -face
  // only, for parts whose mount holes do not pass through (e.g. the Smart Motor
  // and the back-mounting sensors).
  sides?: 'both' | 'positive' | 'negative'
  // Measured depth of a blind socket, used as `receivingDepth` so a pin seats at
  // the real socket floor. Defaults to the full body thickness (`halfDepth*2`),
  // which is correct for two-sided through holes but overstates blind sockets.
  socketDepth?: number
  includeMotorShaft?: boolean
  // Explicit motor-shaft snap (overrides the default +Z shaft). Used when the
  // output shaft is not on +Z, e.g. the Smart Motor's shaft on its -X end.
  motorShaft?: SnapPointDefinition
}

const AXIS_INDEX: Record<'x' | 'y' | 'z', number> = { x: 0, y: 1, z: 2 }

function makeMountHoles(
  layout: ElectronicsMountLayout,
): SnapPointDefinition[] {
  const faceAxis = AXIS_INDEX[layout.faceAxis ?? 'z']
  const sides = layout.sides ?? 'both'
  // The two in-plane axes (ascending), e.g. faceAxis 'y' -> [x(0), z(2)].
  const planeAxes = [0, 1, 2].filter((i) => i !== faceAxis)
  // An up vector perpendicular to the face axis (reduces roll ambiguity).
  const upVec: [number, number, number] = [0, 0, 0]
  upVec[planeAxes[1]] = 1
  const makeVec = (u: number, v: number, d: number): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0]
    p[planeAxes[0]] = u
    p[planeAxes[1]] = v
    p[faceAxis] = d
    return p
  }
  const unit = (sign: number): [number, number, number] => {
    const a: [number, number, number] = [0, 0, 0]
    a[faceAxis] = sign
    return a
  }
  const out: SnapPointDefinition[] = []
  const pushFace = (
    u: number,
    v: number,
    baseId: string,
    snapId: string,
    faceSign: number,
  ) => {
    const pos = makeVec(u, v, faceSign * layout.halfDepth)
    const inward = unit(-faceSign) // insertion axis points into the part
    const outward = unit(faceSign) // surface normal points out of the face
    out.push({
      type: 'hole',
      role: 'receive',
      receivingDepth: layout.socketDepth ?? layout.halfDepth * 2,
      occupancyGroup: baseId,
      compatibleWith: ['pin', 'connector'] as SnapPointType[],
      radius: HOLE_PITCH * 0.28,
      approximate: true,
      curatedNeedsReview: true,
      id: snapId,
      position: pos,
      axis: inward,
      normal: outward,
      facePosition: pos,
      mateFrame: { position: pos, axis: inward, up: upVec },
    })
  }
  layout.points.forEach(([u, v], i) => {
    const id = layout.points.length === 1 ? 'hole-center' : `hole-${i}`
    if (sides === 'both') {
      // front + back through-hole pair sharing one occupancy group
      pushFace(u, v, id, id, 1)
      pushFace(u, v, id, `${id}-back`, -1)
    } else {
      // single blind socket on the chosen face
      pushFace(u, v, id, id, sides === 'negative' ? -1 : 1)
    }
  })
  return out
}

const ELECTRONICS_MOUNT_LAYOUTS: Record<string, ElectronicsMountLayout> = {
  // Point grids are measured from the converted GLBs by headless raycasting
  // (scripts measured each face for through-holes and blind sockets, filtered to
  // pin-sized clusters). All are flagged approximate + curatedNeedsReview.
  // Controller (228-2530): a handheld unit with no VEX pin-mount grid — the GLB
  // only has button/screen/internal cavities. Kept as an approximate on-face
  // marker set rather than fabricated holes.
  '228-2530': {
    halfDepth: 2.107,
    points: [
      [-1.5, -0.5],
      [1.5, -0.5],
      [-1.5, 0.5],
      [1.5, 0.5],
    ],
  },
  // Robot Brain: a measured row of 6 mounting holes (depth ~0.54) at y=+0.305 on
  // both ±Z faces.
  '228-2540': {
    halfDepth: 1.496,
    faceAxis: 'z',
    sides: 'both',
    points: [
      [-1.27, 0.305],
      [-0.73, 0.305],
      [-0.19, 0.305],
      [0.375, 0.305],
      [0.92, 0.305],
      [1.485, 0.305],
    ],
  },
  // Smart Motor: measured from the converted GLB (228-2560.glb) by headless
  // raycasting. The mounting sockets are a staggered 0.5-pitch grid of BLIND
  // holes on the +Y face (opening toward +Y), NOT a through-grid on ±Z. The
  // output shaft is the large recess on the -X end, not a +Z-axis center shaft.
  // Points are (X, Z) on the +Y mounting face; halfDepth is that face position.
  '228-2560': {
    halfDepth: 0.993,
    faceAxis: 'y',
    sides: 'positive',
    socketDepth: 0.45,
    points: [
      // Z = 0 row
      [-0.875, 0],
      [-0.375, 0],
      [0.125, 0],
      [0.625, 0],
      // Z = -0.25 row (staggered)
      [-0.625, -0.25],
      [-0.125, -0.25],
      [0.375, -0.25],
      [0.875, -0.25],
      // Z = +0.25 row (staggered)
      [-0.625, 0.25],
      [-0.125, 0.25],
      [0.375, 0.25],
      [0.875, 0.25],
    ],
    motorShaft: {
      id: 'motor-shaft',
      type: 'motorShaft',
      role: 'insert',
      position: [-1.0, -0.51, 0],
      axis: [-1, 0, 0],
      normal: [-1, 0, 0],
      mateFrame: { position: [-1.0, -0.51, 0], axis: [-1, 0, 0], up: [0, 1, 0] },
      alignMode: 'same',
      compatibleWith: ['axle', 'gearCenter', 'wheelCenter'],
      radius: HOLE_PITCH * 0.2,
      approximate: true,
      curatedNeedsReview: true,
    },
  },
  // Battery (228-2604): slots into the Brain; the GLB has no external pin-mount
  // grid (only a label recess). Kept as an approximate on-face marker set.
  '228-2604': {
    halfDepth: 2.069,
    points: [
      [-0.5, -0.25],
      [0.5, -0.25],
      [-0.5, 0.25],
      [0.5, 0.25],
    ],
  },
  // Radio (228-2621): a small port module with no mount grid; single center.
  '228-2621': { halfDepth: 0.136, points: [[0, 0]] },
  // Bumper Switch: 4 measured through-holes at the corners of the +Y face.
  '228-2677': {
    halfDepth: 0.529,
    faceAxis: 'y',
    sides: 'both',
    points: [
      [-0.75, -0.25],
      [-0.75, 0.25],
      [0.75, -0.25],
      [0.75, 0.25],
    ],
  },
  // Simulated Cable: not a mounted part; single center marker.
  '228-2780-simulated-cable': { halfDepth: 0.827, points: [[0, 0]] },
  // Touch Sensor: 4 corner mount holes + center aperture, blind on the -Y face.
  '228-3010': {
    halfDepth: 0.62,
    faceAxis: 'y',
    sides: 'negative',
    socketDepth: 0.4,
    points: [
      [-0.25, -0.25],
      [-0.25, 0.25],
      [0, 0],
      [0.25, -0.25],
      [0.25, 0.25],
    ],
  },
  // Distance Sensor: measured staggered 11-hole grid, blind on the -Y face.
  '228-3011': {
    halfDepth: 0.495,
    faceAxis: 'y',
    sides: 'negative',
    socketDepth: 0.4,
    points: [
      [-0.75, -0.25],
      [-0.75, 0.25],
      [-0.5, 0],
      [-0.25, -0.25],
      [-0.25, 0.25],
      [0, 0],
      [0.25, -0.25],
      [0.25, 0.25],
      [0.5, 0],
      [0.75, -0.25],
      [0.75, 0.25],
    ],
  },
  // Color Sensor: same 4-corner + center pattern as the Touch Sensor, on -Y.
  '228-3012': {
    halfDepth: 0.495,
    faceAxis: 'y',
    sides: 'negative',
    socketDepth: 0.4,
    points: [
      [-0.25, -0.25],
      [-0.25, 0.25],
      [0, 0],
      [0.25, -0.25],
      [0.25, 0.25],
    ],
  },
  // Gyro Sensor: same quincunx as the other small sensors, but on the +Y face.
  '228-3014': {
    halfDepth: 0.495,
    faceAxis: 'y',
    sides: 'positive',
    socketDepth: 0.45,
    points: [
      [-0.25, -0.25],
      [-0.25, 0.25],
      [0, 0],
      [0.25, -0.25],
      [0.25, 0.25],
    ],
  },
  // Cable Anchor: 2 measured through-holes along X on the Y faces.
  'cable-anchor-228-2500-158': {
    halfDepth: 0.173,
    faceAxis: 'y',
    sides: 'both',
    points: [
      [-0.25, 0],
      [0.25, 0],
    ],
  },
  // Dual Motor Support Cap: a row of 4 measured through-holes at y=0 on ±Z.
  'dual-motor-support-cap-228-2500-160': {
    halfDepth: 0.738,
    faceAxis: 'z',
    sides: 'both',
    points: [
      [-0.875, 0],
      [-0.375, 0],
      [0.125, 0],
      [0.625, 0],
    ],
  },
  // Single Motor Support Cap: measured staggered 12-hole through-grid on Y
  // (same pattern as the Smart Motor face, shallower body).
  'single-motor-support-cap-228-2500-159': {
    halfDepth: 0.252,
    faceAxis: 'y',
    sides: 'both',
    points: [
      [-0.875, -0.25],
      [-0.375, -0.25],
      [0.125, -0.25],
      [0.625, -0.25],
      [-0.625, 0],
      [-0.125, 0],
      [0.375, 0],
      [0.875, 0],
      [-0.875, 0.25],
      [-0.375, 0.25],
      [0.125, 0.25],
      [0.625, 0.25],
    ],
  },
  'motor-placeholder': {
    halfDepth: 0.3,
    points: [
      [-0.25, 0],
      [0.25, 0],
    ],
    includeMotorShaft: true,
  },
}

function makeElectronicsMountSnaps(
  def: PartDefinition,
): SnapPointDefinition[] | null {
  const layout = ELECTRONICS_MOUNT_LAYOUTS[def.id]
  if (!layout) return null
  const snaps = makeMountHoles(layout)
  const shaft = layout.motorShaft
    ? [layout.motorShaft]
    : layout.includeMotorShaft
      ? makeZAxisMotorShaftSnap()
      : []
  return [...shaft, ...snaps]
}

// Corner Connectors: measured through-hole grids on each part's thin face,
// raycast headlessly from the converted GLBs (recentered on the bbox center to
// match ScenePart). Points are on the plane perpendicular to `faceAxis` in
// ascending-axis order, exactly like ELECTRONICS_MOUNT_LAYOUTS. Most connectors
// present their pin holes on the Y face; the two upright chassis connectors
// (126/127) present them on the X face. Keyed by VEX part number.
//
// makeMountHoles flags these approximate + curatedNeedsReview, so they are
// usable in Pin Mode, Joint Mode, and Advanced Auto Snap (real `hole` snaps that
// accept a pin/connector), while Basic-Mode drag-snap stays gated until each is
// visually calibrated. Molded MALE pegs on some connectors are NOT captured here
// — only real through-holes were measured.
const CORNER_CONNECTOR_LAYOUTS: Record<string, ElectronicsMountLayout> = {
  '228-2500-129': { faceAxis: 'y', halfDepth: 0.208, sides: 'both', points: [[0, -0.129]] },
  '228-2500-2288': { faceAxis: 'y', halfDepth: 0.209, sides: 'both', points: [[0, -0.129]] },
  '228-2500-130': { faceAxis: 'y', halfDepth: 0.208, sides: 'both', points: [[0, -0.239]] },
  '228-2500-279': { faceAxis: 'y', halfDepth: 0.209, sides: 'both', points: [[0, -0.133], [-0.244, -0.132], [0.244, -0.132], [0, 0.284]] },
  '228-2500-1254': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[0.371, -0.13], [-0.121, -0.129], [0.121, -0.129]] },
  '228-2500-1255': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.371, -0.13], [-0.121, -0.129], [0.121, -0.129]] },
  '228-2500-133': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[0, -0.245]] },
  '228-2500-128': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.244, -0.133], [0.244, -0.133]] },
  '228-2500-135': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.242, -0.241], [0.242, -0.241], [0, 0]] },
  '228-2500-283': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[0, -0.245], [-0.493, -0.243], [0.493, -0.243], [-0.25, 0], [0.25, 0]] },
  '228-2500-132': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[0, -0.367], [0, 0.128]] },
  '228-2500-131': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[0, -0.49], [0, 0]] },
  '228-2500-134': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.242, -0.363], [0.242, -0.363], [0, -0.128], [-0.246, 0.12], [0.246, 0.12]] },
  '228-2500-2295': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[-0.242, -0.363], [0.242, -0.363], [0, -0.128], [-0.246, 0.12], [0.246, 0.12]] },
  '228-2500-136': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.244, -0.492], [0.244, -0.492], [0, -0.25], [-0.246, 0], [0.246, 0], [0, 0.25]] },
  '228-2500-2296': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[-0.244, -0.492], [0.244, -0.492], [0, -0.25], [-0.246, 0], [0.246, 0], [0, 0.25]] },
  '228-2500-137': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.244, -0.616], [0.244, -0.616], [0, -0.372], [-0.246, -0.121], [0.246, -0.121], [0, 0.13], [-0.242, 0.368], [0.242, 0.368]] },
  '228-2500-372': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[-0.193, -0.363], [0.246, -0.12], [-0.082, 0.118]] },
  '228-2500-371': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[0.193, -0.363], [-0.246, -0.12], [0.082, 0.118]] },
  '228-2500-368': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[0, -0.466], [-0.242, -0.036], [0.242, -0.036]] },
  '228-2500-270': { faceAxis: 'y', halfDepth: 0.209, sides: 'both', points: [[0, 0]] },
  '228-2500-272': { faceAxis: 'y', halfDepth: 0.209, sides: 'both', points: [[0, -0.243], [0, 0], [0, 0.243]] },
  '228-2500-271': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[-0.246, 0], [0, 0], [0.246, 0]] },
  '228-2500-274': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[-0.246, -0.119], [0.246, -0.119], [0, 0.128]] },
  '228-2500-220': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.242, -0.245], [0.242, -0.245], [0, 0], [-0.242, 0.245], [0.242, 0.245]] },
  '228-2500-277': { faceAxis: 'y', halfDepth: 0.245, sides: 'both', points: [[0, -0.504], [-0.246, -0.258], [0.246, -0.258], [0, 0], [-0.246, 0.258], [0.246, 0.258], [0, 0.504]] },
  '228-2500-126': { faceAxis: 'x', halfDepth: 0.244, sides: 'both', points: [[-0.119, -0.387], [0.387, 0.119], [-0.542, 0.123], [-0.123, 0.123], [-0.123, 0.542]] },
  '228-2500-1258': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.245, -0.245], [0.245, -0.245], [0, 0], [-0.245, 0.245], [0.245, 0.245]] },
  '228-2500-127': { faceAxis: 'x', halfDepth: 0.244, sides: 'both', points: [[0.129, -0.129]] },
  '228-2500-1251': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.242, -0.129], [0.242, -0.129], [0, -0.123]] },
  '228-2500-1250': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.123, 0], [0.286, 0]] },
  '228-2500-1253': { faceAxis: 'y', halfDepth: 0.244, sides: 'both', points: [[-0.363, -0.245], [0.124, -0.245], [-0.128, 0], [-0.363, 0.245], [0.124, 0.245]] },
}

// Molded MALE pegs (fixed connector pins) on corner connectors, measured as
// surface protrusions (~0.24 out, round) from the converted GLBs. Each entry is
// the peg's outward face axis + sign and its shoulder position (where it meets
// the body) in the recentered local frame. These become `connector` insert
// snaps that plug into a beam/hole. Keyed by VEX part number.
const CORNER_CONNECTOR_PEGS: Record<
  string,
  Array<{ axis: 'x' | 'y' | 'z'; sign: 1 | -1; base: [number, number, number] }>
> = {
  // (u,v) centers use the mesh bbox-center of each peg shaft (true axis center);
  // the earlier raycast-cluster centroid undershot by ~0.007-0.015, which showed
  // up as pegs seating slightly off-center in a hole. See _fix-pegs measurement.
  '228-2500-129': [{ axis: 'z', sign: 1, base: [0, 0.036, 0.12] }],
  '228-2500-2288': [{ axis: 'z', sign: 1, base: [0, 0.036, 0.12] }],
  '228-2500-279': [{ axis: 'z', sign: 1, base: [0, 0.036, 0.12] }],
  '228-2500-1254': [{ axis: 'x', sign: -1, base: [-0.38, 0, -0.124] }, { axis: 'z', sign: 1, base: [-0.126, 0, 0.12] }, { axis: 'z', sign: 1, base: [0.374, 0, 0.12] }],
  '228-2500-1255': [{ axis: 'x', sign: 1, base: [0.38, 0, -0.124] }, { axis: 'z', sign: 1, base: [-0.374, 0, 0.12] }, { axis: 'z', sign: 1, base: [0.126, 0, 0.12] }],
  '228-2500-128': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.12] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.12] }],
  '228-2500-132': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.38] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.38] }],
  '228-2500-131': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.5] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.5] }],
  '228-2500-134': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.38] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.38] }],
  '228-2500-136': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.5] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.5] }],
  '228-2500-137': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.62] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.62] }],
  '228-2500-372': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.38] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.38] }],
  '228-2500-371': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.38] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.38] }],
  '228-2500-368': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.46] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.46] }],
  '228-2500-270': [{ axis: 'z', sign: -1, base: [0, 0.036, -0.24] }],
  '228-2500-272': [{ axis: 'z', sign: 1, base: [0, 0.036, 0.5] }, { axis: 'z', sign: -1, base: [0, 0.036, -0.5] }],
  '228-2500-271': [{ axis: 'z', sign: -1, base: [-0.25, 0, -0.24] }, { axis: 'z', sign: -1, base: [0.25, 0, -0.24] }],
  '228-2500-274': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.38] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.38] }, { axis: 'z', sign: -1, base: [-0.25, 0, -0.38] }, { axis: 'z', sign: -1, base: [0.25, 0, -0.38] }],
  '228-2500-220': [{ axis: 'z', sign: 1, base: [-0.25, 0, 0.5] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.5] }, { axis: 'z', sign: -1, base: [-0.25, 0, -0.5] }, { axis: 'z', sign: -1, base: [0.25, 0, -0.5] }],
  '228-2500-277': [{ axis: 'z', sign: -1, base: [-0.25, 0, -0.74] }, { axis: 'z', sign: -1, base: [0.25, 0, -0.74] }],
  '228-2500-126': [{ axis: 'y', sign: -1, base: [0, -0.38, 0.121] }, { axis: 'z', sign: 1, base: [0, -0.121, 0.38] }],
  '228-2500-1258': [{ axis: 'x', sign: 1, base: [0.5, 0, -0.25] }, { axis: 'x', sign: 1, base: [0.5, 0, 0.25] }, { axis: 'x', sign: -1, base: [-0.5, 0, -0.25] }, { axis: 'x', sign: -1, base: [-0.5, 0, 0.25] }, { axis: 'z', sign: 1, base: [-0.25, 0, 0.5] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.5] }, { axis: 'z', sign: -1, base: [-0.25, 0, -0.5] }, { axis: 'z', sign: -1, base: [0.25, 0, -0.5] }],
  '228-2500-127': [{ axis: 'y', sign: -1, base: [0, -0.12, -0.127] }, { axis: 'z', sign: 1, base: [0, 0.127, 0.12] }],
  '228-2500-1251': [{ axis: 'x', sign: 1, base: [0.5, 0, -0.124] }, { axis: 'x', sign: -1, base: [-0.5, 0, -0.124] }, { axis: 'z', sign: 1, base: [-0.25, 0, 0.12] }, { axis: 'z', sign: 1, base: [0.25, 0, 0.12] }],
  '228-2500-1250': [{ axis: 'x', sign: 1, base: [0.12, 0, 0] }, { axis: 'z', sign: -1, base: [-0.124, 0, -0.24] }],
  '228-2500-1253': [{ axis: 'x', sign: 1, base: [0.38, 0, -0.25] }, { axis: 'x', sign: 1, base: [0.38, 0, 0.25] }, { axis: 'z', sign: 1, base: [-0.374, 0, 0.5] }, { axis: 'z', sign: 1, base: [0.126, 0, 0.5] }, { axis: 'z', sign: -1, base: [-0.374, 0, -0.5] }, { axis: 'z', sign: -1, base: [0.126, 0, -0.5] }],
}

function makeCornerConnectorPegSnaps(
  pegs: Array<{ axis: 'x' | 'y' | 'z'; sign: 1 | -1; base: [number, number, number] }>,
): SnapPointDefinition[] {
  return pegs.map((peg, i) => {
    const axisIndex = AXIS_INDEX[peg.axis]
    const outward: [number, number, number] = [0, 0, 0]
    outward[axisIndex] = peg.sign
    const up: [number, number, number] = [0, 0, 0]
    up[(axisIndex + 1) % 3] = 1
    return {
      id: `peg-${i}`,
      type: 'connector' as SnapPointType,
      role: 'insert',
      position: peg.base,
      axis: outward,
      normal: outward,
      mateFrame: { position: peg.base, axis: outward, up },
      alignMode: 'same',
      compatibleWith: ['hole'] as SnapPointType[],
      radius: HOLE_PITCH * 0.22,
      // Peg POSITIONS are measured (protrusion raycast), so — like pin snaps —
      // they are NOT `approximate` and therefore pass the Basic-Mode Auto Snap
      // positional-confidence gate (lowConfidenceSnap / findNearestCompatibleSnap
      // in utils/snap.ts). Only the seat depth still needs review. The corner
      // HOLES stay `approximate` (gated) — Auto Snap engages via pegs only.
      curatedNeedsReview: true,
      // Calibrated seat depth: the peg drives ~0.011 further into the receiving
      // hole (Properties → Snap Depth Calibration "Suggested override" −0.0110).
      // Applied uniformly whether the peg is the moving source or fixed target
      // (seatedDepthContributions reads sourceSide/targetSide ?? finalSeatAdjustment).
      finalSeatAdjustment: -0.011,
    }
  })
}

/**
 * Two-sided `hole` snap pairs from mesh-measured through-holes
 * (`src/data/measuredPartHoles.ts`, generated by
 * `npx tsx scripts/audit-part-holes.ts --emit`). Follows the
 * makeMountHoles/beam-grid conventions: front/back faces on the measured outer
 * envelope, one shared occupancy group per physical hole, flagged
 * `approximate` + `curatedNeedsReview` (raycast positions, no visual pass yet)
 * so Pin/Joint/Advanced Auto Snap can use them while Basic-Mode drag-snap
 * stays gated — the same policy as the measured Electronics mount holes.
 */
function makeMeasuredHoleSnaps(
  holes: MeasuredHole[],
  idPrefix: string,
): SnapPointDefinition[] {
  const out: SnapPointDefinition[] = []
  holes.forEach((h, i) => {
    const plane = [0, 1, 2].filter((k) => k !== h.axis) as [number, number]
    const upVec: [number, number, number] = [0, 0, 0]
    upVec[plane[1]] = 1
    const baseId = `${idPrefix}-${i}`
    const pushFace = (faceW: number, inwardSign: number, snapId: string) => {
      const pos: [number, number, number] = [0, 0, 0]
      pos[plane[0]] = h.u
      pos[plane[1]] = h.v
      pos[h.axis] = faceW
      const inward: [number, number, number] = [0, 0, 0]
      inward[h.axis] = inwardSign
      const outward: [number, number, number] = [0, 0, 0]
      outward[h.axis] = -inwardSign
      out.push({
        id: snapId,
        type: 'hole',
        role: 'receive',
        position: pos,
        axis: inward,
        normal: outward,
        facePosition: pos,
        mateFrame: { position: pos, axis: inward, up: upVec },
        receivingDepth: h.faceMax - h.faceMin,
        occupancyGroup: baseId,
        compatibleWith: ['pin', 'connector'],
        radius: HOLE_PITCH * 0.28,
        // DECISION 2026-07-13 (browser-verified): stays `approximate: true`.
        // Measured POSITIONS are trustworthy (truss plate, 45° beam, 60T gear,
        // 3-way plate all seat pins exactly), but flipping this to false lets
        // Basic-Mode drag auto-snap grab AXLE CENTER BORES on rotating parts
        // with no curated center snap (10mm/30mm pulley, turntable bushings…)
        // — a dragged pin jumps into the bore. Flip only after a bore
        // classification / skip-list pass (see NEXT-STEPS).
        approximate: true,
        curatedNeedsReview: true,
      })
    }
    pushFace(h.faceMax, -1, baseId)
    pushFace(h.faceMin, 1, `${baseId}-back`)
  })
  return out
}

function makeCornerConnectorSnaps(
  def: PartDefinition,
): SnapPointDefinition[] | null {
  const partNumber = partNumberOf(def)
  if (!partNumber) return null
  const layout = CORNER_CONNECTOR_LAYOUTS[partNumber]
  const pegs = CORNER_CONNECTOR_PEGS[partNumber]
  if (!layout && !pegs) return null
  const holes = layout ? makeMountHoles(layout) : []
  const pegSnaps = pegs ? makeCornerConnectorPegSnaps(pegs) : []
  return [...holes, ...pegSnaps]
}

const COMMON_LINEAR_BEAM_OVERRIDES: Record<string, SnapPointDefinition[]> = {
  '1x1-beam-228-2500-154': makeBeamHoleOverrides(1),
  '1x2-beam-228-2500-001': makeBeamHoleOverrides(2),
  '1x3-beam-228-2500-002': makeBeamHoleOverrides(3),
  '1x4-beam-228-2500-003': makeBeamHoleOverrides(4),
  '1x5-beam-228-2500-004': makeBeamHoleOverrides(5),
  '1x6-beam-228-2500-005': makeBeamHoleOverrides(6),
  '1x7-beam-228-2500-006': makeBeamHoleOverrides(7),
  '1x8-beam-228-2500-007': makeBeamHoleOverrides(8),
  '1x9-beam-228-2500-008': makeBeamHoleOverrides(9),
  '1x10-beam-228-2500-009': makeBeamHoleOverrides(10),
  '1x11-beam-228-2500-010': makeBeamHoleOverrides(11),
  '1x12-beam-228-2500-011': makeBeamHoleOverrides(12),
}

const PIN_PROFILE_OVERRIDES = {
  pin1x1: pinProfileSnapPointsForKey('pin1x1') ?? makeZAxisPinSeatSnaps(),
  pin1x2: pinProfileSnapPointsForKey('pin1x2') ?? makeZAxisPinSeatSnaps(true),
  pin2x2: pinProfileSnapPointsForKey('pin2x2') ?? makeZAxisPinSeatSnaps(),
  pin0x2: pinProfileSnapPointsForKey('pin0x2') ?? makeZAxisPinSeatSnaps(true),
  pin0x3: pinProfileSnapPointsForKey('pin0x3') ?? makeZAxisPinSeatSnaps(true),
}

const LINEAR_BEAM_HOLE_COUNTS_BY_PART_NUMBER: Record<string, number> = {
  '228-2500-154': 1,
  '228-2500-001': 2,
  '228-2500-002': 3,
  '228-2500-003': 4,
  '228-2500-004': 5,
  '228-2500-005': 6,
  '228-2500-006': 7,
  '228-2500-007': 8,
  '228-2500-008': 9,
  '228-2500-009': 10,
  '228-2500-010': 11,
  '228-2500-011': 12,
  '228-2500-012': 13,
  '228-2500-013': 14,
  '228-2500-014': 16,
  '228-2500-015': 18,
  '228-2500-016': 20,
}

const Z_AXIS_PIN_PART_NUMBERS = new Set([
  '228-2500-060',
  '228-2500-2260',
  '228-2500-086',
  '228-2500-087',
  '228-2500-073',
  '228-2500-084',
  '228-2500-085',
  '228-2500-097',
  '228-2500-098',
  '228-2500-099',
])

const PART_NUMBER_RE = /(\d{3}-\d{3,4}-\d+)/

function partNumberOf(def: PartDefinition): string | undefined {
  return def.partNumber ?? `${def.id} ${def.name}`.match(PART_NUMBER_RE)?.[1]
}

function partText(def: PartDefinition): string {
  return `${def.id} ${def.name} ${def.partNumber ?? ''}`.toLowerCase()
}

function isGeneratedOrReferenced(def: PartDefinition): boolean {
  return !!def.sourceCollection || !!def.partNumber || !!def.ldcadVexFileName
}

function inferOneWideBeamCount(def: PartDefinition): number | null {
  const partNumber = partNumberOf(def)
  if (partNumber && LINEAR_BEAM_HOLE_COUNTS_BY_PART_NUMBER[partNumber]) {
    return LINEAR_BEAM_HOLE_COUNTS_BY_PART_NUMBER[partNumber]
  }
  const match = partText(def).match(/\b1\s*x\s*(\d+)\b/)
  if (match) return Number(match[1])
  return null
}

function inferAxleLength(def: PartDefinition): number {
  if (def.length) return def.length
  const match =
    partText(def).match(/\b(\d+(?:\.\d+)?)\s*(?:x|m|pitch)\b/) ??
    partText(def).match(/\baxle\s+(\d+(?:\.\d+)?)\b/)
  if (!match) return 2
  return Math.max(2, Math.round(Number(match[1])))
}

function hasText(def: PartDefinition, ...terms: string[]): boolean {
  const text = partText(def)
  return terms.some((term) => text.includes(term))
}

/**
 * Parse a plain rectangular "WxL Beam/Plate" name into a hole-grid spec.
 * Returns null for non-rectangular variants (corner/angle/lock/diagonal/…) that
 * merely start with "WxL" — those don't have a full rectangular hole grid, so a
 * generated single row is left in place rather than fabricating a wrong grid.
 */
function parsePlainRectGrid(
  def: PartDefinition,
): { width: number; length: number } | null {
  // Single source of truth shared with the Parts Library family grouping.
  const rect = parseRectPart(def)
  return rect ? { width: rect.width, length: rect.length } : null
}

function fuzzyCuratedOverride(
  def: PartDefinition,
  includeMeasured = true,
): SnapPointDefinition[] | null {
  const partNumber = partNumberOf(def)

  // Plain rectangular beams/plates get a full W x L hole grid (measured-correct).
  const grid = parsePlainRectGrid(def)
  if (grid) {
    return makeBeamGridOverrides(grid.width, grid.length)
  }

  // Plain linear 1xN beams known by part number. This branch must NOT use the
  // loose "1xN anywhere in the name" inference: specialty parts like the
  // "1x8 Ballista Arm" or "1x5 Linear Motion Beam" matched it and got a
  // fabricated full hole row — the 2026-07-12 mesh audit showed most of those
  // holes don't exist. Non-plain 1xN parts now fall through to the measured
  // hole layer below, which carries their REAL raycast hole positions.
  const partNumberBeamCount =
    partNumber && LINEAR_BEAM_HOLE_COUNTS_BY_PART_NUMBER[partNumber]
  if (
    partNumberBeamCount &&
    (def.category === 'Beams' || hasText(def, 'beam'))
  ) {
    return makeBeamHoleOverrides(partNumberBeamCount)
  }

  const pinProfile = matchPinProfile(def)
  if (pinProfile) {
    return pinProfileToSnapPoints(pinProfile)
  }

  if (
    def.category === 'Pins' &&
    (isGeneratedOrReferenced(def) ||
      (partNumber && Z_AXIS_PIN_PART_NUMBERS.has(partNumber)) ||
      hasText(def, 'connector pin', 'idler pin', 'sheet pin'))
  ) {
    return makeZAxisPinSeatSnaps(
      !(partNumber === '228-2500-060' || def.id.includes('228-2500-060')),
    )
  }

  if (
    def.category === 'Axles' &&
    isGeneratedOrReferenced(def) &&
    hasText(def, 'axle', 'shaft')
  ) {
    return makeZAxisAxleSnaps(inferAxleLength(def))
  }

  if (def.category === 'Wheels' && isGeneratedOrReferenced(def)) {
    return makeZAxisCenterSnap('wheelCenter')
  }

  if (def.category === 'Gears' && isGeneratedOrReferenced(def)) {
    return makeZAxisCenterSnap('gearCenter')
  }

  if (def.category === 'Electronics') {
    const electronics = makeElectronicsMountSnaps(def)
    if (electronics) return electronics
  }

  // Corner Connectors: measured through-holes on the thin face (see
  // CORNER_CONNECTOR_LAYOUTS). Checked before the generic bounds-inferred
  // connector fallback so they expose real pin/connector holes.
  const cornerHoles = makeCornerConnectorSnaps(def)
  if (cornerHoles) return cornerHoles

  // Mesh-measured through-holes for parts with no curated coverage above
  // (specialty beams, trusses, panels, plastic sheets, game elements, misc).
  // Generated by the hole audit — see measuredPartHoles.ts.
  if (includeMeasured) {
    const measured = MEASURED_PART_HOLES[def.id]
    if (measured && measured.length > 0) {
      return makeMeasuredHoleSnaps(measured, 'mhole')
    }
  }

  return null
}

/**
 * Last-resort approximate snap points for GLB parts that have NO curated,
 * built-in, or generated points (otherwise they'd show no markers and be
 * unusable in Joint/Pin Mode). Positions are a best guess — centered on the
 * model and laid out on the hole grid — and are flagged `approximate` +
 * `boundsInferred` so the UI clearly says "may not match the visual model".
 *
 * Connectors expose `connector` points (which mate to beam holes); everything
 * else exposes a generic `hole` that can accept a pin or connector. A real
 * future step is to measure these off the loaded GLB; this just makes every
 * part grabbable today.
 */
function inferredFallbackSnapPoints(def: PartDefinition): SnapPointDefinition[] {
  const isConnector =
    def.category === 'Connectors' ||
    hasText(def, 'connector', 'standoff', 'bracket', 'clip')
  const type: SnapPointType = isConnector ? 'connector' : 'hole'
  const role: SnapPointDefinition['role'] = isConnector ? 'insert' : 'receive'
  const compatibleWith: SnapPointType[] = isConnector
    ? ['hole']
    : ['pin', 'connector']
  const count = Math.max(1, Math.min(inferOneWideBeamCount(def) ?? 1, 12))
  const start = -((count - 1) / 2) * HOLE_PITCH
  return Array.from({ length: count }, (_, i) => {
    const x = start + i * HOLE_PITCH
    const position: [number, number, number] = [x, 0, 0]
    return {
      id: count === 1 ? `${type}-center` : `${type}-${i}`,
      type,
      role,
      position,
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: { position, axis: [0, 0, 1], up: [0, 1, 0] },
      ...(type === 'hole' ? { facePosition: position } : {}),
      compatibleWith,
      radius: HOLE_PITCH * 0.25,
      approximate: true,
    }
  })
}

function cloneWithSource(
  snapPoints: SnapPointDefinition[],
  source: SnapMetadataSource,
): SnapPointDefinition[] {
  return snapPoints.map((snapPoint) => ({
    ...snapPoint,
    snapSource: snapPoint.snapSource ?? source,
  }))
}

export type SnapPointResolution = {
  snapPoints: SnapPointDefinition[]
  source: SnapMetadataSource
  // True when the set comes from the Visual Snap Authoring Tool (localStorage
  // layer). Authored sets resolve as 'curated' — they behave identically in
  // scoring, Basic-mode confidence gating, and connector quality — this flag
  // only lets the UI label them.
  authored?: boolean
}

/**
 * Curated snap-point overrides, keyed by part id.
 *
 * Generated/inferred snap points (from `generateSnapPoints`) are approximate —
 * they don't read true hole positions off the GLB mesh. When a part needs
 * accurate assembly, author its snap points by hand here and they take priority
 * over everything else. This is the recommended path to precise VEX IQ mating
 * without a CAD kernel; a future in-app editor can write entries into this map.
 *
 * Example:
 *   '228-2500-001': [
 *     { id: 'hole-0', type: 'hole', position: [-1.25, 0, 0], normal: [0, 1, 0],
 *       compatibleWith: ['pin', 'connector'] },
 *     ...
 *   ],
 */
export const SNAP_OVERRIDES: Record<string, SnapPointDefinition[]> = {
  // Procedural sample beam/pin metadata used by the built-in fallback parts.
  // Their visible beam holes run through local Z, and the sample pin shaft runs
  // along local X after the procedural mesh rotation.
  'beam-2x6': makeBeamHoleOverrides(
    6,
    SNAP_CALIBRATION.defaultProceduralBeamHoleDepth,
  ),
  'beam-2x10': makeBeamHoleOverrides(
    10,
    SNAP_CALIBRATION.defaultProceduralBeamHoleDepth,
  ),
  pin: [
    {
      id: 'pin-front',
      type: 'pin',
      role: 'insert',
      position: [-SNAP_CALIBRATION.defaultPinSeatOffset, 0, 0],
      axis: [-1, 0, 0],
      normal: [-1, 0, 0],
      mateFrame: {
        position: [-SNAP_CALIBRATION.defaultPinSeatOffset, 0, 0],
        axis: [-1, 0, 0],
        up: [0, 1, 0],
      },
      seatFrame: {
        position: [
          -SNAP_CALIBRATION.defaultPinSeatOffset +
            SNAP_CALIBRATION.pinInsertionDepthCorrection,
          0,
          0,
        ],
        axis: [-1, 0, 0],
        up: [0, 1, 0],
      },
      seatPosition: [
        -SNAP_CALIBRATION.defaultPinSeatOffset +
          SNAP_CALIBRATION.pinInsertionDepthCorrection,
        0,
        0,
      ],
      alignMode: 'same',
      insertionDepth: SNAP_CALIBRATION.defaultPinInsertionDepth,
      insertionDepthCorrection: SNAP_CALIBRATION.pinInsertionDepthCorrection,
      finalSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
      sourceSideSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
      targetSideSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
      seatOffset: 0,
      compatibleWith: ['hole'],
    },
    {
      id: 'pin-back',
      type: 'pin',
      role: 'insert',
      position: [SNAP_CALIBRATION.defaultPinSeatOffset, 0, 0],
      axis: [1, 0, 0],
      normal: [1, 0, 0],
      mateFrame: {
        position: [SNAP_CALIBRATION.defaultPinSeatOffset, 0, 0],
        axis: [1, 0, 0],
        up: [0, 1, 0],
      },
      seatFrame: {
        position: [
          SNAP_CALIBRATION.defaultPinSeatOffset -
            SNAP_CALIBRATION.pinInsertionDepthCorrection,
          0,
          0,
        ],
        axis: [1, 0, 0],
        up: [0, 1, 0],
      },
      seatPosition: [
        SNAP_CALIBRATION.defaultPinSeatOffset -
          SNAP_CALIBRATION.pinInsertionDepthCorrection,
        0,
        0,
      ],
      alignMode: 'same',
      insertionDepth: SNAP_CALIBRATION.defaultPinInsertionDepth,
      insertionDepthCorrection: SNAP_CALIBRATION.pinInsertionDepthCorrection,
      finalSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
      sourceSideSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
      targetSideSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
      seatOffset: 0,
      compatibleWith: ['hole'],
    },
  ],

  ...COMMON_LINEAR_BEAM_OVERRIDES,

  // 1x1 Connector Pin — the canonical VEX IQ pin. Its GLB shaft runs along
  // local Z (measured size ≈ [0.23, 0.25, 0.48]; half-length 0.2417), and the
  // model is rendered re-centered on its bounding box, so the geometric center
  // is the local origin. The generated fallback wrongly assumed an X-axis pin
  // with tips at ±0.25 X. Pin snap ids are centered mate frames; front/back
  // expose opposite shaft-axis choices without offsetting the seated pin.
  '1x1-connector-pin-228-2500-060': PIN_PROFILE_OVERRIDES.pin1x1,
  '1x1-connector-pin-weak-228-2500-2260': PIN_PROFILE_OVERRIDES.pin1x1,
  '2x2-connector-pin-228-2500-062': PIN_PROFILE_OVERRIDES.pin2x2,
  '1x2-connector-pin-228-2500-061': PIN_PROFILE_OVERRIDES.pin1x2,
  '1x2-connector-pin-weak-228-2500-2261': PIN_PROFILE_OVERRIDES.pin1x2,
  '1x2-idler-pin-228-2500-098': PIN_PROFILE_OVERRIDES.pin1x2,
  '0x2-connector-pin-228-2500-086': PIN_PROFILE_OVERRIDES.pin0x2,
  '0x2-idler-pin-228-2500-084': PIN_PROFILE_OVERRIDES.pin0x2,
  '0x3-connector-pin-228-2500-087': PIN_PROFILE_OVERRIDES.pin0x3,
  '0x3-idler-pin-228-2500-097': PIN_PROFILE_OVERRIDES.pin0x3,
  '0x3-smooth-idler-pin-weak-228-2500-085': PIN_PROFILE_OVERRIDES.pin0x3,
  '1x1-idler-pin-228-2500-073': PIN_PROFILE_OVERRIDES.pin1x1,

  // 0x1 Sheet Pin — short/rivet-like (measured ≈ [0.32, 0.32, 0.28]); mate by
  // its seated shoulder frame.
  '0x1-sheet-pin-228-2500-099': makeZAxisPinSeatSnaps(true),

  // Procedural axle is authored along local X, unlike the generated VEX GLB
  // shafts measured from the converted catalog.
  'axle-2': makeXAxisAxleSnaps(2),
  gear: makeZAxisCenterSnap('gearCenter'),
  wheel: makeZAxisCenterSnap('wheelCenter'),
  'motor-placeholder':
    makeElectronicsMountSnaps({
      id: 'motor-placeholder',
      name: 'Motor Placeholder',
      category: 'Electronics',
      colorOptions: [],
      defaultColor: '#d8dde6',
      procedural: 'motor',
      snapPoints: [],
    }) ?? makeZAxisMotorShaftSnap(),
}

/**
 * Resolve the snap points to use for a part, in priority order:
 *   1. curated override in {@link SNAP_OVERRIDES} (keyed by part id)
 *   2. the part definition's own snap points (built-ins, or generated fallback)
 *
 * (A future step 3 — bounds-inferred snap points measured from the loaded GLB —
 * would slot in below these for parts that have neither.)
 *
 * Every snap-point consumer (markers, snap math, properties, procedural holes)
 * goes through this function so overrides apply everywhere consistently.
 */
export function getSnapPoints(def: PartDefinition): SnapPointDefinition[] {
  return getSnapPointResolution(def).snapPoints
}

export function getSnapPointResolution(
  def: PartDefinition,
  // `includeMeasured: false` resolves WITHOUT the generated measured-hole
  // layers. Used only by scripts/audit-part-holes.ts so regenerating the
  // measured tables classifies parts by their underlying coverage instead of
  // seeing the previous generation's output.
  opts?: { includeMeasured?: boolean },
): SnapPointResolution {
  const result = resolveSnapPoints(def, opts?.includeMeasured ?? true)
  if (!hasAnyPinSeatOverride()) return result
  return { ...result, snapPoints: applyPinSeatOverrides(result.snapPoints) }
}

// Replace a pin end's seat depth with a user-saved override (set from the Snap
// Depth Calibration panel). The snaps are already cloned by cloneWithSource, so
// returning fresh objects here is safe.
function applyPinSeatOverrides(
  snaps: SnapPointDefinition[],
): SnapPointDefinition[] {
  return snaps.map((snap) => {
    if (!snap.pinProfileKey) return snap
    const override = getPinSeatOverride(snap.pinProfileKey, snap.id)
    if (override === undefined) return snap
    return {
      ...snap,
      finalSeatAdjustment: override,
      sourceSideSeatAdjustment: override,
      targetSideSeatAdjustment: override,
    }
  })
}

function resolveSnapPoints(
  def: PartDefinition,
  includeMeasured = true,
): SnapPointResolution {
  // Highest priority: a set authored in this browser via the Visual Snap
  // Authoring Tool. Serving it here keeps every consumer (markers, snap math,
  // properties, project validation) on the one resolver while edits are live.
  // Authored sets are fully user-controlled — no measured supplement.
  const authored = getAuthoredSnapOverride(def.id)
  if (authored && authored.length > 0) {
    return {
      snapPoints: cloneWithSource(authored, 'curated'),
      source: 'curated',
      authored: true,
    }
  }
  return withSupplementalHoles(def, includeMeasured, resolveBaseSnapPoints(def, includeMeasured))
}

// Mesh-measured through-holes that the part's primary metadata does not cover
// (gear/wheel face holes, standoff cross-holes, extra electronics faces, …).
// Appended AFTER the primary resolution so calibrated layers keep their
// points, ids, and source; the added points carry their own needs-review flags.
function withSupplementalHoles(
  def: PartDefinition,
  includeMeasured: boolean,
  resolution: SnapPointResolution,
): SnapPointResolution {
  if (!includeMeasured) return resolution
  const supplemental = MEASURED_SUPPLEMENTAL_HOLES[def.id]
  if (!supplemental || supplemental.length === 0) return resolution
  return {
    ...resolution,
    snapPoints: [
      ...resolution.snapPoints,
      ...cloneWithSource(makeMeasuredHoleSnaps(supplemental, 'mhole'), 'curated'),
    ],
  }
}

function resolveBaseSnapPoints(
  def: PartDefinition,
  includeMeasured: boolean,
): SnapPointResolution {
  const exact = SNAP_OVERRIDES[def.id]
  if (exact) {
    return { snapPoints: cloneWithSource(exact, 'curated'), source: 'curated' }
  }

  const fuzzy = fuzzyCuratedOverride(def, includeMeasured)
  if (fuzzy) {
    return { snapPoints: cloneWithSource(fuzzy, 'curated'), source: 'curated' }
  }

  if (def.snapPoints.length > 0) {
    const generated = def.snapPoints.every((snapPoint) => snapPoint.approximate)
    const source: SnapMetadataSource = generated
      ? 'generatedFallback'
      : 'partDefinition'
    return {
      snapPoints: cloneWithSource(def.snapPoints, source),
      source,
    }
  }

  // No curated, built-in, or generated points: infer an approximate set so the
  // part still shows clickable markers and works in Joint/Pin Mode.
  const inferred = inferredFallbackSnapPoints(def)
  if (inferred.length > 0) {
    return {
      snapPoints: cloneWithSource(inferred, 'boundsInferred'),
      source: 'boundsInferred',
    }
  }

  return { snapPoints: [], source: 'partDefinition' }
}

/** True when a part is relying on inferred/generated snap points (no override). */
export function hasCuratedSnapPoints(def: PartDefinition): boolean {
  return getSnapPointResolution(def).source === 'curated'
}

export function snapMetadataLabel(source: SnapMetadataSource): string {
  switch (source) {
    case 'curated':
      return 'Curated'
    case 'partDefinition':
      return 'Part definition'
    case 'generatedFallback':
      return 'Generated fallback'
    case 'boundsInferred':
      return 'Bounds inferred'
    default:
      return source
  }
}
