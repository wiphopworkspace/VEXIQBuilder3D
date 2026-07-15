// VEX IQ shaft-family calibration and snap-point factories.
//
// Measured 2026-07-14 from the converted GLBs (headless vertex profiling +
// raycast probing in the bbox-recentered frame ScenePart renders in — see
// HANDOFF "Measuring Parts"). Sources of truth:
//  - Smart Motor 228-2560: the square drive socket is on the TOP (+Y)
//    mounting face, beside the mounting holes. Re-measured 2026-07-15: an
//    axis-aligned 0.148 × 0.148 square opening centered at
//    (x, z) = (-0.375, 0), mouth (boss ring) at y = +0.9936 (the bbox top),
//    dead-flat floor at y = +0.7574 → physical depth 0.236. Cross-checked
//    against the flanged Motor Shaft's 0.18 drive stub (stub < depth ✓).
//    The 2026-07-14 calibration had probed the -X end instead and measured
//    a 0.44 × 0.38 cavity at (y, z) = (-0.49, 0) — that opening is the
//    SMART CABLE PORT (an electrical connector, ~11 × 10 mm), NOT a shaft
//    socket. It is now a non-mechanical exclusion region in snapOverrides.
//  - Straight/plastic shafts: uniform 0.126 square (half 0.063), both ends
//    open, total length = pitches * 0.5 - 0.07 (measured 0.930/1.930/5.930
//    for 2x/4x/12x).
//  - Capped shafts: same body, one round cap (Ø0.188, 0.04 thick) on the +Z
//    end; total length = pitches * 0.5 - 0.039 (0.961 for 2x, 2.461 for 5x).
//  - Motor shafts (metal 2234/2236/2238, plastic 078/094/079): round flange
//    Ø0.188 near the +Z end (flange spans [L/2-0.26, L/2-0.18]) with a 0.18
//    drive stub beyond it; total length = pitches * 0.5 + 0.18.
//  - Plastic Motor Snap Shafts: 328 (1x) has snap fingers on -Z, a Ø0.188
//    flange at [0.105, 0.165] and a square body to +0.3545 (total 0.709);
//    v1 091/092 have the square body on -Z and a Ø0.25 collar + fingers
//    toward +Z (totals 0.777 / 0.990).
//
// The motor socket is deliberately AUTHORED from these measurements rather
// than estimated from the motor bounding box.

import type {
  PartDefinition,
  SnapPointDefinition,
  Vec3,
} from '../types/assembly'

export const SHAFT_CALIBRATION = {
  // Half-width of the standard 3.2 mm square shaft cross-section.
  shaftSquareHalfWidth: 0.0625,
  // Driven/support components seat on shaft stations every hole pitch.
  stationPitch: 0.5,
  // Standard rotating-part thickness is 0.25; a station keeps at least this
  // half-thickness clear of shaft ends, caps and flanges.
  componentHalfThickness: 0.125,
  // Round end cap on capped shafts (Ø0.188).
  capThickness: 0.04,
  // Motor-shaft flange: drive stub length beyond the flange and the flange's
  // own thickness (flange outer face = L/2 - flangeToTip).
  motorShaftFlangeToTip: 0.18,
  motorShaftFlangeThickness: 0.08,
  // IQ Smart Motor (228-2560) square drive socket, measured from the GLB
  // (2026-07-15 re-calibration). It sits on the TOP (+Y) mounting face at the
  // (-0.375, 0) lattice position, opening upward — NOT on the -X end (that
  // opening is the Smart Cable port; see the header note).
  motorSocket: {
    // Socket-mouth position (boss ring on the top face) in the motor's local
    // bbox-recentered frame.
    mouth: [-0.375, 0.9936, 0] as Vec3,
    // Insertion axis points INTO the motor (down through the top face);
    // outward normal points up out of the mounting face.
    axisInward: [0, -1, 0] as Vec3,
    normalOutward: [0, 1, 0] as Vec3,
    // Square-drive orientation basis: the bore's flats are aligned with the
    // motor's local X/Z axes (measured axis-aligned square opening).
    up: [1, 0, 0] as Vec3,
    // Physical bore depth (mouth → floor) and the calibrated seated depth an
    // open shaft end travels to (floor minus a small clearance).
    socketDepth: 0.236,
    seatedDepth: 0.232,
    boreHalfWidth: 0.074,
  },
} as const

