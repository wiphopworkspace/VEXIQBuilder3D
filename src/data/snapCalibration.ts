export const SNAP_CALIBRATION = {
  // LDCadVEX/LDraw convention: adjacent VEX IQ beam holes are 16 LDraw units
  // apart. This is a reference convention only; app world units are calibrated
  // below and must not be treated as raw LDraw units.
  ldrawHolePitchUnits: 16,
  // Current web-app scale: one VEX IQ pitch is 0.5 world units.
  beamHolePitch: 0.5,
  // Measured common 1xN GLB beam thickness along local Z.
  beamReceivingDepth: 0.24016,
  beamHalfThickness: 0.12008,
  // One VEX IQ plastic layer's thickness in world units (= a beam's depth).
  // Used to reason about how deep each connector-pin side reaches (NxM layers).
  defaultLayerThicknessWorld: 0.24016,
  // Procedural sample beams are wider than the measured generated 1x beams.
  proceduralBeamDepth: 0.45,
  // Measured central collar half-thickness for the 1x1 connector pin.
  pinShoulderOffset: 0.035,
  // The older pin-front/-back mate frame sat on the front/back cue, which left
  // the shoulder shallow. This correction moves the physical seat frame back
  // to the pin shoulder/collar contact plane in the current GLB scale.
  pinInsertionDepthCorrection: 0.035,
  // Calibrated from the Snap Depth Calibration panel. Values are side-specific
  // because the converted 1x1 connector pin is visually mirrored but not
  // perfectly depth-symmetric after centering and shoulder-frame placement.
  pinFrontFinalSeatAdjustment: -0.005,
  pinBackFinalSeatAdjustment: -0.005,
  // Back-compatible default used by older helpers; front is the Pin Mode
  // insertion default.
  pinFinalSeatAdjustment: -0.005,
  /**
   * Measured working clearance between two VEX IQ parts connected by a 1x1 pin.
   * This is a part-to-part face clearance, not a pin seat offset — and since
   * 2026-08-03 it is PRODUCED, not applied: with both contact planes measured,
   *
   *   collar thickness (0.070) - 2 x hole pocket depth (0.0301) = 0.0098
   *
   * falls straight out of the geometry (asserted by `verify:pins` [4b]). It
   * survives here as the independently measured reference the produced value is
   * checked against, and as the Properties-panel readout.
   */
  beamToBeamFaceClearance: 0.01,
  /**
   * Small visual clearance for pin shoulder/cap to beam face. Keep this
   * separate from beam-to-beam clearance.
   */
  pinFaceClearance: 0.002,
  // Mate frames already put the shoulder on the beam face; keep legacy final
  // insertion depth at 0 and use explicit seat frames for cap-aware depth.
  pinInsertionDepth: 0,
  pinSnapThreshold: 0.35,
  axleSnapThreshold: 0.35,
  wheelCenterSeatOffset: 0,
  gearCenterSeatOffset: 0,

  // Back-compatible aliases used by older snap helpers.
  defaultBeamHoleDepth: 0.24016,
  defaultProceduralBeamHoleDepth: 0.45,
  defaultPinSeatOffset: 0.035,
  defaultPinInsertionDepth: 0,
} as const

/**
 * Measured VEX IQ pin/hole fit. These are mesh measurements, not conventions —
 * `npm run measure:pins` re-derives the stopping surface of every connector
 * from them, so they must stay honest to the converted GLBs.
 *
 * Measured on `1x4 Beam (228-2500-003)` and the connector-pin family:
 *   - beam pin-hole radius            0.08268  (Ø 4.20 mm at 1 unit = 25.4 mm)
 *   - connector friction-shaft radius 0.09055  (ribbed; a real interference fit)
 *   - connector collar / cap radius   0.12500  (Ø 6.35 mm — cannot enter a hole)
 *
 * `blockingRadius` sits between the shaft ribs and the collar: any cross-section
 * wider than this cannot pass through a pin hole, so the first such plane along
 * the insertion axis IS the mechanical stopping surface.
 */
