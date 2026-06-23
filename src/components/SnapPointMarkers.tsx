import { useMemo } from 'react'
import type { PartDefinition, PartInstanceData } from '../types/assembly'
import { useAssemblyStore } from '../store/assemblyStore'
import { snapKey, typesCompatible } from '../utils/snap'
import { getSnapPoints, snapMetadataLabel } from '../data/snapOverrides'

// Small markers only — no large translucent spheres.
const R_NORMAL = 0.06
const R_HIGHLIGHT = 0.1

const COLOR = {
  source: '#ffe24d', // yellow — Joint Mode source / Auto Snap dragged point
  compatible: '#37d67a', // green — compatible target
  normal: '#39c5ff', // cyan — idle snap marker
  occupied: '#c0392b', // red/dim — already mated
  incompatible: '#5b6472', // gray/dim — not a valid target
} as const

type Props = {
  instance: PartInstanceData
  definition: PartDefinition
}

/**
 * Clickable snap-point markers for one part instance.
 *
 * Rendered as a sibling of the visible model group (so excluded from the
 * selection Box3). Visible when "Show Snap Points" is on, Joint/Pin Mode is
 * active, or Auto Snap is on with a part selected. Markers are only raycast-
 * interactive in Joint/Pin Mode; otherwise they're visual guides that never
 * block part selection.
 */
export default function SnapPointMarkers({ instance, definition }: Props) {
  const mode = useAssemblyStore((s) => s.mode)
  const snapEnabled = useAssemblyStore((s) => s.snapEnabled)
  const showSnapPoints = useAssemblyStore((s) => s.showSnapPoints)
  const snapDebug = useAssemblyStore((s) => s.snapDebug)
  const hasSelection = useAssemblyStore((s) => s.selectedInstanceId != null)
  const connections = useAssemblyStore((s) => s.connections)
  const snapPreview = useAssemblyStore((s) => s.snapPreview)
  const jointSource = useAssemblyStore((s) => s.jointSource)
  const insertPin = useAssemblyStore((s) => s.insertPinAtSnapPoint)
  const jointPick = useAssemblyStore((s) => s.jointPick)
  const setStatus = useAssemblyStore((s) => s.setStatus)

  const pinMode = mode === 'pin'
  const jointMode = mode === 'joint'
  const interactive = pinMode || jointMode
  const active =
    showSnapPoints ||
    snapDebug ||
    jointMode ||
    pinMode ||
    (snapEnabled && hasSelection)

  const snaps = getSnapPoints(definition)

  const occupied = useMemo(() => {
    const set = new Set<string>()
    for (const c of connections) {
      set.add(snapKey(c.aInstanceId, c.aSnapId))
      set.add(snapKey(c.bInstanceId, c.bSnapId))
    }
    return set
  }, [connections])

  if (!active || snaps.length === 0) return null

  return (
    <group>
      {snaps.map((sp) => {
        const axis = sp.mateFrame?.axis ?? sp.axis ?? sp.normal
        const depth =
          (sp.insertionDepth ?? 0) +
          (sp.seatOffset ?? 0) +
          (sp.insertionDepthCorrection ?? 0) +
          (sp.sourceSideSeatAdjustment ??
            sp.finalSeatAdjustment ??
            0) +
          (sp.receivingDepth ?? 0)
        const sourceLabel = sp.snapSource
          ? snapMetadataLabel(sp.snapSource)
          : 'Unknown'
        const key = snapKey(instance.instanceId, sp.id)
        const isOccupied = occupied.has(key)

        // Auto Snap live preview endpoints.
        const isPreviewDragged =
          snapPreview?.draggedInstanceId === instance.instanceId &&
          snapPreview?.draggedSnapId === sp.id
        const isPreviewTarget =
          snapPreview?.targetInstanceId === instance.instanceId &&
          snapPreview?.targetSnapId === sp.id

        // Joint Mode highlighting relative to the picked source.
        const isSource =
          jointMode &&
          jointSource?.instanceId === instance.instanceId &&
          jointSource?.snapId === sp.id
        let jointCompatible = false
        let jointIncompatible = false
        if (jointMode && jointSource && !isSource) {
          const differentPart = jointSource.instanceId !== instance.instanceId
          const compat = typesCompatible(jointSource.type, sp.type)
          if (differentPart && compat && !isOccupied) jointCompatible = true
          else jointIncompatible = true
        }

        // Pin Mode: only holes are valid targets.
        const pinDim = pinMode && sp.type !== 'hole'

        let color: string = COLOR.normal
        let highlighted = false
        let dim = false
        if (isSource || isPreviewDragged) {
          color = COLOR.source
          highlighted = true
        } else if (jointCompatible || isPreviewTarget) {
          color = COLOR.compatible
          highlighted = true
        } else if (jointIncompatible || pinDim) {
          color = COLOR.incompatible
          dim = true
        } else if (isOccupied) {
          color = COLOR.occupied
          dim = true
        }

        const radius = highlighted ? R_HIGHLIGHT : R_NORMAL
        const opacity = dim ? 0.3 : highlighted ? 1 : 0.85

        return (
          <mesh
            key={sp.id}
            position={sp.position}
            userData={{
              isSnapMarker: true,
              instanceId: instance.instanceId,
              snapId: sp.id,
              snapType: sp.type,
            }}
            // Visual-only outside Joint/Pin Mode: don't intercept part picking.
            raycast={interactive ? undefined : () => null}
            onPointerDown={
              interactive ? (e) => e.stopPropagation() : undefined
            }
            onPointerUp={interactive ? (e) => e.stopPropagation() : undefined}
            onPointerOver={
              interactive
                ? (e) => {
                    e.stopPropagation()
                    setStatus(
                      [
                        definition.name,
                        definition.partNumber,
                        `${sp.id} (${sp.type})`,
                        `source: ${sourceLabel}`,
                        sp.pinProfileDisplayName
                          ? `profile: ${sp.pinProfileDisplayName}`
                          : null,
                        sp.curatedNeedsReview ? 'needs visual calibration' : null,
                        axis ? `axis: [${axis.join(', ')}]` : null,
                        sp.seatPosition
                          ? `seat: [${sp.seatPosition.join(', ')}]`
                          : sp.seatFrame
                            ? `seat: [${sp.seatFrame.position.join(', ')}]`
                            : null,
                        sp.finalSeatAdjustment !== undefined
                          ? `finalSeatAdjustment: ${Number(
                              sp.finalSeatAdjustment.toFixed(4),
                            )}`
                          : null,
                        sp.sourceSideSeatAdjustment !== undefined
                          ? `sourceSide: ${Number(
                              sp.sourceSideSeatAdjustment.toFixed(4),
                            )}`
                          : null,
                        sp.targetSideSeatAdjustment !== undefined
                          ? `targetSide: ${Number(
                              sp.targetSideSeatAdjustment.toFixed(4),
                            )}`
                          : null,
                        Math.abs(depth) > 1e-6
                          ? `depth: ${Number(depth.toFixed(3))}`
                          : null,
                        isOccupied ? 'occupied' : null,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    )
                  }
                : undefined
            }
            onClick={
              interactive
                ? (e) => {
                    e.stopPropagation()
                    if (pinMode) {
                      if (sp.type === 'hole') insertPin(instance.instanceId, sp.id)
                      return
                    }
                    // Joint Mode: pick source, then compatible target.
                    jointPick(instance.instanceId, sp.id)
                  }
                : undefined
            }
          >
            <sphereGeometry args={[radius, 10, 10]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={opacity}
              depthTest={false}
            />
          </mesh>
        )
      })}
    </group>
  )
}