export type ShaftKind = 'straight' | 'capped' | 'motor' | 'snap328' | 'snapV1'

export type ShaftSpec = {
  kind: ShaftKind
  /** Nominal length in hole pitches ("Nx Pitch ..."). */
  pitches: number
}

/**
 * Authored shaft-family spec table, keyed by VEX part number. Reviewable —
 * every entry corresponds to a measured GLB family with a verified length
 * formula. Parts not listed here keep the legacy generic axle stations.
 */
export const SHAFT_SPECS_BY_PART_NUMBER: Record<string, ShaftSpec> = {
  // Straight metal shafts
  '228-2500-117': { kind: 'straight', pitches: 2 },
  '228-2500-119': { kind: 'straight', pitches: 3 },
  '228-2500-120': { kind: 'straight', pitches: 4 },
  '228-2500-121': { kind: 'straight', pitches: 5 },
  '228-2500-122': { kind: 'straight', pitches: 6 },
  '228-2500-123': { kind: 'straight', pitches: 7 },
  '228-2500-124': { kind: 'straight', pitches: 8 },
  '228-2500-260': { kind: 'straight', pitches: 9 },
  '228-2500-261': { kind: 'straight', pitches: 10 },
  '228-2500-262': { kind: 'straight', pitches: 11 },
  '228-2500-263': { kind: 'straight', pitches: 12 },
  '228-2500-264': { kind: 'straight', pitches: 14 },
  '228-2500-265': { kind: 'straight', pitches: 16 },
  '228-2500-266': { kind: 'straight', pitches: 18 },
  '228-2500-267': { kind: 'straight', pitches: 20 },
  '228-2500-268': { kind: 'straight', pitches: 22 },
  '228-2500-269': { kind: 'straight', pitches: 24 },
  // Straight plastic shafts
  '228-2500-074': { kind: 'straight', pitches: 2 },
  '228-2500-075': { kind: 'straight', pitches: 3 },
  '228-2500-076': { kind: 'straight', pitches: 4 },
  '228-2500-077': { kind: 'straight', pitches: 5 },
  // Capped metal shafts (cap on the +Z end)
  '228-2500-2219': { kind: 'capped', pitches: 2 },
  '228-2500-2220': { kind: 'capped', pitches: 2.5 },
  '228-2500-2221': { kind: 'capped', pitches: 3 },
  '228-2500-2223': { kind: 'capped', pitches: 4 },
  '228-2500-2224': { kind: 'capped', pitches: 4.5 },
  '228-2500-2225': { kind: 'capped', pitches: 5 },
  '228-2500-2226': { kind: 'capped', pitches: 6 },
  '228-2500-2227': { kind: 'capped', pitches: 7 },
  '228-2500-2228': { kind: 'capped', pitches: 8 },
  '228-2500-2229': { kind: 'capped', pitches: 9 },
  '228-2500-2230': { kind: 'capped', pitches: 10 },
  '228-2500-2231': { kind: 'capped', pitches: 11 },
  '228-2500-2232': { kind: 'capped', pitches: 12 },
  // Capped plastic shafts
  '228-2500-080': { kind: 'capped', pitches: 2 },
  '228-2500-081': { kind: 'capped', pitches: 3 },
  '228-2500-082': { kind: 'capped', pitches: 4 },
  '228-2500-083': { kind: 'capped', pitches: 5 },
  // Motor shafts (flange + drive stub on the +Z end)
  '228-2500-2234': { kind: 'motor', pitches: 2 },
  '228-2500-2236': { kind: 'motor', pitches: 3 },
  '228-2500-2238': { kind: 'motor', pitches: 4 },
  '228-2500-078': { kind: 'motor', pitches: 2 },
  '228-2500-094': { kind: 'motor', pitches: 3 },
  '228-2500-079': { kind: 'motor', pitches: 4 },
  // Plastic Motor Snap Shafts
  '228-2500-328': { kind: 'snap328', pitches: 1 },
  '228-2500-091': { kind: 'snapV1', pitches: 1.5 },
  '228-2500-092': { kind: 'snapV1', pitches: 2 },
}

