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
  id: string,
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

function ordinal(n: number): string {
  if (n === 2) return '2nd'
  if (n === 3) return '3rd'
  return `${n}th`
}

/**
 * One seat per plastic layer a pin side passes through. Layer 1 is the classic
 * flange/cap seat (`pin-front` / `pin-back`); layer k seats a k-th stacked beam
 * at the (k-1)-th layer boundary (`pin-front-2`, `pin-back-3`, …). Seat planes
 * step outward by one beam thickness; the stacked-beam clearance is baked into
 * the per-layer adjustment step (the flange clearance correction in snap.ts
 * only fires for the pin-front <-> pin-back pair). `layerAdjustments` pins a
 * layer's adjustment to an explicitly calibrated value (e.g. the 1x2's
 * pin-back-2) so it can never drift with the derived step.
 */
function sideEnds(opts: {
  side: 'front' | 'back'
  seatZ: number
  axisZ: -1 | 1
  layers: number
  baseAdjustment: number
  layerAdjustments?: Record<number, number>
  labelBase?: string
  labelLayer?: (layer: number) => string
}): PinProfileEnd[] {
  const sideLabel = opts.side === 'front' ? 'Front' : 'Back'
  const ends: PinProfileEnd[] = []
  for (let layer = 1; layer <= opts.layers; layer++) {
    const id = layer === 1 ? `pin-${opts.side}` : `pin-${opts.side}-${layer}`
    const label =
      layer === 1
        ? opts.labelBase ?? `${sideLabel} seat`
        : opts.labelLayer?.(layer) ?? `${sideLabel} seat (${ordinal(layer)} layer)`
    const seatZ =
      opts.seatZ +
      opts.axisZ * (layer - 1) * SNAP_CALIBRATION.beamReceivingDepth
    const adjustment =
      opts.layerAdjustments?.[layer] ??
      opts.baseAdjustment +
        (layer - 1) * PIN_CLEARANCE.stackedLayerSeatAdjustmentStep
    ends.push(
      end(id, label, seatZ, opts.axisZ, adjustment, opts.layers - (layer - 1)),
    )
  }
  return ends
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
  // Explicitly calibrated per-layer adjustments (layer number -> value); layers
  // without an entry use base + (layer-1) * stackedLayerSeatAdjustmentStep.
  frontLayerAdjustments?: Record<number, number>
  backLayerAdjustments?: Record<number, number>
  curatedNeedsReview?: boolean
  notes?: string[]
}): PinProfile {
  const spacing = opts.seatSpacing ?? 0
  const frontSeatZ = opts.frontSeatZ ?? -spacing
  const backSeatZ = opts.backSeatZ ?? spacing
  const ends: PinProfileEnd[] = [
    ...sideEnds({
      side: 'front',
      seatZ: frontSeatZ,
      axisZ: -1,
      layers: opts.frontLayers,
      baseAdjustment: opts.finalSeatAdjustmentFront,
      layerAdjustments: opts.frontLayerAdjustments,
    }),
    ...sideEnds({
      side: 'back',
      seatZ: backSeatZ,
      axisZ: 1,
      layers: opts.backLayers,
      baseAdjustment: opts.finalSeatAdjustmentBack,
      layerAdjustments: opts.backLayerAdjustments,
    }),
  ]
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
    ends,
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
    // One insert seat per shaft layer, all on the single insert side (the cap
    // never enters a hole). Layer 1 keeps the id 'pin-front' for save/load
    // compatibility; deeper layers let a 0xN pin join N stacked beams — its
    // actual VEX IQ purpose.
    ends: sideEnds({
      side: 'front',
      seatZ: opts.capInnerZ,
      axisZ: 1,
      layers: opts.usableLayers,
      baseAdjustment: 0,
      labelBase: 'Insert end (capped shaft)',
      labelLayer: (layer) => `Insert end (${ordinal(layer)} layer)`,
    }),
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
    key: 'pin3x3',
    displayName: '3x3 Connector Pin',
    partNumbers: ['228-2500-089'],
    nameIncludes: ['3x3', 'pin'],
    family: 'connector-pin',
    metadataQuality: 'measured',
    seatSpacing: 0,
    frontLayers: 3,
    backLayers: 3,
    // Measured central flange at z=0 with shafts to ±0.742 — same seat model as
    // the calibrated 1x1/2x2, just three layers each side.
    finalSeatAdjustmentFront: PIN_CLEARANCE.pin1x1.frontFinalSeatAdjustment,
    finalSeatAdjustmentBack: PIN_CLEARANCE.pin1x1.backFinalSeatAdjustment,
    notes: [
      'measured central flange at z=0; shafts extend to ±0.742 (3 layers/side)',
      'seat model identical to the calibrated 1x1; longer shafts only',
    ],
  }),
  twoEndedProfile({
    key: 'pin2x3',
    displayName: '2x3 Smooth Idler Pin',
    partNumbers: ['228-2500-093'],
    nameIncludes: ['2x3', 'pin'],
    family: 'idler-pin',
    metadataQuality: 'needs-calibration',
    // Measured flange off-centre at z≈-0.115 (2-layer side -Z, 3-layer side +Z).
    frontSeatZ: -0.115,
    backSeatZ: -0.115,
    frontLayers: 2,
    backLayers: 3,
    finalSeatAdjustmentFront: 0,
    finalSeatAdjustmentBack: 0,
    curatedNeedsReview: true,
    notes: [
      'smooth idler: spins free in the hole — modeled as a plain flanged pin',
      'measured flange off-centre at z≈-0.115; seat depth not visually reviewed',
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
    // The 2-layer back side generates pin-back-2 at the outer layer boundary;
    // its adjustment stays pinned to the visually calibrated value (which the
    // derived stacked-layer step reproduces, but must never drift from).
    backLayerAdjustments: {
      2: PIN_CLEARANCE.pin1x2.backLayer2FinalSeatAdjustment,
    },
    curatedNeedsReview: true,
    notes: [
      'measured flange off-centre at z≈-0.12; seat plane uses the measured flange',
      'back side is 2 layers: pin-back seats beam 1 at the flange, pin-back-2',
      'seats beam 2 at the outer layer boundary',
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
    // A pin is positionally measured (real axis + seat plane); only its final
    // seat DEPTH may need a visual review (curatedNeedsReview). It is NOT
    // positionally `approximate`, so Basic-Mode Auto Snap can still seat every
    // pin size — the review flag stays for the Properties-panel advisory.
    curatedNeedsReview: profile.curatedNeedsReview,
    compatibleWith: profileEnd.compatibleWith,
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
