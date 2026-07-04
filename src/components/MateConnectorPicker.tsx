import { useMemo, useState } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { buildOccupiedSnapSet, snapKey } from '../utils/snap'
import {
  connectorConfidenceLabel,
  connectorsCompatible,
  getMateConnectorsForPart,
  mateConnectorScore,
} from '../utils/mateConnectors'
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
  needsCalibration: '#f59e0b',
  incompatible: '#5b6472',
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
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const snapDebug = useAssemblyStore((s) => s.snapDebug)
  const camera = useThree((s) => s.camera)
  const [hovered, setHovered] = useState<string | null>(null)

  const connectorsByInstance = useMemo(() => {
    return parts.map((instance) => {
      const def = getPartDefinition(instance.partId)
      return {
        instanceId: instance.instanceId,
        name: def?.name ?? instance.partId,
        connectors: def ? getMateConnectorsForPart(instance, def) : [],
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
          const sourcePicked = !!mateSource
          const compatibleWithSource =
            !mateSource || connectorsCompatible(mateSource.connector, c)
          const targetCandidate = sourcePicked && mateSource?.instanceId !== instanceId
          const blocked =
            (targetCandidate && (!compatibleWithSource || isOccupied)) ||
            (!targetCandidate && !isSource && isOccupied)
          // Scope the picker to the current step so the viewport stays calm:
          // step 1 shows free connectors (only the selected part's, if there is
          // a selection); step 2 shows the source dot plus compatible free
          // targets on OTHER parts. Snap Debug restores the full noisy view.
          if (!snapDebug) {
            const show = !sourcePicked
              ? !isOccupied && (!selectedId || instanceId === selectedId)
              : isSource ||
                isTarget ||
                (targetCandidate && compatibleWithSource && !isOccupied)
            if (!show) return null
          }
          let color: string = COLOR.idle
          if (isSource) color = COLOR.source
          else if (isTarget) color = COLOR.target
          else if (isHovered) color = COLOR.hover
          else if (isOccupied) color = COLOR.occupied
          else if (sourcePicked && !compatibleWithSource) color = COLOR.incompatible
          else if (c.quality === 'needsCalibration') color = COLOR.needsCalibration
          // Step 2 of the guided flow: free compatible targets read green, the
          // same "compatible" convention Joint Mode uses.
          else if (targetCandidate && compatibleWithSource) color = COLOR.target
          const active = isSource || isTarget || isHovered
          const radius = active ? R_ACTIVE : R_DOT
          const toCamera = new THREE.Vector3()
            .subVectors(camera.position, new THREE.Vector3(...c.origin))
            .normalize()
          const facingDot = Math.abs(
            toCamera.dot(new THREE.Vector3(...c.axisZ).normalize()),
          )
          const score = mateConnectorScore(c, {
            source: mateSource?.connector ?? null,
            occupied: isOccupied,
            facingDot,
          })
          return (
            <group key={k}>
              <mesh
                position={c.origin}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerOver={(e) => {
                  e.stopPropagation()
                  setHovered(k)
                  setStatus(
                    [
                      name,
                      c.label ?? c.id,
                      `${c.type} · ${connectorConfidenceLabel(c)}`,
                      `source: ${c.source}`,
                      c.snapId ? `snap: ${c.snapId}` : null,
                      isOccupied ? 'occupied' : null,
                      sourcePicked && !compatibleWithSource
                        ? 'not compatible with source'
                        : null,
                      `score ${score.toFixed(2)}`,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  )
                }}
                onPointerOut={(e) => {
                  e.stopPropagation()
                  setHovered((h) => (h === k ? null : h))
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (blocked) {
                    setStatus(
                      isOccupied
                        ? 'Connector is occupied. Pick a free connector or replace the mate first.'
                        : 'Connector is not compatible with the selected source.',
                    )
                    return
                  }
                  pickMateConnector(instanceId, c)
                }}
              >
                <sphereGeometry args={[radius, 12, 12]} />
                <meshBasicMaterial
                  color={color}
                  transparent
                  opacity={blocked && !active ? 0.35 : isOccupied && !active ? 0.45 : 0.95}
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