/** Measured total length along local Z for a shaft spec. */
export function shaftTotalLength(spec: ShaftSpec): number {
  switch (spec.kind) {
    case 'straight':
      return spec.pitches * 0.5 - 0.07
    case 'capped':
      return spec.pitches * 0.5 - 0.039
    case 'motor':
      return spec.pitches * 0.5 + 0.18
    case 'snap328':
      return 0.709
    case 'snapV1':
      return spec.pitches === 1.5 ? 0.777 : 0.99
  }
}

type EndDescriptor = {
  /** 'a' = the -Z end, 'b' = the +Z end. Stable regardless of array order. */
  side: 'a' | 'b'
  kind: 'open' | 'flanged' | 'snap'
  /** How deep this end can travel into the motor socket before its stop. */
  endStopDepth: number
  usableShaftLength: number
}

/**
 * Usable motor-socket ends for a shaft spec. Capped/flanged/body sides emit
 * no end — a cap cannot enter the socket and the plain end of a motor shaft
 * is meant for driven components, not the motor.
 */
function shaftEnds(spec: ShaftSpec): EndDescriptor[] {
  const L = shaftTotalLength(spec)
  const seated = SHAFT_CALIBRATION.motorSocket.seatedDepth
  switch (spec.kind) {
    case 'straight':
      return [
        { side: 'a', kind: 'open', endStopDepth: seated, usableShaftLength: L },
        { side: 'b', kind: 'open', endStopDepth: seated, usableShaftLength: L },
      ]
    case 'capped':
      // Open end on -Z; the +Z cap side cannot be inserted anywhere.
      return [
        {
          side: 'a',
          kind: 'open',
          endStopDepth: seated,
          usableShaftLength: L - SHAFT_CALIBRATION.capThickness,
        },
      ]
    case 'motor': {
      // Drive stub on +Z; the flange stops against the socket mouth.
      const stub = SHAFT_CALIBRATION.motorShaftFlangeToTip
      return [
        {
          side: 'b',
          kind: 'flanged',
          endStopDepth: Math.min(seated, stub),
          usableShaftLength: stub,
        },
      ]
    }
    case 'snap328': {
      // Fingers on -Z; flange stop (inner face z = +0.105) is 0.4595 from the
      // tip (-0.3545), but the measured socket floor (0.232) limits travel
      // first — Math.min picks whichever stop engages sooner.
      return [
        {
          side: 'a',
          kind: 'snap',
          endStopDepth: Math.min(seated, 0.4595),
          usableShaftLength: 0.4595,
        },
      ]
    }
    case 'snapV1':
      // Fingers + Ø0.25 collar on +Z; no stop inside the socket reach, so the
      // socket floor limits the travel.
      return [
        {
          side: 'b',
          kind: 'snap',
          endStopDepth: seated,
          usableShaftLength: shaftTotalLength(spec),
        },
      ]
  }
}

/**
 * Station positions along local Z where a driven bore / support bore can seat.
 * Nominal pitch-spaced series clamped so a standard 0.25-thick component never
 * overlaps a cap, flange, or the shaft end. IDs stay `axle-<i>` in ascending
 * Z, matching the legacy generic axle rows for straight shafts.
 */
