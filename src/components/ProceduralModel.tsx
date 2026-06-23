import type { PartDefinition } from '../types/assembly'
import {
  AXLE_SIZE,
  BEAM_HEIGHT,
  BEAM_WIDTH,
  HOLE_RADIUS,
  PIN_LENGTH,
  PIN_RADIUS,
  lengthForHoles,
} from '../utils/geometry'

type Props = {
  definition: PartDefinition
  color: string
}

/**
 * Lightweight procedural placeholder geometry for each VEX IQ part category.
 * These stand in for real GLB models and are intentionally simple. They are
 * positioned so that snap point local coordinates line up with the geometry.
 *
 * Visual-only: interactive snap markers (incl. clickable beam holes for Pin
 * Mode) are rendered separately by SnapPointMarkers.
 */
export default function ProceduralModel({ definition, color }: Props) {
  switch (definition.procedural) {
    case 'beam': {
      const length = lengthForHoles(definition.length ?? 6)
      return (
        <group>
          <mesh castShadow={false}>
            <boxGeometry args={[length, BEAM_HEIGHT, BEAM_WIDTH]} />
            <meshStandardMaterial color={color} metalness={0.1} roughness={0.7} />
          </mesh>
          {/* Static visual hole dots (interaction handled by SnapPointMarkers). */}
          {definition.snapPoints
            .filter((s) => s.type === 'hole')
            .map((s) => (
              <mesh
                key={s.id}
                position={s.position}
                rotation={[Math.PI / 2, 0, 0]}
                raycast={() => null}
              >
                <cylinderGeometry
                  args={[HOLE_RADIUS, HOLE_RADIUS, BEAM_HEIGHT * 1.2, 16]}
                />
                <meshStandardMaterial color="#0c0e12" />
              </mesh>
            ))}
        </group>
      )
    }

    case 'pin': {
      return (
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[PIN_RADIUS, PIN_RADIUS, PIN_LENGTH, 14]} />
          <meshStandardMaterial color={color} metalness={0.2} roughness={0.5} />
        </mesh>
      )
    }

    case 'axle': {
      const length = lengthForHoles(definition.length ?? 2)
      return (
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[AXLE_SIZE, length, AXLE_SIZE]} />
          <meshStandardMaterial color={color} metalness={0.4} roughness={0.4} />
        </mesh>
      )
    }

    case 'gear': {
      return (
        <group rotation={[Math.PI / 2, 0, 0]}>
          <mesh>
            <cylinderGeometry args={[0.32, 0.32, 0.12, 20]} />
            <meshStandardMaterial color={color} metalness={0.2} roughness={0.6} />
          </mesh>
          {/* Teeth ring approximation */}
          <mesh>
            <torusGeometry args={[0.32, 0.05, 8, 24]} />
            <meshStandardMaterial color={color} metalness={0.2} roughness={0.6} />
          </mesh>
          {/* Bore */}
          <mesh>
            <cylinderGeometry args={[0.06, 0.06, 0.16, 8]} />
            <meshStandardMaterial color="#0c0e12" />
          </mesh>
        </group>
      )
    }

    case 'wheel': {
      return (
        <group rotation={[Math.PI / 2, 0, 0]}>
          <mesh>
            <cylinderGeometry args={[0.4, 0.4, 0.22, 24]} />
            <meshStandardMaterial color={color} metalness={0.0} roughness={0.9} />
          </mesh>
          {/* Hub */}
          <mesh>
            <cylinderGeometry args={[0.18, 0.18, 0.24, 16]} />
            <meshStandardMaterial color="#c8cdd6" metalness={0.1} roughness={0.6} />
          </mesh>
          {/* Center axle hole marker */}
          <mesh>
            <cylinderGeometry args={[0.07, 0.07, 0.26, 8]} />
            <meshStandardMaterial color="#0c0e12" />
          </mesh>
        </group>
      )
    }

    case 'motor': {
      return (
        <group>
          {/* Main housing */}
          <mesh>
            <boxGeometry args={[0.75, 0.5, 0.6]} />
            <meshStandardMaterial color={color} metalness={0.1} roughness={0.5} />
          </mesh>
          {/* Output shaft housing */}
          <mesh position={[0, 0, 0.36]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.16, 0.16, 0.16, 16]} />
            <meshStandardMaterial color="#3a3f4b" metalness={0.3} roughness={0.5} />
          </mesh>
          {/* Output shaft */}
          <mesh position={[0, 0, 0.5]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.18, 12]} />
            <meshStandardMaterial color="#c8cdd6" metalness={0.6} roughness={0.3} />
          </mesh>
          {/* Darker port detail on the back */}
          <mesh position={[0, 0, -0.31]}>
            <boxGeometry args={[0.28, 0.16, 0.04]} />
            <meshStandardMaterial color="#15181f" metalness={0.2} roughness={0.7} />
          </mesh>
        </group>
      )
    }

    case 'brain': {
      // Stand-in for Robot Brain / Controller / Battery / sensors: a module
      // box with a screen/panel and a couple of port rectangles.
      return (
        <group>
          <mesh>
            <boxGeometry args={[0.8, 0.55, 0.5]} />
            <meshStandardMaterial color={color} metalness={0.1} roughness={0.55} />
          </mesh>
          {/* Screen / front panel */}
          <mesh position={[0, 0.06, 0.26]}>
            <boxGeometry args={[0.5, 0.32, 0.02]} />
            <meshStandardMaterial
              color="#0d1b2a"
              emissive="#15314f"
              emissiveIntensity={0.5}
              metalness={0.2}
              roughness={0.4}
            />
          </mesh>
          {/* Port rectangles along the bottom edge */}
          {[-0.22, 0, 0.22].map((x) => (
            <mesh key={x} position={[x, -0.2, 0.26]}>
              <boxGeometry args={[0.12, 0.08, 0.03]} />
              <meshStandardMaterial color="#15181f" roughness={0.7} />
            </mesh>
          ))}
        </group>
      )
    }

    case 'connector': {
      return (
        <group>
          {/* Two arms meeting at a right angle. */}
          <mesh position={[0.18, 0, 0]}>
            <boxGeometry args={[0.36, 0.18, 0.18]} />
            <meshStandardMaterial color={color} metalness={0.1} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0, 0.18]}>
            <boxGeometry args={[0.18, 0.18, 0.36]} />
            <meshStandardMaterial color={color} metalness={0.1} roughness={0.6} />
          </mesh>
        </group>
      )
    }

    case 'plate': {
      return (
        <mesh>
          <boxGeometry args={[1.2, 0.12, 0.75]} />
          <meshStandardMaterial color={color} metalness={0.1} roughness={0.7} />
        </mesh>
      )
    }

    case 'box':
    default:
      return (
        <mesh>
          <boxGeometry args={[0.5, 0.5, 0.5]} />
          <meshStandardMaterial color={color} metalness={0.1} roughness={0.6} />
        </mesh>
      )
  }
}
