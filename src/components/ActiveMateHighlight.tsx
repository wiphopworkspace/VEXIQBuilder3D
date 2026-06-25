import type { ConnectionMate, PartInstanceData } from '../types/assembly'
import type { MateConnector } from '../types/mate'
import { getPartDefinition } from '../data/parts'
import { useAssemblyStore } from '../store/assemblyStore'
import { findConnector, resolveConnectorRef } from '../utils/mateConnectors'
import MateConnectorTriad from './MateConnectorTriad'

const NO_RAYCAST = () => null

function resolveEndpointConnector(
  parts: PartInstanceData[],
  mate: ConnectionMate,
  side: 'a' | 'b',
): MateConnector | null {
  const instanceId = side === 'a' ? mate.aInstanceId : mate.bInstanceId
  const snapId = side === 'a' ? mate.aSnapId : mate.bSnapId
  const ref = side === 'a' ? mate.aConnectorRef : mate.bConnectorRef
  const instance = parts.find((p) => p.instanceId === instanceId)
  const definition = instance ? getPartDefinition(instance.partId) : undefined
  if (!instance || !definition) return null
  return (
    resolveConnectorRef(instance, definition, ref) ??
    findConnector(instance, definition, snapId)
  )
}

function Endpoint({
  connector,
  color,
}: {
  connector: MateConnector
  color: string
}) {
  const warning =
    connector.source === 'fallback' || connector.quality === 'needsCalibration'
  return (
    <group>
      <mesh position={connector.origin} raycast={NO_RAYCAST} renderOrder={10}>
        <sphereGeometry args={[warning ? 0.1 : 0.085, 14, 14]} />
        <meshBasicMaterial
          color={warning ? '#f59e0b' : color}
          transparent
          opacity={0.95}
          depthTest={false}
        />
      </mesh>
      <MateConnectorTriad connector={connector} length={0.26} />
    </group>
  )
}

/**
 * Small world-space visual cue for the selected part's active mate. It is
 * intentionally display-only and non-raycastable so it cannot interfere with
 * selection, TransformControls, or snap markers.
 */
export default function ActiveMateHighlight() {
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const parts = useAssemblyStore((s) => s.parts)
  const connections = useAssemblyStore((s) => s.connections)
  const activeMateId = useAssemblyStore((s) => s.activeMateId)

  if (!selectedId) return null
  const mates = connections.filter(
    (c) => c.aInstanceId === selectedId || c.bInstanceId === selectedId,
  )
  if (mates.length === 0) return null

  const mate =
    mates.find((m) => m.id === activeMateId[selectedId]) ??
    (mates.length === 1 ? mates[0] : null)
  if (!mate) return null

  const ownSide = mate.aInstanceId === selectedId ? 'a' : 'b'
  const otherSide = ownSide === 'a' ? 'b' : 'a'
  const source = resolveEndpointConnector(parts, mate, ownSide)
  const target = resolveEndpointConnector(parts, mate, otherSide)
  if (!source && !target) return null

  return (
    <group>
      {source && <Endpoint connector={source} color="#ffe24d" />}
      {target && <Endpoint connector={target} color="#37d67a" />}
    </group>
  )
}