export function shaftStationPositions(spec: ShaftSpec): number[] {
  const L = shaftTotalLength(spec)
  const half = SHAFT_CALIBRATION.componentHalfThickness
  const pitch = SHAFT_CALIBRATION.stationPitch

  if (spec.kind === 'motor') {
    // Stations live on the body between the -Z end and the flange.
    const flangeInner =
      L / 2 -
      SHAFT_CALIBRATION.motorShaftFlangeToTip -
      SHAFT_CALIBRATION.motorShaftFlangeThickness
    const out: number[] = []
    for (let z = -L / 2 + pitch / 2; z <= flangeInner - half + 1e-9; z += pitch) {
      out.push(Number(z.toFixed(4)))
    }
    return out
  }
  if (spec.kind === 'snap328') {
    // Single station centered on the exposed square body [0.165, 0.3545].
    return [0.26]
  }
  if (spec.kind === 'snapV1') {
    // Square body on -Z: 091 spans [-0.3885, -0.19], 092 spans [-0.495, -0.295].
    return [spec.pitches === 1.5 ? -0.289 : -0.395]
  }

  // Straight / capped: nominal centered series (matches the legacy axle rows),
  // then clamp the outermost stations away from the ends and the cap.
  const count = Math.max(2, Math.round(spec.pitches))
  const nominalHalf = ((count - 1) * pitch) / 2
  const zMin = -L / 2 + half
  const zMax =
    L / 2 - (spec.kind === 'capped' ? SHAFT_CALIBRATION.capThickness : 0) - half
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    let z = -nominalHalf + i * pitch
    if (z < zMin) z = zMin
    if (z > zMax) z = zMax
    // Drop a clamped station that collided with its neighbor.
    if (out.length > 0 && z - out[out.length - 1] < 0.3) continue
    out.push(Number(z.toFixed(4)))
  }
  return out
}

const SHAFT_END_COMPAT: SnapPointDefinition['compatibleWith'] = ['motorShaft']
const STATION_COMPAT: SnapPointDefinition['compatibleWith'] = [
  'axleHole',
  'wheelCenter',
  'gearCenter',
  'shaftSupportBore',
]

/**
 * Full authored snap set for a shaft: usable `shaftEnd` snaps + `axle`
 * stations. The shaft body runs along local Z (all measured GLBs do).
 */
export function makeShaftSnapPoints(spec: ShaftSpec): SnapPointDefinition[] {
  const L = shaftTotalLength(spec)
  const seated = SHAFT_CALIBRATION.motorSocket.seatedDepth
  const out: SnapPointDefinition[] = []

  for (const end of shaftEnds(spec)) {
    const sign = end.side === 'a' ? -1 : 1
    const endFace: Vec3 = [0, 0, sign * (L / 2)]
    const outward: Vec3 = [0, 0, sign]
    // Virtual seat plane beyond the end face: when it lands on the socket's
    // seated plane, this end sits at its stop-limited depth (flange at the
    // mouth, or end face at the floor). Direction-independent, like pin seats.
    const stopOffset = seated - end.endStopDepth
    const seatPos: Vec3 = [0, 0, sign * (L / 2 + stopOffset)]
    out.push({
      id: `shaft-end-${end.side}`,
      type: 'shaftEnd',
      role: 'insert',
      position: endFace,
      axis: outward,
      normal: outward,
      mateFrame: { position: endFace, axis: outward, up: [0, 1, 0] },
      seatFrame: { position: seatPos, axis: outward, up: [0, 1, 0] },
      seatPosition: seatPos,
      alignMode: 'same',
      rollStepDeg: 90,
      shaftEndKind: end.kind,
      usableShaftLength: end.usableShaftLength,
      stopOffset,
      compatibleWith: SHAFT_END_COMPAT,
      radius: 0.11,
    })
  }

  shaftStationPositions(spec).forEach((z, i) => {
    const position: Vec3 = [0, 0, z]
    out.push({
      id: `axle-${i}`,
      type: 'axle',
      role: 'insert',
      position,
      axis: [0, 0, 1],
      normal: [0, 0, 1],
      mateFrame: { position, axis: [0, 0, 1], up: [0, 1, 0] },
      alignMode: 'same',
      rollStepDeg: 90,
      compatibleWith: STATION_COMPAT,
      radius: 0.11,
    })
  })

  return out
}

