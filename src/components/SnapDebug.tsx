import { useEffect, useMemo } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { PartDefinition, PartInstanceData, Vec3 } from '../types/assembly'
import { useAssemblyStore } from '../store/assemblyStore'
import { getSnapPoints, snapMetadataLabel } from '../data/snapOverrides'

function formatVec(v: Vec3 | undefined): string {
  if (!v) return 'none'
  return `[${v.map((n) => Number(n.toFixed(3))).join(', ')}]`
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return a.every((value, index) => Math.abs(value - b[index]) < 1e-6)
}

function SnapAxisArrow({
  position,
  axis,
  color = 0xffd166,
  length = 0.24,
}: {
  position: Vec3
  axis?: Vec3
  color?: number
  length?: number
}) {
  const arrow = useMemo(() => {
    if (!axis) return null
    const dir = new THREE.Vector3(...axis)
    if (dir.lengthSq() < 1e-10) return null
    const helper = new THREE.ArrowHelper(
      dir.normalize(),
      new THREE.Vector3(...position),
      length,
      color,
      0.055,
      0.035,
    )
    helper.traverse((obj) => {
      obj.raycast = () => null
    })
    return helper
  }, [axis, color, length, position])

  useEffect(() => {
    return () => {
      arrow?.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        const line = obj as THREE.Line
        mesh.geometry?.dispose?.()
        line.geometry?.dispose?.()
        const material = mesh.material ?? line.material
        if (Array.isArray(material)) {
          material.forEach((m) => m.dispose())
        } else {
          material?.dispose?.()
        }
      })
    }
  }, [arrow])

  return arrow ? <primitive object={arrow} /> : null
}

/**
 * Developer snap-debug overlay for the selected part.
 *
 * Shows the part's local origin + axes (blue Z is the pin "forward"/insertion
 * axis) and a small label at each snap point with its id and type. Rendered as
 * a sibling of the visible model group, so it is excluded from the selection
 * Box3 and never affects snapping — it is purely diagnostic.
 */
export default function SnapDebug({
  instance,
  definition,
}: {
  instance: PartInstanceData
  definition: PartDefinition
}) {
  // Subscribe so a Snap Authoring edit re-resolves the labels live.
  useAssemblyStore((s) => s.snapAuthoringVersion)
  const snaps = getSnapPoints(definition)
  return (
    <group>
      {/* Local origin + axes: red = X, green = Y, blue = Z (pin forward). */}
      <axesHelper args={[0.55]} raycast={() => null} />
      <Html
        position={[0, 0, 0]}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[20, 0]}
      >
        <div className="snap-debug-label origin">origin</div>
      </Html>
      {snaps.map((sp) => {
        const framePosition = sp.mateFrame?.position ?? sp.position
        const axis = sp.mateFrame?.axis ?? sp.axis ?? sp.normal
        const seatPosition =
          sp.seatFrame?.position ?? sp.seatPosition ?? framePosition
        const facePosition = sp.facePosition ?? framePosition
        const depth =
          (sp.insertionDepth ?? 0) +
          (sp.seatOffset ?? 0) +
          (sp.insertionDepthCorrection ?? 0) +
          (sp.sourceSideSeatAdjustment ?? sp.finalSeatAdjustment ?? 0)
        const sourceLabel = sp.snapSource
          ? snapMetadataLabel(sp.snapSource)
          : 'Unknown'
        return (
          <group key={sp.id}>
            <SnapAxisArrow position={framePosition} axis={axis} />
            {!sameVec(sp.position, framePosition) && (
              <mesh position={framePosition} raycast={() => null}>
                <sphereGeometry args={[0.035, 8, 8]} />
                <meshBasicMaterial
                  color="#ff77cc"
                  transparent
                  opacity={0.9}
                  depthTest={false}
                />
              </mesh>
            )}
            {!sameVec(seatPosition, framePosition) && (
              <mesh position={seatPosition} raycast={() => null}>
                <sphereGeometry args={[0.032, 8, 8]} />
                <meshBasicMaterial
                  color="#ff77cc"
                  transparent
                  opacity={0.95}
                  depthTest={false}
                />
              </mesh>
            )}
            {!sameVec(facePosition, framePosition) && (
              <mesh position={facePosition} raycast={() => null}>
                <sphereGeometry args={[0.032, 8, 8]} />
                <meshBasicMaterial
                  color="#66e3ff"
                  transparent
                  opacity={0.95}
                  depthTest={false}
                />
              </mesh>
            )}
            {axis && Math.abs(depth) > 1e-6 && (
              <SnapAxisArrow
                position={seatPosition}
                axis={[
                  axis[0] * Math.sign(depth),
                  axis[1] * Math.sign(depth),
                  axis[2] * Math.sign(depth),
                ]}
                color={0x37d67a}
                length={0.18}
              />
            )}
            <Html
              position={framePosition}
              style={{ pointerEvents: 'none' }}
              zIndexRange={[20, 0]}
            >
              <div className="snap-debug-label">
                {instance.instanceId}
                {definition.partNumber && <span>{definition.partNumber}</span>}
                <span>{sp.id}</span>
                <span>{sp.type}</span>
                {sp.role && <span>{sp.role}</span>}
                <span>{sourceLabel}</span>
                <span>axis {formatVec(axis)}</span>
                <span>frame {formatVec(framePosition)}</span>
                <span>seat {formatVec(seatPosition)}</span>
                {sp.facePosition && (
                  <span>face {formatVec(facePosition)}</span>
                )}
                {(sp.insertionDepth ||
                  sp.seatOffset ||
                  sp.insertionDepthCorrection ||
                  sp.finalSeatAdjustment) && (
                  <span>
                    depth {Number(depth.toFixed(3))}
                  </span>
                )}
                {sp.finalSeatAdjustment && (
                  <span>
                    final {Number(sp.finalSeatAdjustment.toFixed(3))}
                  </span>
                )}
                {sp.sourceSideSeatAdjustment !== undefined && (
                  <span>
                    source {Number(sp.sourceSideSeatAdjustment.toFixed(3))}
                  </span>
                )}
                {sp.targetSideSeatAdjustment !== undefined && (
                  <span>
                    target {Number(sp.targetSideSeatAdjustment.toFixed(3))}
                  </span>
                )}
              </div>
            </Html>
          </group>
        )
      })}
    </group>
  )
}
