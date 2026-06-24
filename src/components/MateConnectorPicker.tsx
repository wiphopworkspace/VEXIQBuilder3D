import { useMemo, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { buildOccupiedSnapSet, snapKey } from '../utils/snap'
import { connectorsForInstance } from '../utils/mateConnectors'
import type { MateConnector } from '../types/mate'
import MateConnectorTriad from './MateConnectorTriad'

const R_DOT = 0.07
const R_ACTIVE = 0.11

const COLOR = {
  source: '#ffe24d',
  target: '#37d67a',
  hover: '#ffffff',
  idle: '#39c5ff',
  occupied: '#9aa3af',
} as const

/**
 * Advanced Mate Connector Tool overlay. Renders clickable connector dots for
 * every part in WORLD space (a sibling of the transformed groups, so it is
 * excluded from selection bounds). Click a source connector, then a target;
 * the store opens the Mate Editor. Mounted only while `mode === 'mate'`.
 */
export default function MateConnectorPicker() {
  const parts = useAssemblyStore((s) => s.parts)
  const connections = useAssemblyStore((s) => s.connections)
  const mateSource = useAssemblyStore((s) => s.mateSource)
  const mateTarget = useAssemblyStore((s) => s.mateTarget)
  const pickMateConnector = useAssemblyStore((s) => s.pickMateConnector)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  const [hovered, setHovered] = useState<string | null>(null)

  const connectorsByInstance = useMemo(() => {
    return parts.map((instance) => {
      const def = getPartDefinition(instance.partId)
      return {
        instanceId: instance.instanceId,
        name: def?.name ?? instance.partId,
        connectors: def ? connectorsForInstance(instance, def) : [],
      }
    })
  }, [parts])

  const occupied = useMemo(
    () => buildOccupiedSnapSet(connections, parts),
    [connections, parts],
  )

  const key = (instanceId: string, c: MateConnector) => `${instanceId}::${c.id}`

  return (
    <group>
      {connectorsByInstance.map(({ instanceId, name, connectors }) =>
        connectors.map((c) => {
          const k = key(instanceId, c)
          const isSource =
            mateSource?.instanceId === instanceId &&
            mateSource.connector.id === c.id
          const isTarget =
            mateTarget?.instanceId === instanceId &&
            mateTarget.connector.id === c.id
          const isHovered = hovered === k
          const isOccupied = c.snapId
            ? occupied.has(snapKey(instanceId, c.snapId))
            : false
          let color: string = COLOR.idle
          if (isSource) color = COLOR.source
          else if (isTarget) color = COLOR.target
          else if (isHovered) color = COLOR.hover
          else if (isOccupied) color = COLOR.occupied
          const active = isSource || isTarget || isHovered
          const radius = active ? R_ACTIVE : R_DOT
          return (
            <group key={k}>
              <mesh
                position={c.origin}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerOver={(e) => {
                  e.stopPropagation()
                  setHovered(k)
                  setStatus(
                    `${name} · ${c.label ?? c.id} (${c.type} · ${c.quality})`,
                  )
                }}
                onPointerOut={(e) => {
                  e.stopPropagation()
                  setHovered((h) => (h === k ? null : h))
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  pickMateConnector(instanceId, c)
                }}
              >
                <sphereGeometry args={[radius, 12, 12]} />
                <meshBasicMaterial
                  color={color}
                  transparent
                  opacity={isOccupied && !active ? 0.45 : 0.95}
                  depthTest={false}
                />
              </mesh>
              {active && <MateConnectorTriad connector={c} />}
            </group>
          )
        }),
      )}
    </group>
  )
}
