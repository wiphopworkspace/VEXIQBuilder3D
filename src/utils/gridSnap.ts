// CAD-style grid movement helpers, VEX IQ native.
//
// The key idea: quantize a dragged part so its HOLES land on the world
// lattice, not its origin. VEX IQ holes repeat on a 0.5 world-unit pitch, but
// a part's origin is its bounding-box center, which is NOT reliably on that
// lattice relative to its own holes — an even-length beam's center sits
// between holes (holes at ±0.25, ±0.75 …), and electronics/specialty parts
// have measured mount holes at arbitrary offsets from their bbox center.
// Quantizing the origin therefore strands those holes off-lattice, and two
// parts dragged "onto the grid" end up with holes that never line up for a
// pin. Registering one reference hole to the lattice instead guarantees every
// hole on every part sits on the shared 0.25 superlattice (intra-part hole
// offsets are all multiples of 0.25), so holes across parts either coincide
// exactly or sit a clean step apart — Auto Snap fires deterministically and
// pins always have a real hole pair to join.

import * as THREE from 'three'
import type { PartDefinition, Vec3 } from '../types/assembly'
import { getSnapPoints } from '../data/snapOverrides'

/** One VEX IQ hole pitch in world units. */
export const HOLE_PITCH = 0.5

// Shared move/rotation step presets (SnapSettings buttons + number-key
// shortcuts). Index = the digit key that selects it: plain 0–4 for the move
// grid, Shift+0–4 for the rotation step. RoboStem uses Ctrl+1–4 for rotation,
// but browsers reserve Ctrl+digit for tab switching, so Shift replaces Ctrl.
// 0.25 (half pitch) is the default move step — it matches the y=0.25 resting
// height AND is the finest grid on which every VEX hole phase is reachable
// (the staggered beam grid offsets Grid-B holes by 0.25 from Grid-A).
export const MOVE_STEP_PRESETS = [
  { label: 'Free', value: 0 },
  { label: 'Fine', value: 0.05 },
  { label: '½ hole', value: 0.25 },
  { label: '1 hole', value: 0.5 },
  { label: '2 holes', value: 1 },
] as const

export const ROTATION_STEP_PRESETS = [
  { label: 'Free', value: 0 },
  { label: '15°', value: 15 },
  { label: '30°', value: 30 },
  { label: '45°', value: 45 },
  { label: '90°', value: 90 },
] as const

/** Human label for the active move step, for status/HUD display. */
export function moveStepLabel(step: number): string {
  const preset = MOVE_STEP_PRESETS.find((p) => p.value === step)
  return preset ? preset.label : `${step}u`
}

/**
 * Local position of the part's grid reference feature: the snap point nearest
 * the part origin (a beam's center-most hole, a pin's shaft seat). Null when
 * the part has no snap points at all — the caller falls back to quantizing
 * the origin. Resolution cost is one getSnapPoints call; compute this once
 * per drag/drop, not per pointer move.
 *
 * Beam-grid and electronics hole snaps are FACE points, offset ±halfThickness
 * along the hole axis from the physical hole center — and the front/back face
 * of one through-hole share an `occupancyGroup`. Averaging the group cancels
 * that axis offset, so the reference is the true hole CENTER and the lattice
 * phase never absorbs a thickness offset (which would skew registration by
 * 0.12 whenever the hole axis lies in the ground plane).
 */
export function latticeReferenceLocal(
  definition: PartDefinition | null | undefined,
): Vec3 | null {
  if (!definition) return null
  const points = getSnapPoints(definition)
  if (points.length === 0) return null
  let best = points[0]
  let bestD = Infinity
  for (const p of points) {
    const [x, y, z] = p.position
    const d = x * x + y * y + z * z
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  if (best.occupancyGroup) {
    const group = points.filter((p) => p.occupancyGroup === best.occupancyGroup)
    if (group.length > 1) {
      const mid: Vec3 = [0, 0, 0]
      for (const p of group) {
        mid[0] += p.position[0] / group.length
        mid[1] += p.position[1] / group.length
        mid[2] += p.position[2] / group.length
      }
      return mid
    }
  }
  return best.position
}

const scratchOffset = new THREE.Vector3()
const scratchScale = new THREE.Vector3()
const scratchEuler = new THREE.Euler()

/**
 * Quantize a ground-plane position (x/z; y is the drag plane's, untouched) to
 * the `step` grid so the part's reference hole lands on the world lattice.
 * Rotation-aware: the local reference offset is rotated by the instance
 * rotation first, so a 90°-turned beam keeps its holes on-lattice. Mutates
 * and returns `position`. `step <= 0` (free movement) is a no-op.
 */
export function quantizeToHoleLattice(
  position: THREE.Vector3,
  step: number,
  rotation: Vec3,
  reference: Vec3 | null,
  scale?: Vec3,
): THREE.Vector3 {
  if (step <= 0) return position
  let offX = 0
  let offZ = 0
  if (reference) {
    scratchOffset.set(reference[0], reference[1], reference[2])
    if (scale) scratchOffset.multiply(scratchScale.set(scale[0], scale[1], scale[2]))
    scratchOffset.applyEuler(
      scratchEuler.set(rotation[0], rotation[1], rotation[2]),
    )
    offX = scratchOffset.x
    offZ = scratchOffset.z
  }
  // Round the REFERENCE HOLE's world position to the lattice, then carry the
  // origin along. The final 1e-4 cleanup keeps store positions tidy (0.475,
  // not 0.47500000000000003) without disturbing calibrated 1e-3 clearances.
  position.x =
    Math.round((Math.round((position.x + offX) / step) * step - offX) * 10000) /
    10000
  position.z =
    Math.round((Math.round((position.z + offZ) / step) * step - offZ) * 10000) /
    10000
  return position
}