export const PIN_FIT = {
  holeRadius: 0.08268,
  shaftRadiusMax: 0.09055,
  collarRadius: 0.125,
  blockingRadius: 0.0975,
  get fitTolerance() {
    return this.blockingRadius - this.holeRadius
  },
  layerThickness: 0.24016,
} as const

/**
 * The ONE intended axial term in the whole pin system.
 *
 * Every pin-side contact plane is now the MEASURED stopping surface
 * (`measuredPinContacts.ts`, applied by `pinContactPlanes.ts`), so the target
 * is exact surface contact and this is the only deliberate deviation from it.
 *
 * `shoulderOverlap` ships at 0 — a true `contact gap = 0`. A tiny overlap is
 * only justified where two coincident faces would z-fight in view, and a pin's
 * stopping surface never is: the collar (Ø0.25) always seats fully inside the
 * receiver's face footprint, so the coincident pair is hidden between two
 * opaque solids. Verified by close-up browser inspection — see HANDOFF.
 *
 * If a future part DOES need an overlap, raise it here, keep it below
 * `PIN_CONTACT.visibleThreshold`, and document the part in HANDOFF. It must
 * stay independent of mate-break tolerance and of snap search distance.
 */
export const PIN_CONTACT = {
  shoulderOverlap: 0,
  /**
   * Roughly one screen pixel at a close-up framing of a single beam. An
   * intended overlap above this would be visible and is not allowed.
   */
  visibleThreshold: 0.004,
} as const

export const PIN_CLEARANCE = {
  defaultPinFaceClearance: SNAP_CALIBRATION.pinFaceClearance,
  defaultBeamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,

  /**
   * DELIBERATELY 0 — do not restore a non-zero step.
   *
   * This used to be `-beamToBeamFaceClearance` (-0.010), described as "baking
   * in the stacked-beam clearance". The sign was inverted: a negative term
   * drives each stacked receiver INTO the previous one, and because it was
   * multiplied by (layer - 1) it compounded to -0.005 / -0.015 / -0.025 at
   * layers 1/2/3 — 0.010 of real beam-into-beam mesh penetration per layer,
   * which is what forced `penetrationTolerance` up to 0.03.
   *
   * No per-layer term is needed at all: a layer-k seat marker already sits one
   * receiver thickness further out than layer k-1, so one shared shoulder
   * offset puts consecutive receivers exactly face to face.
   */
  stackedLayerSeatAdjustmentStep: 0,

  pin1x1: {
    beamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,
    frontFinalSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
    backFinalSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
  },

  pin1x2: {
    beamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,
    // Calibrated from the Snap Depth Calibration panel (visual review).
    frontFinalSeatAdjustment: -0.008,
    backFinalSeatAdjustment: -0.002,
    // The 2-layer back side can also receive a beam at its outer layer boundary
    // (the `pin-back-2` seat). Calibrated from the Snap Depth Calibration panel.
    backLayer2FinalSeatAdjustment: -0.012,
  },

  pin0x2: {
    beamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,
    frontFinalSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
    backFinalSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
  },

  pin0x3: {
    beamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,
    frontFinalSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
    backFinalSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
  },
} as const

/**
 * Half thickness of a receiver — where its OUTER SKIN is, and therefore where
 * the hole MARKER (the clickable dot) belongs.
 *
 * This is deliberately NOT the mechanical seating plane. A real VEX IQ hole
 * sits at the bottom of a moulded pocket roughly 0.030 deep, so a pin's collar
 * stops that much further in. `holeSeatPlanes.ts` owns that plane, from the
 * mesh measurement in `measuredHoleSeats.ts`. Treating this value as the
 * contact face — which the catalog did until 2026-08-03 — floats every pin one
 * pocket depth proud of every beam.
 */
export function beamFaceOffset(
  depth: number = SNAP_CALIBRATION.defaultBeamHoleDepth,
) {
  return depth / 2
}
