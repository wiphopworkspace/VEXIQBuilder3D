/**
 * THE single owner of a RECEIVING hole's mechanical seating plane.
 *
 * The receiver-side twin of `pinContactPlanes.ts`. Every `hole` endpoint in the
 * catalog gets its `facePosition` rewritten here, from the mesh measurement in
 * `measuredHoleSeats.ts`, no matter which metadata layer produced it (beam
 * grid, electronics mount layout, corner-connector layout, measured-hole
 * layer). Nothing downstream may add a second axial correction.
 *
 * WHY this exists — the defect it replaces:
 *   A hole's contact plane was its part's OUTER SKIN. `makeBeamGridOverrides`
 *   placed every beam/plate hole face at `beamFaceOffset(depth) = depth / 2`,
 *   and the mount layouts used `halfDepth` the same way. But a real VEX IQ hole
 *   sits at the bottom of a moulded pocket: measured on `2x2 Beam
 *   (228-2500-017)`, the ring a pin collar lands on is at |z| = 0.0900 while
 *   the raised rib skin is at |z| = 0.1201. Every pin in the catalog therefore
 *   floated 0.0301 (0.76 mm) proud of its receiver, and two beams joined
 *   through a 1x1 pin ended one whole collar (0.070) apart instead of the
 *   measured 0.010 beam-to-beam clearance.
 *
 *   That gap is exactly what the Properties panel's Pin Seat Adjustment was
 *   being used to close by hand, on every pin, one mate at a time — the
 *   "+0.0300 suggested override" every connector family independently
 *   converged on. It was never a pin defect: all four families agreed because
 *   the error belonged to the RECEIVER.
 *
 * THE RULE (see `scripts/measure-hole-seats.ts` for the measurement):
 *   A connector's collar cannot enter the hole, so it lands on the outermost
 *   material in the annulus between the hole radius and the collar radius about
 *   the hole axis. That plane is the seat — whatever formed it.
 *
 * MARKERS DO NOT MOVE. `position` / `mateFrame.position` stay on the outer
 * skin: that is where the clickable dot belongs and what snap ACQUISITION
 * measures against. Only the mechanical contact plane moves. Keeping them
 * separate is also what makes the measurement idempotent — `seatOffset` is
 * measured from the marker, so re-running the script after this correction
 * reproduces the same numbers instead of collapsing them to zero.
 */
import type { PartDefinition, SnapPointDefinition, Vec3 } from '../types/assembly'
import { MEASURED_HOLE_SEATS } from './measuredHoleSeats'

function isReceivingHole(snap: SnapPointDefinition): boolean {
  return snap.type === 'hole' && snap.role === 'receive'
}

/** Measured seat offset for one hole, or undefined when it has no measurement. */
export function measuredHoleSeatOffset(
  def: PartDefinition,
  snapId: string,
): number | undefined {
  const entry =
    MEASURED_HOLE_SEATS[def.partNumber ?? ''] ?? MEASURED_HOLE_SEATS[def.id]
  if (!entry) return undefined
  return entry.bySnapId?.[snapId] ?? entry.seatOffset
}

function unit(v: Vec3 | undefined, fallback: Vec3): Vec3 {
  if (!v) return fallback
  const l = Math.hypot(v[0], v[1], v[2])
  if (l < 1e-10) return fallback
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * Rewrite every receiving hole's contact face onto its measured seating plane.
 *
 * Holes with no measurement keep the authored face — an unmeasurable seat is
 * review-gated, never seated on a guess. In practice that is the handful of
 * parts whose hole sits on a face too narrow to carry a full collar ring.
 */
export function applyMeasuredHoleSeats(
  def: PartDefinition,
  snaps: SnapPointDefinition[],
): SnapPointDefinition[] {
  let changed = false
  const out = snaps.map((snap) => {
    if (!isReceivingHole(snap)) return snap
    const seatOffset = measuredHoleSeatOffset(def, snap.id)
    if (seatOffset === undefined) {
      changed = true
      return {
        ...snap,
        contactPlaneMeasured: false,
        contactPlaneNote:
          'no mesh measurement for this seat — using the authored face plane',
      }
    }
    const marker = (snap.mateFrame?.position ?? snap.position) as Vec3
    // The insertion axis points INTO the part; the seat lies along the OUTWARD
    // normal from the marker, which for a negative (recessed) offset puts it
    // inside the material.
    const axis = unit(
      (snap.mateFrame?.axis ?? snap.axis ?? snap.normal) as Vec3 | undefined,
      [0, 0, -1],
    )
    const face: Vec3 = [
      marker[0] - axis[0] * seatOffset,
      marker[1] - axis[1] * seatOffset,
      marker[2] - axis[2] * seatOffset,
    ]
    changed = true
    return {
      ...snap,
      facePosition: face,
      contactPlaneMeasured: true,
    }
  })
  return changed ? out : snaps
}
