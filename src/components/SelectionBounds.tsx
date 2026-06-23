import { useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

// A single shared unit-cube edge geometry, scaled per-frame to the live bounds.
// Edges span -0.5..0.5, so scaling by the box size and positioning at the box
// center makes the outline span exactly min..max.
const UNIT_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))

type Props = {
  /** The visible model root to wrap (NOT a snap marker or the outline itself). */
  targetRef: RefObject<THREE.Object3D | null>
  visible: boolean
}

/**
 * Yellow selection outline that wraps the *entire* visible part.
 *
 * The bounds are recomputed every frame with `Box3().setFromObject(target)`,
 * so the box always matches the real rendered geometry — including circular
 * parts (wheels/discs), async-loaded GLB models, and after any move / rotate /
 * scale. It is rendered in world space (a sibling of the transformed part
 * group), so the box size/center come straight from the world-space Box3.
 */
export default function SelectionBounds({ targetRef, visible }: Props) {
  const lineRef = useRef<THREE.LineSegments>(null)
  const box = useRef(new THREE.Box3()).current
  const size = useRef(new THREE.Vector3()).current
  const center = useRef(new THREE.Vector3()).current

  useFrame(() => {
    const target = targetRef.current
    const line = lineRef.current
    if (!line) return
    if (!visible || !target) {
      line.visible = false
      return
    }

    // Ensure the full transform chain is current before measuring: ancestors
    // (the part's transformed group, possibly mid-gizmo-drag) and descendants
    // (all visible mesh children, incl. async-loaded GLB meshes).
    target.updateWorldMatrix(true, true)
    box.setFromObject(target)

    if (box.isEmpty()) {
      // GLB may not have populated yet — hide until geometry exists.
      line.visible = false
      return
    }

    box.getSize(size)
    box.getCenter(center)
    line.visible = true
    line.position.copy(center)
    // Guard against zero-thickness axes (flat plates) to keep edges visible.
    line.scale.set(
      Math.max(size.x, 1e-3),
      Math.max(size.y, 1e-3),
      Math.max(size.z, 1e-3),
    )
  })

  return (
    <lineSegments ref={lineRef} geometry={UNIT_EDGES} raycast={() => null} visible={false}>
      <lineBasicMaterial color="#e8a33d" depthTest={false} transparent />
    </lineSegments>
  )
}
