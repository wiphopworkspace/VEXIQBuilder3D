/**
 * Snap & Joint Calibration — Pin Seating.
 *
 * The seven tolerance concepts below are DELIBERATELY separate values. Before
 * 2026-07-28 the user's snap-distance slider (`snapThreshold`) doubled as the
 * stored-mate validity threshold, so raising the search radius to 1.0 made a
 * mate stretched by 0.9 report as "intact" (measured; see HANDOFF 2026-07-28
 * root cause 1). A search radius answers "what may I reach for?"; a break
 * tolerance answers "has this joint come apart?"; a contact tolerance answers
 * "is this joint mechanically seated?". Collapsing them is what produced the
 * false-intact class of bug — do not re-merge them.
 *
 * Connector-family METADATA remains the source of mechanical accuracy. The
 * values here are a fine calibration adjustment on top of it, never a
 * replacement for a correct contact frame.
 */

/** Effective, fully-resolved pin seating calibration. */
export type PinSeatingCalibration = {
  /**
   * Extra calibrated movement along the insertion axis applied AFTER the
   * mechanical contact planes are aligned. Shipped default 0: the part
   * metadata already carries each family's calibrated seat offset. This exists
   * so a team can nudge every pin uniformly without editing part data.
   */
  pinContactOffset: number
  /** How far Auto Snap may reach for a candidate. Search only — never validity. */
  snapSearchDistance: number
  /** Max |gap| between the two mechanical contact planes on a good seat. */
  axialGapTolerance: number
  /** Max perpendicular offset between the two insertion axes. */
  radialTolerance: number
  /** Max angle between the two insertion axes, in degrees. */
  angularToleranceDeg: number
  /** Contact planes may pre-load into each other by at most this much. */
  penetrationTolerance: number
  /** Beyond this contact-frame error a STORED mate is considered come apart. */
  mateBreakTolerance: number
  /** Max error Joint Mode may introduce into a mate it must preserve. */
  simulatedMoveTolerance: number
  /** Developer overlay: draw contact frames, axes and measured errors. */
  showContactFrames: boolean
}

export type PinSeatingCalibrationInput = Partial<PinSeatingCalibration>

/**
 * SHIPPED DEFAULTS — source-controlled so a new team member gets correct
 * behavior with no manual setup.
 *
 * Calibrated 2026-07-28 against the measured seating matrix (every pin family
 * against every representative receiver family; see `npm run report:pins`):
 *  - radial error measured 0.00000 and angular error 0.000 on every pair, so
 *    those tolerances are set tight enough to catch a real regression
 *  - the largest legitimate axial contact offset in the catalog is the 3-layer
 *    stacked pin seat at -0.025, so `axialGapTolerance` sits just above it and
 *    far below a one-face-flip error (0.24016) or a hole-pitch error (0.5)
 */
export const SHIPPED_PIN_SEATING_CALIBRATION: PinSeatingCalibration = {
  pinContactOffset: 0,
  snapSearchDistance: 0.35,
  axialGapTolerance: 0.03,
  radialTolerance: 0.01,
  angularToleranceDeg: 1,
  penetrationTolerance: 0.03,
  // Independent of `snapSearchDistance` BY DESIGN. Kept at the historical
  // prune value so the deliberate "drag a part away to break it" gesture is
  // unchanged — but it no longer follows the search slider, so widening the
  // search radius can never make a stretched mate count as intact.
  mateBreakTolerance: 0.35,
  // Strict: Joint Mode may not bend an existing assembly. 0.12 sits above real
  // seated gaps (<=0.03) and below every physical mismatch step (0.24 face
  // flip, 0.5 hole pitch).
  simulatedMoveTolerance: 0.12,
  showContactFrames: false,
}

/** Bounds used by both the UI controls and the stored-value validator. */
export const PIN_SEATING_LIMITS: Record<
  Exclude<keyof PinSeatingCalibration, 'showContactFrames'>,
  { min: number; max: number; step: number }
> = {
  pinContactOffset: { min: -0.05, max: 0.05, step: 0.001 },
  snapSearchDistance: { min: 0.1, max: 1, step: 0.01 },
  axialGapTolerance: { min: 0.001, max: 0.12, step: 0.001 },
  radialTolerance: { min: 0.001, max: 0.12, step: 0.001 },
  angularToleranceDeg: { min: 0.1, max: 30, step: 0.1 },
  penetrationTolerance: { min: 0.001, max: 0.12, step: 0.001 },
  mateBreakTolerance: { min: 0.05, max: 1, step: 0.01 },
  simulatedMoveTolerance: { min: 0.02, max: 0.5, step: 0.01 },
}

/** One VEX IQ hole pitch in world units — the UI's unit conversion anchor. */
export const WORLD_UNITS_PER_PITCH = 0.5
/** A real VEX IQ hole pitch is 12.7 mm, which fixes the world->mm conversion. */
export const MM_PER_PITCH = 12.7

export function worldToMm(value: number): number {
  return (value / WORLD_UNITS_PER_PITCH) * MM_PER_PITCH
}

