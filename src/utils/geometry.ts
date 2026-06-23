import { HOLE_PITCH } from '../data/parts'

// Shared geometric constants for procedural placeholder models. Keeping these
// in one place makes it easy to tune the visual scale of every part at once.

export const BEAM_WIDTH = HOLE_PITCH * 0.9 // cross-section width (2-wide beam)
export const BEAM_HEIGHT = HOLE_PITCH * 0.45 // cross-section height
export const HOLE_RADIUS = HOLE_PITCH * 0.28
export const PIN_RADIUS = HOLE_PITCH * 0.22
export const PIN_LENGTH = HOLE_PITCH * 1.1
export const AXLE_SIZE = HOLE_PITCH * 0.22

/** Length in world units for a beam/axle of `holes` holes. */
export function lengthForHoles(holes: number): number {
  return holes * HOLE_PITCH
}
