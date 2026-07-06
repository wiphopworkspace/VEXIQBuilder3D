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
  showTriad,
}: {
  connector: MateConnector
  color: string
  // The CAD axis-arrow triad is an Advanced-Mode cue; hide it in Basic Mode so a
  // selected connected part shows only a small joint dot, not a big gizmo.
  showTriad: boolean
}) {
  const warning =
    connector.source === 'fallback' || connector.quality === 'needsCalibration'
  return (
    <group>
      <mesh position={connector.origin} raycast={NO_RAYCAST} renderOrder={10}>
        {/* One fixed radius so the joint dot is the SAME size on every part and
            pin (it sits at a world position at the scene root, so it never
            scales with the part). Warning state is shown by color only. */}
        <sphereGeometry args={[0.04, 14, 14]} />
        <meshBasicMaterial
          color={warning ? '#f59e0b' : color}
          transparent
          opacity={0.95}
          depthTest={false}
        />
      </mesh>
      {showTriad && <MateConnectorTriad connector={connector} length={0.16} />}
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
  const easyMode = useAssemblyStore((s) => s.easyMode)

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
      {source && (
        <Endpoint connector={source} color="#ffe24d" showTriad={!easyMode} />
      )}
      {target && (
        <Endpoint connector={target} color="#37d67a" showTriad={!easyMode} />
      )}
    </group>
  )
}
