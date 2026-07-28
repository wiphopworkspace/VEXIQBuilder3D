import { useMemo } from 'react'
import * as THREE from 'three'
import { Html, Line } from '@react-three/drei'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import {
  evaluateSeating,
  getWorldSnapPoints,
  solveSeatedPose,
  typesCompatible,
  worldSnapContactPosition,
} from '../utils/snap'
import type { RuntimeSnapPoint } from '../types/assembly'

const PIN_COLOR = '#ff8c3a'
const RECEIVER_COLOR = '#3ad1ff'
const AXIS_LENGTH = 0.45

function frameLines(
  origin: THREE.Vector3,
  axis: THREE.Vector3,
): [number, number, number][] {
  const tip = origin.clone().add(axis.clone().normalize().multiplyScalar(AXIS_LENGTH))
  return [
    [origin.x, origin.y, origin.z],
    [tip.x, tip.y, tip.z],
  ]
}

/**
 * Developer contact-frame overlay (Settings → Snap & Joint Calibration →
 * "Show contact frames").
 *
 * Draws the MECHANICAL CONTACT FRAMES — not the visual markers — for the
 * pending Joint Mode pick, so a future model can be diagnosed by looking
 * rather than guessing: pin contact frame, receiver contact frame, both
 * insertion axes, and the measured radial / angular / axial errors with the
 * active tolerances and the accept/reject reason.
 *
 * Hidden by default and rendered only while Joint Mode has a source picked, so
 * production sessions carry no overlay cost and no console noise.
 */
