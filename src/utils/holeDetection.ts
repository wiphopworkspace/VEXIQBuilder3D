import * as THREE from 'three'
import type { SnapPointDefinition } from '../types/assembly'

/**
 * EXPERIMENTAL — do not rely on this for the MVP.
 *
 * Automatic hole detection from arbitrary GLB/STEP-converted meshes is hard and
 * unreliable: a tessellated mesh has no notion of "a hole", only triangles.
 * Real CAD hole/feature recognition needs the BREP topology that GLB throws
 * away. The supported path is curated snap-point metadata plus the inferred
 * defaults in `snapPointGenerator.ts`.
 *
 * This stub demonstrates the *shape* of a future heuristic: scan an object's
 * geometry, look at its local bounding box, and emit candidate snap points
 * spaced along the longest axis (a crude guess at a beam's hole row). It is not
 * geometric hole recognition and should be treated as a research placeholder.
 */
export function detectHoleCandidates(
  object: THREE.Object3D,
  options: { spacing?: number; maxHoles?: number } = {},
): SnapPointDefinition[] {
  const spacing = options.spacing ?? 0.5
  const maxHoles = options.maxHoles ?? 12

  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return []

  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  // Longest horizontal axis is assumed to be the "hole row" direction.
  const axis: 'x' | 'z' = size.x >= size.z ? 'x' : 'z'
  const length = axis === 'x' ? size.x : size.z
  const count = Math.min(maxHoles, Math.max(1, Math.round(length / spacing)))
  const start = -((count - 1) / 2) * spacing

  const holes: SnapPointDefinition[] = []
  for (let i = 0; i < count; i++) {
    const along = start + i * spacing
    holes.push({
      id: `auto-hole-${i}`,
      type: 'hole',
      position:
        axis === 'x'
          ? [center.x + along, center.y, center.z]
          : [center.x, center.y, center.z + along],
      normal: [0, 1, 0],
      compatibleWith: ['pin', 'connector'],
    })
  }
  return holes
}