export function worldToPitches(value: number): number {
  return value / WORLD_UNITS_PER_PITCH
}

/** Where an effective value came from — surfaced in the settings UI. */
export type CalibrationOrigin = 'shipped' | 'user' | 'project'

export type ResolvedCalibrationField = {
  value: number | boolean
  origin: CalibrationOrigin
}

// --------------------------------------------------------------- validation

const NUMERIC_KEYS = Object.keys(PIN_SEATING_LIMITS) as Array<
  keyof typeof PIN_SEATING_LIMITS
>

/**
 * Schema-validate a candidate calibration patch. Unknown keys, wrong types and
 * out-of-range numbers are DROPPED rather than clamped silently into the
 * effective set, so a corrupted or downgraded stored blob degrades to the
 * shipped defaults instead of poisoning seating.
 */
export function sanitizePinSeatingCalibration(
  raw: unknown,
): PinSeatingCalibrationInput {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const out: PinSeatingCalibrationInput = {}
  for (const key of NUMERIC_KEYS) {
    const value = input[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const { min, max } = PIN_SEATING_LIMITS[key]
    if (value < min || value > max) continue
    out[key] = value
  }
  if (typeof input.showContactFrames === 'boolean') {
    out.showContactFrames = input.showContactFrames
  }
  return out
}

/**
 * Calibration hierarchy (lowest priority first):
 *   1. shipped application default
 *   2. user-saved web-app default
 *   3. project-specific override
 *
 * Connector-family metadata sits UNDER all of these — it is applied by the
 * seating solver itself and is not expressible as a scalar here.
 */
export function resolvePinSeatingCalibration(
  userDefaults: PinSeatingCalibrationInput | null | undefined,
  projectOverrides: PinSeatingCalibrationInput | null | undefined,
): PinSeatingCalibration {
  return {
    ...SHIPPED_PIN_SEATING_CALIBRATION,
    ...sanitizePinSeatingCalibration(userDefaults ?? {}),
    ...sanitizePinSeatingCalibration(projectOverrides ?? {}),
  }
}

/** Per-field provenance for the settings UI ("shipped / user / project"). */
export function calibrationOrigins(
  userDefaults: PinSeatingCalibrationInput | null | undefined,
  projectOverrides: PinSeatingCalibrationInput | null | undefined,
): Record<keyof PinSeatingCalibration, CalibrationOrigin> {
  const user = sanitizePinSeatingCalibration(userDefaults ?? {})
  const project = sanitizePinSeatingCalibration(projectOverrides ?? {})
  const origins = {} as Record<keyof PinSeatingCalibration, CalibrationOrigin>
  for (const key of Object.keys(
    SHIPPED_PIN_SEATING_CALIBRATION,
  ) as Array<keyof PinSeatingCalibration>) {
    origins[key] =
      project[key] !== undefined
        ? 'project'
        : user[key] !== undefined
          ? 'user'
          : 'shipped'
  }
  return origins
}

/** Only the fields that actually differ from shipped — what we persist. */
export function calibrationDiff(
  value: PinSeatingCalibration,
): PinSeatingCalibrationInput {
  const out: PinSeatingCalibrationInput = {}
  for (const key of Object.keys(
    SHIPPED_PIN_SEATING_CALIBRATION,
  ) as Array<keyof PinSeatingCalibration>) {
    if (value[key] !== SHIPPED_PIN_SEATING_CALIBRATION[key]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(out as any)[key] = value[key]
    }
  }
  return out
}

// -------------------------------------------------------------- persistence

export const PIN_SEATING_STORAGE_KEY = 'vexiq.pinSeatingCalibration.v1'
export const PIN_SEATING_SCHEMA_VERSION = 1

type StoredBlob = {
  version: number
  calibration: PinSeatingCalibrationInput
}

/**
 * Load the user's saved defaults. A blob with a NEWER schema version, a
 * malformed payload, or out-of-range values resolves to "no user defaults"
 * (shipped defaults win) — never to a partially-applied broken set.
 */
export function loadUserPinSeatingCalibration(): PinSeatingCalibrationInput {
  try {
    const raw = localStorage.getItem(PIN_SEATING_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<StoredBlob>
    if (typeof parsed?.version !== 'number') return {}
    if (parsed.version > PIN_SEATING_SCHEMA_VERSION) return {}
    return sanitizePinSeatingCalibration(parsed.calibration)
  } catch {
    return {}
  }
}

export function saveUserPinSeatingCalibration(
  calibration: PinSeatingCalibrationInput,
): void {
  try {
    const blob: StoredBlob = {
      version: PIN_SEATING_SCHEMA_VERSION,
      calibration: sanitizePinSeatingCalibration(calibration),
    }
    localStorage.setItem(PIN_SEATING_STORAGE_KEY, JSON.stringify(blob))
  } catch {
    // Storage unavailable (private mode / Node) — settings stay session-local.
  }
}

export function clearUserPinSeatingCalibration(): void {
  try {
    localStorage.removeItem(PIN_SEATING_STORAGE_KEY)
  } catch {
    // ignore
  }
}
