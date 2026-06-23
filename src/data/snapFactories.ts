import type { PartCategory, SnapPointDefinition } from '../types/assembly'
import {
  HOLE_PITCH,
  generateSnapPoints,
  makeBeamHoles,
} from '../utils/snapPointGenerator'

// Re-exported so existing imports (`parts.ts`) keep working from one place.
export { HOLE_PITCH, makeBeamHoles }

/** Map a part category to its procedural placeholder geometry kind. */
export function proceduralForCategory(
  category: PartCategory,
): import('../types/assembly').ProceduralKind {
  switch (category) {
    case 'Beams':
      return 'beam'
    case 'Pins':
      return 'pin'
    case 'Axles':
      return 'axle'
    case 'Gears':
      return 'gear'
    case 'Wheels':
      return 'wheel'
    case 'Electronics':
      return 'brain'
    case 'Connectors':
      return 'connector'
    case 'Plates':
      return 'plate'
    default:
      return 'box'
  }
}

/**
 * Backwards-compatible helper: fallback snap points for a category. Delegates to
 * the richer {@link generateSnapPoints} using the category's default procedural
 * kind.
 */
export function snapPointsForCategory(
  category: PartCategory,
  holeCount = 6,
): SnapPointDefinition[] {
  return generateSnapPoints(category, proceduralForCategory(category), holeCount)
}