export default function ContactDebugOverlay() {
  const enabled = useAssemblyStore((s) => s.pinSeating.showContactFrames)
  const calibration = useAssemblyStore((s) => s.pinSeating)
  const jointSource = useAssemblyStore((s) => s.jointSource)
  const hoveredSnap = useAssemblyStore((s) => s.selectedSnapPointId)
  const parts = useAssemblyStore((s) => s.parts)

  const info = useMemo(() => {
    if (!enabled || !jointSource) return null
    const sourceInstance = parts.find(
      (p) => p.instanceId === jointSource.instanceId,
    )
    const sourceDef = sourceInstance
      ? getPartDefinition(sourceInstance.partId)
      : undefined
    if (!sourceInstance || !sourceDef) return null
    const sourceSnap = getWorldSnapPoints(sourceInstance, sourceDef).find(
      (s) => s.id === jointSource.snapId,
    )
    if (!sourceSnap) return null

    // Second endpoint: whatever snap the user has highlighted, when compatible.
    let targetSnap: RuntimeSnapPoint | null = null
    if (hoveredSnap) {
      const [instanceId, snapId] = hoveredSnap.split('::')
      if (instanceId && instanceId !== jointSource.instanceId) {
        const inst = parts.find((p) => p.instanceId === instanceId)
        const def = inst ? getPartDefinition(inst.partId) : undefined
        if (inst && def) {
          targetSnap =
            getWorldSnapPoints(inst, def).find((s) => s.id === snapId) ?? null
        }
      }
    }

    const sourceContact = worldSnapContactPosition(sourceSnap)
    if (!targetSnap || !typesCompatible(sourceSnap.type, targetSnap.type)) {
      return { sourceSnap, sourceContact, targetSnap: null }
    }
    const targetContact = worldSnapContactPosition(targetSnap)
    const solved = solveSeatedPose(sourceInstance, sourceSnap, targetSnap, {
      parts,
      calibration,
    })
    const verdict = evaluateSeating(solved.diagnostics, calibration)
    return {
      sourceSnap,
      sourceContact,
      targetSnap,
      targetContact,
      diagnostics: solved.diagnostics,
      verdict,
    }
  }, [enabled, jointSource, hoveredSnap, parts, calibration])

  if (!info) return null

  const sourceAxis =
    info.sourceSnap.worldMateAxis?.clone() ?? new THREE.Vector3(0, 0, 1)

  return (
    <group>
      {/* pin / inserting contact frame */}
      <mesh position={info.sourceContact}>
        <sphereGeometry args={[0.028, 12, 12]} />
        <meshBasicMaterial color={PIN_COLOR} depthTest={false} transparent />
      </mesh>
      <Line
        points={frameLines(info.sourceContact, sourceAxis)}
        color={PIN_COLOR}
        lineWidth={2}
        depthTest={false}
      />

      {info.targetSnap && info.targetContact && (
        <>
          {/* receiver contact frame */}
          <mesh position={info.targetContact}>
            <sphereGeometry args={[0.028, 12, 12]} />
            <meshBasicMaterial
              color={RECEIVER_COLOR}
              depthTest={false}
              transparent
            />
          </mesh>
          <Line
            points={frameLines(
              info.targetContact,
              info.targetSnap.worldMateAxis?.clone() ??
                new THREE.Vector3(0, 0, 1),
            )}
            color={RECEIVER_COLOR}
            lineWidth={2}
            depthTest={false}
          />
          {/* the measured gap between the two contact planes */}
          <Line
            points={[
              [info.sourceContact.x, info.sourceContact.y, info.sourceContact.z],
              [info.targetContact.x, info.targetContact.y, info.targetContact.z],
            ]}
            color={info.verdict?.ok ? '#5ee08a' : '#ff5c5c'}
            lineWidth={1.5}
            dashed
            dashSize={0.02}
            gapSize={0.02}
            depthTest={false}
          />
        </>
      )}

      <Html position={info.sourceContact} className="contact-debug-html" center>
        <div className="contact-debug">
          <div className="contact-debug-title">
            {info.sourceSnap.id}
            {info.targetSnap ? ` → ${info.targetSnap.id}` : ' (pick a target)'}
          </div>
          {info.diagnostics && (
            <table>
              <tbody>
                <tr>
                  <td>radial</td>
                  <td>{info.diagnostics.radialError.toFixed(4)}</td>
                  <td>≤ {calibration.radialTolerance}</td>
                </tr>
                <tr>
                  <td>angular</td>
                  <td>{info.diagnostics.angularErrorDeg.toFixed(2)}°</td>
                  <td>≤ {calibration.angularToleranceDeg}°</td>
                </tr>
                <tr>
                  <td>axial gap</td>
                  <td>{info.diagnostics.axialContactGap.toFixed(4)}</td>
                  <td>≤ {calibration.axialGapTolerance}</td>
                </tr>
                <tr>
                  <td>penetration</td>
                  <td>{info.diagnostics.penetration.toFixed(4)}</td>
                  <td>≤ {calibration.penetrationTolerance}</td>
                </tr>
                <tr>
                  <td>seat offset</td>
                  <td colSpan={2}>
                    {info.diagnostics.appliedSeatOffset.toFixed(4)} (+
                    {info.diagnostics.appliedContactOffset.toFixed(4)} user)
                  </td>
                </tr>
                <tr>
                  <td>face</td>
                  <td colSpan={2}>
                    {info.diagnostics.receiverFaceSign > 0 ? 'front' : 'back'} ·
                    roll{' '}
                    {info.diagnostics.rollStepDeg === 360
                      ? 'fixed'
                      : `${info.diagnostics.rollStepDeg}°`}
                  </td>
                </tr>
                <tr>
                  <td>contact from</td>
                  <td colSpan={2}>
                    {info.diagnostics.contactPlaneSource.source} /{' '}
                    {info.diagnostics.contactPlaneSource.target}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {info.verdict && (
            <div
              className={`contact-debug-verdict ${info.verdict.ok ? 'ok' : 'bad'}`}
            >
              {info.verdict.ok
                ? 'accepted — within every tolerance'
                : `rejected — ${info.verdict.reasons.join('; ')}`}
            </div>
          )}
        </div>
      </Html>
    </group>
  )
}
