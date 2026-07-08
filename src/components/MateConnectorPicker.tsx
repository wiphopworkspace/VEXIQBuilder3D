import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
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

  // Free connectors on the selected part, for the step-1 quick-mate fast path:
  // clicking a compatible free connector on ANOTHER part mates the selected
  // part straight to it (best free source connector is picked automatically).
  const selectedEntry = selectedId
    ? connectorsByInstance.find((e) => e.instanceId === selectedId)
    : undefined
  const selectedFreeConnectors = useMemo(() => {
    if (!selectedEntry) return []
    return selectedEntry.connectors.filter(
      (c) =>
        !(c.snapId && occupied.has(snapKey(selectedEntry.instanceId, c.snapId))),
    )
  }, [selectedEntry, occupied])

  const bestQuickSource = (target: MateConnector): MateConnector | null => {
    let best: MateConnector | null = null
    let bestScore = Infinity
    const targetPos = new THREE.Vector3(...target.origin)
    for (const s of selectedFreeConnectors) {
      if (!connectorsCompatible(s, target)) continue
      const score = mateConnectorScore(s, {
        source: target,
        occupied: false,
        distance: new THREE.Vector3(...s.origin).distanceTo(targetPos),
      })
      if (score < bestScore) {
        bestScore = score
        best = s
      }
    }
    return best
  }

  const sourceName = useMemo(() => {
    if (!mateSource) return null
    const entry = connectorsByInstance.find(
      (e) => e.instanceId === mateSource.instanceId,
    )
    return entry?.name ?? 'part'
  }, [mateSource, connectorsByInstance])

  // Step-1 dead-end guard: when the selected part has no pickable connectors,
  // say why instead of silently showing nothing while the hint asks the user
  // to "click one of its connector dots".
  const stepOneDeadEnd = useMemo(() => {
    if (mateSource || snapDebug || !selectedId) return null
    const entry = connectorsByInstance.find((e) => e.instanceId === selectedId)
    if (!entry) return null
    if (entry.connectors.length === 0) return 'none' as const
    const allOccupied = entry.connectors.every(
      (c) => c.snapId && occupied.has(snapKey(selectedId, c.snapId)),
    )
    return allOccupied ? ('occupied' as const) : null
  }, [connectorsByInstance, occupied, mateSource, snapDebug, selectedId])

  useEffect(() => {
    if (stepOneDeadEnd === 'none') {
      setStatus('The selected part has no mate connectors — pick a different part.')
    } else if (stepOneDeadEnd === 'occupied') {
      setStatus(
        'All connectors on this part are occupied (grey dots). Pick another part, or delete a mate to free one.',
      )
    }
  }, [stepOneDeadEnd, setStatus])

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
          // Step-1 quick-mate fast path: a free connector on ANOTHER part that
          // at least one free connector on the selected part can mate with.
          const quickTarget =
            !sourcePicked &&
            !!selectedId &&
            instanceId !== selectedId &&
            !isOccupied &&
            selectedFreeConnectors.some((s) => connectorsCompatible(s, c))
          const blocked =
            (targetCandidate && (!compatibleWithSource || isOccupied)) ||
            (!targetCandidate && !quickTarget && !isSource && isOccupied)
          // Scope the picker to the current step so the viewport stays calm:
          // step 1 shows free connectors (the selected part's, plus green
          // quick-mate targets on other parts, if there is a selection);
          // step 2 shows the source dot plus compatible free targets on OTHER
          // parts. Snap Debug restores the full noisy view. Occupied dots on
          // the SELECTED part stay visible (faded, blocked) so a fully-mated
          // part explains itself instead of showing zero dots.
          if (!snapDebug) {
            const show = !sourcePicked
              ? selectedId
                ? instanceId === selectedId || quickTarget
                : !isOccupied
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
          // Free compatible targets read green — the same "compatible"
          // convention Joint Mode uses — in step 2 AND for step-1 quick-mate.
          else if ((targetCandidate && compatibleWithSource) || quickTarget)
            color = COLOR.target
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
          // One short state line, shared by the hover tooltip and status bar.
          const stateText = isOccupied
            ? 'Occupied'
            : sourcePicked && !compatibleWithSource
              ? 'Not compatible with source'
              : quickTarget
                ? `Click to attach “${selectedEntry?.name ?? 'part'}” here`
                : targetCandidate
                  ? `Click to attach “${sourceName}” here`
                  : isSource
                    ? 'Source — click again to unpick'
                    : 'Click to pick — this part moves'
          return (
            <group key={k}>
              <mesh
                position={c.origin}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerOver={(e) => {
                  e.stopPropagation()
                  setHovered(k)
                  // Classroom-readable status; the full connector internals
                  // (source kind, snap id, score) stay behind Snap Debug.
                  setStatus(
                    snapDebug
                      ? [
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
                          .join(' · ')
                      : `${name} · ${c.label ?? c.id} · ${stateText}`,
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
                  // Quick-mate fast path: auto-pick the best free compatible
                  // connector on the selected part as the source, then use
                  // this dot as the target — straight to the Mate Editor.
                  // Both picks run through pickMateConnector so the normal
                  // guided flow and the fast path stay one code path.
                  if (quickTarget && selectedId) {
                    const src = bestQuickSource(c)
                    if (!src) {
                      setStatus(
                        'No free compatible connector on the selected part.',
                      )
                      return
                    }
                    pickMateConnector(selectedId, src)
                    pickMateConnector(instanceId, c)
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
              {isHovered && (
                <Html
                  position={c.origin}
                  zIndexRange={[40, 0]}
                  style={{ pointerEvents: 'none' }}
                >
                  <div className="connector-tip">
                    <div className="connector-tip-title">
                      {c.label ?? c.id}
                      {c.quality === 'needsCalibration' ? ' ⚠' : ''}
                    </div>
                    <div className="connector-tip-state">{stateText}</div>
                  </div>
                </Html>
              )}
              {active && <MateConnectorTriad connector={c} />}
            </group>
          )
        }),
      )}
    </group>
  )
}
