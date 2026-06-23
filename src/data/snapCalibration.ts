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
   * Prevents visual overlap when a second beam/part is snapped onto the exposed
   * pin side. This is a part-to-part face clearance, not a pin seat offset.
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

export const PIN_CLEARANCE = {
  defaultPinFaceClearance: SNAP_CALIBRATION.pinFaceClearance,
  defaultBeamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,

  pin1x1: {
    beamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,
    frontFinalSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
    backFinalSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
  },

  pin1x2: {
    beamToBeamFaceClearance: SNAP_CALIBRATION.beamToBeamFaceClearance,
    frontFinalSeatAdjustment: SNAP_CALIBRATION.pinFrontFinalSeatAdjustment,
    backFinalSeatAdjustment: SNAP_CALIBRATION.pinBackFinalSeatAdjustment,
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

export function beamFaceOffset(
  depth: number = SNAP_CALIBRATION.defaultBeamHoleDepth,
) {
  return depth / 2
}
