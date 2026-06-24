import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { MateConnector } from '../types/mate'

/**
 * Small local-axis triad for a Mate Connector, drawn in WORLD space (the picker
 * overlay is a sibling of the transformed part groups). X=red, Y=green, Z=blue,
 * where Z is the mate/insertion axis. Visual only — never raycastable.
 */
export default function MateConnectorTriad({
  connector,
  length = 0.32,
}: {
  connector: MateConnector
  length?: number
}) {
  const arrows = useMemo(() => {
    const origin = new THREE.Vector3(...connector.origin)
    const make = (axis: number[], color: number) => {
      const dir = new THREE.Vector3(...axis)
      if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1)
      dir.normalize()
      const arrow = new THREE.ArrowHelper(
        dir,
        origin,
        length,
        color,
        length * 0.3,
        length * 0.18,
      )
      arrow.raycast = () => null
      arrow.traverse((o) => (o.raycast = () => null))
      return arrow
    }
    return [
      make(connector.axisX, 0xff5555),
      make(connector.axisY, 0x55dd66),
      make(connector.axisZ, 0x4aa8ff),
    ]
  }, [connector, length])

  useEffect(() => {
    return () => {
      arrows.forEach((a) => a.dispose())
    }
  }, [arrows])

  return (
    <group>
      {arrows.map((a, i) => (
        <primitive key={i} object={a} />
      ))}
    </group>
  )
}
