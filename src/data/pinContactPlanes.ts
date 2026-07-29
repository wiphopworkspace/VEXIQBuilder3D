/**
 * THE single owner of a pin-side endpoint's mechanical contact plane.
 *
 * Every pin, peg, standoff, cap and barrel endpoint in the catalog gets its
 * seat frame rewritten here, from the mesh measurement in
 * `measuredPinContacts.ts`, no matter which metadata layer produced it
 * (pin profile, curated override, procedural part, measured-hole layer).
 * Nothing downstream may add a second axial correction.
 *
 * WHY this exists — the defect it replaces:
 *   The seat plane used to be a hand-written constant per family. For every
 *   flanged connector pin that constant was the collar MIDPLANE, so the collar
 *   was driven 0.035 into the receiving part; for the pitch standoffs it was
 *   the part CENTRE, so a 4x Pitch Standoff buried 1.0 world units (25 mm) of
 *   its body inside a beam. Both passed the old checks because the old checks
 *   only compared snap-marker alignment, never the real stopping surface.
 *
 * THE RULE (see `scripts/measure-pin-contacts.ts` for the measurement):
 *   A connector enters a receiver until its cross-section can no longer pass
 *   through the hole. The stopping surface is therefore the first plane, going
 *   outward from the shaft tip, whose radius exceeds the pin-hole radius.
 *
 * LAYER SEATS: a multi-layer side (`pin-front-2`, `pin-back-3`, …) already has
 * its marker stepped one receiver thickness further out, so applying the SAME
 * base-endpoint shoulder offset to every layer puts each layer's contact plane
 * exactly one receiver thickness beyond the previous one. That is why stacked
 * seats need no per-layer term and must never accumulate one.
 */
import type { PartDefinition, SnapPointDefinition, Vec3 } from '../types/assembly'
import { MEASURED_PIN_CONTACTS, type MeasuredPinContact } from './measuredPinContacts'
import { PIN_CONTACT } from './snapCalibration'

const PIN_SIDE_TYPES = new Set(['pin', 'connector'])

function isPinSideSnap(snap: SnapPointDefinition): boolean {
  return PIN_SIDE_TYPES.has(snap.type) && snap.role !== 'receive'
}

/**
 * Built-in SAMPLE parts whose "mesh" is a procedural placeholder, not a
 * converted VEX IQ model. They are review-gated, not exempted.
 *
 * The procedural `pin` is a uniform-radius cylinder (`ProceduralModel.tsx`,
 * `case 'pin'`): it has no collar, so it has no mechanical stopping surface at
 * all, and any seat offset for it would be invented. It used to carry a -0.005
 * pre-load, which was the last non-zero contact gap left in the catalog.
 *
 * They keep working in explicit Joint Mode; they are only kept out of
 * Basic-Mode Auto Snap and out of the production matrix, exactly like every
 * other endpoint whose contact plane cannot be measured.
 */
export const PROCEDURAL_PIN_PART_IDS = new Set(['pin', 'corner-connector'])

const PROCEDURAL_NOTE =
  'procedural sample part — placeholder geometry has no measurable stopping surface'

/** `pin-front-2` → `pin-front`; `peg-3` and `pin-front` are their own base. */
export function basePinEndpointId(snapId: string): string {
  const m = /^(pin-front|pin-back)-\d+$/.exec(snapId)
  return m ? m[1] : snapId
}

function lookup(
  def: PartDefinition,
  snapId: string,
): MeasuredPinContact | undefined {
  const rows =
    MEASURED_PIN_CONTACTS[def.partNumber ?? ''] ??
    MEASURED_PIN_CONTACTS[def.id] ??
    undefined
  if (!rows) return undefined
  const base = basePinEndpointId(snapId)
  return rows.find((r) => r.snapId === base) ?? rows.find((r) => r.snapId === snapId)
}

function unit(v: Vec3 | undefined, fallback: Vec3): Vec3 {
  if (!v) return fallback
  const l = Math.hypot(v[0], v[1], v[2])
  if (l < 1e-10) return fallback
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * Rewrite every pin-side endpoint's seat frame onto its measured stopping
 * surface, and collapse the axial calibration to ONE documented term.
 */
export function applyMeasuredContactPlanes(
  def: PartDefinition,
  snaps: SnapPointDefinition[],
): SnapPointDefinition[] {
  const procedural = PROCEDURAL_PIN_PART_IDS.has(def.id)
  let changed = false
  const out = snaps.map((snap) => {
    if (!isPinSideSnap(snap)) return snap
    const measured = procedural ? undefined : lookup(def, snap.id)
    if (!measured) {
      changed = true
      return {
        ...snap,
        contactPlaneMeasured: false,
        // No mesh evidence for this stopping surface — keep it usable in
        // explicit Joint Mode but out of Basic-Mode Auto Snap. Zero the seat
        // offset too: an invented pre-load on an unmeasured plane is exactly
        // the kind of hidden constant this module exists to remove.
        finalSeatAdjustment: 0,
        sourceSideSeatAdjustment: 0,
        targetSideSeatAdjustment: 0,
        approximate: true,
        curatedNeedsReview: true,
        contactPlaneNote: procedural
          ? PROCEDURAL_NOTE
          : 'no mesh measurement for this endpoint',
      }
    }

    const marker = (snap.mateFrame?.position ?? snap.position) as Vec3
    const axis = unit(
      (snap.mateFrame?.axis ?? snap.axis ?? snap.normal) as Vec3 | undefined,
      [0, 0, 1],
    )
    const seat: Vec3 = [
      marker[0] + axis[0] * measured.shoulderOffset,
      marker[1] + axis[1] * measured.shoulderOffset,
      marker[2] + axis[2] * measured.shoulderOffset,
    ]
    // ONE axial term. Negative = the documented render overlap; 0 = exact
    // surface contact. There is deliberately no per-family and no per-layer
    // component — the geometry above already carries every real difference.
    const overlap = -PIN_CONTACT.shoulderOverlap
    changed = true
    const next: SnapPointDefinition = {
      ...snap,
      seatFrame: { position: seat, axis, up: snap.seatFrame?.up ?? snap.mateFrame?.up ?? [0, 1, 0] },
      seatPosition: seat,
      finalSeatAdjustment: overlap,
      sourceSideSeatAdjustment: overlap,
      targetSideSeatAdjustment: overlap,
      // Inert once a seat frame exists, but leaving a stale value here is how
      // a "second owner" grows back. Drop it.
      insertionDepthCorrection: undefined,
      contactPlaneMeasured: true,
    }
    if (!measured.insertable) {
      next.approximate = true
      next.curatedNeedsReview = true
      next.contactPlaneNote =
        'mesh has no hole-passing shaft beyond the stopping surface — this endpoint cannot insert'
    }
    return next
  })
  return changed ? out : snaps
}