/**
 * The calibrated IQ Smart Motor drive socket. Keeps the legacy `motor-shaft`
 * snap id so saved projects that referenced the old approximate motor snap
 * still resolve. The marker/mate frame sits at the socket MOUTH; the contact
 * plane (`facePosition`) is the final SEATED plane inside the socket, so a
 * shaft end's seat frame lands there fully inserted — never floating at the
 * mouth — regardless of which part is being dragged.
 */
export function makeMotorSocketSnap(): SnapPointDefinition {
  const s = SHAFT_CALIBRATION.motorSocket
  const seatedPlane: Vec3 = [
    s.mouth[0] + s.axisInward[0] * s.seatedDepth,
    s.mouth[1] + s.axisInward[1] * s.seatedDepth,
    s.mouth[2] + s.axisInward[2] * s.seatedDepth,
  ]
  return {
    id: 'motor-shaft',
    type: 'motorShaft',
    role: 'receive',
    position: s.mouth,
    axis: s.axisInward,
    normal: s.normalOutward,
    facePosition: seatedPlane,
    mateFrame: { position: s.mouth, axis: s.axisInward, up: s.up },
    alignMode: 'same',
    rollStepDeg: 90,
    socketDepth: s.socketDepth,
    receivingDepth: s.socketDepth,
    compatibleWith: ['shaftEnd'],
    radius: 0.13,
  }
}

/**
 * A square driven bore (`axleHole`): locks the component's rotation to the
 * shaft in quarter-turn increments. One snap per physical bore — both faces
 * share this single occupancy identity, and insertion from either side works
 * because axis alignment takes the shortest arc.
 */
export function makeDrivenBoreSnap(opts: {
  id?: string
  position: Vec3
  axis?: Vec3
  up?: Vec3
  receivingDepth?: number
}): SnapPointDefinition {
  const axis = opts.axis ?? [0, 0, 1]
  const up = opts.up ?? (Math.abs(axis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0])
  return {
    id: opts.id ?? 'shaft-bore',
    type: 'axleHole',
    role: 'receive',
    position: opts.position,
    axis,
    normal: axis,
    facePosition: opts.position,
    mateFrame: { position: opts.position, axis, up },
    alignMode: 'same',
    rollStepDeg: 90,
    receivingDepth: opts.receivingDepth ?? 0.25,
    compatibleWith: ['axle'],
    radius: 0.1,
  }
}

/**
 * A free-spinning support bore (`shaftSupportBore`): aligns the shaft
 * centerline but deliberately carries NO up vector, so the square-profile
 * roll is never locked — the shaft stays free to rotate (mates from this
 * pair are tagged revolute by the store).
 */
export function makeSupportBoreSnap(opts: {
  id?: string
  position: Vec3
  axis?: Vec3
  occupancyGroup?: string
  receivingDepth?: number
}): SnapPointDefinition {
  const axis = opts.axis ?? [0, 0, 1]
  return {
    id: opts.id ?? 'shaft-support',
    type: 'shaftSupportBore',
    role: 'receive',
    position: opts.position,
    axis,
    normal: axis,
    facePosition: opts.position,
    mateFrame: { position: opts.position, axis },
    alignMode: 'same',
    receivingDepth: opts.receivingDepth ?? 0.25,
    occupancyGroup: opts.occupancyGroup,
    compatibleWith: ['axle'],
    radius: 0.08,
  }
}

/** Authored shaft snap set for a part, or null when it's not in the spec table. */
export function shaftSnapPointsForPart(
  def: PartDefinition,
): SnapPointDefinition[] | null {
  const partNumber =
    def.partNumber ?? `${def.id} ${def.name}`.match(/(\d{3}-\d{3,4}-\d+)/)?.[1]
  if (!partNumber) return null
  const spec = SHAFT_SPECS_BY_PART_NUMBER[partNumber]
  if (!spec) return null
  return makeShaftSnapPoints(spec)
}
