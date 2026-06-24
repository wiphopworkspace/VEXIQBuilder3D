import { useMemo, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition, VEX_IQ_PALETTE } from '../data/parts'
import {
  getSnapPointResolution,
  snapMetadataLabel,
} from '../data/snapOverrides'
import { SNAP_CALIBRATION } from '../data/snapCalibration'
import { matchPinProfile } from '../data/pinProfiles'
import { getWorldSnapPoints, measurePinBeamToBeamGap } from '../utils/snap'
import type {
  PartDefinition,
  PartInstanceData,
  RuntimeSnapPoint,
  SnapPointDefinition,
  Vec3,
} from '../types/assembly'
import BillOfMaterials from './BillOfMaterials'
import SnapSettings from './SnapSettings'

function VecEditor({
  label,
  value,
  step,
  toDisplay,
  fromDisplay,
  onChange,
}: {
  label: string
  value: Vec3
  step: number
  toDisplay: (v: number) => number
  fromDisplay: (v: number) => number
  onChange: (v: Vec3) => void
}) {
  const axes: ('X' | 'Y' | 'Z')[] = ['X', 'Y', 'Z']
  return (
    <div>
      <div className="prop-row">
        <span className="label">{label}</span>
      </div>
      <div className="vec-grid">
        {axes.map((axis, i) => (
          <input
            key={axis}
            type="number"
            step={step}
            value={Number(toDisplay(value[i]).toFixed(3))}
            onChange={(e) => {
              const next: Vec3 = [...value]
              next[i] = fromDisplay(parseFloat(e.target.value) || 0)
              onChange(next)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function isDepthAdjustableSnap(snap: SnapPointDefinition): boolean {
  return (
    snap.type === 'pin' ||
    snap.type === 'connector' ||
    snap.compatibleWith.includes('hole') ||
    snap.finalSeatAdjustment !== undefined ||
    snap.insertionDepthCorrection !== undefined ||
    !!snap.seatFrame ||
    !!snap.seatPosition
  )
}

function isReceivingHoleSnap(snap: SnapPointDefinition): boolean {
  return snap.type === 'hole' || snap.role === 'receive'
}

type ResolvedEndpoint = {
  side: 'a' | 'b'
  instance: PartInstanceData
  definition: PartDefinition
  snap: RuntimeSnapPoint
  snapDefinition?: SnapPointDefinition
}

export default function PropertiesPanel() {
  const [calibrationDeltas, setCalibrationDeltas] = useState<
    Record<string, number>
  >({})
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const parts = useAssemblyStore((s) => s.parts)
  const updateTransform = useAssemblyStore((s) => s.updatePartTransform)
  const setPartColor = useAssemblyStore((s) => s.setPartColor)
  const glbErrors = useAssemblyStore((s) => s.glbErrors)
  const connections = useAssemblyStore((s) => s.connections)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  const activeMateId = useAssemblyStore((s) => s.activeMateId)
  const setActiveMate = useAssemblyStore((s) => s.setActiveMate)

  const instance = parts.find((p) => p.instanceId === selectedId) ?? null
  const def = instance ? getPartDefinition(instance.partId) : null
  const glbFailed = def ? !!glbErrors[def.id] : false
  const snapResolution = def ? getSnapPointResolution(def) : null
  const pinProfile = def ? matchPinProfile(def) : null
  const resolvedSnapPoints = snapResolution?.snapPoints ?? []
  const snapApproximate =
    snapResolution?.source === 'generatedFallback' ||
    snapResolution?.source === 'boundsInferred' ||
    resolvedSnapPoints.some((sp) => sp.approximate)
  const pinSnapDepths = resolvedSnapPoints.filter(
    (sp) =>
      isDepthAdjustableSnap(sp) &&
      (sp.finalSeatAdjustment !== undefined ||
        sp.insertionDepthCorrection !== undefined ||
        sp.seatFrame ||
        sp.seatPosition),
  )

  // Mates that involve the selected part, described from its point of view.
  const mates = useMemo(() => {
    if (!instance) return []
    return connections
      .filter(
        (c) =>
          c.aInstanceId === instance.instanceId ||
          c.bInstanceId === instance.instanceId,
      )
      .map((c) => {
        const mine =
          c.aInstanceId === instance.instanceId ? c.aSnapId : c.bSnapId
        const otherInstanceId =
          c.aInstanceId === instance.instanceId ? c.bInstanceId : c.aInstanceId
        const otherSnapId =
          c.aInstanceId === instance.instanceId ? c.bSnapId : c.aSnapId
        const otherInst = parts.find((p) => p.instanceId === otherInstanceId)
        const otherDef = otherInst
          ? getPartDefinition(otherInst.partId)
          : undefined
        return {
          id: c.id,
          mine,
          otherName: otherDef?.name ?? otherInstanceId,
          otherSnapId,
        }
      })
  }, [instance, connections, parts])

  const selectedPinMateCount = useMemo(() => {
    if (!instance) return 0
    const pinSnapIds = new Set(
      resolvedSnapPoints.filter(isDepthAdjustableSnap).map((sp) => sp.id),
    )
    if (pinSnapIds.size === 0) return 0
    return connections.filter((c) => {
      if (c.aInstanceId === instance.instanceId) return pinSnapIds.has(c.aSnapId)
      if (c.bInstanceId === instance.instanceId) return pinSnapIds.has(c.bSnapId)
      return false
    }).length
  }, [connections, instance, resolvedSnapPoints])

  // Actual achieved beam-to-beam clearance for a selected pin with both sides
  // mated — the measured signed gap, not just the target constant.
  const measuredBeamGap = useMemo(() => {
    if (!instance || selectedPinMateCount < 2) return null
    return measurePinBeamToBeamGap(instance.instanceId, parts, connections)
  }, [instance, selectedPinMateCount, parts, connections])

  const pinEndOccupancy = useMemo(() => {
    if (!instance || !pinProfile) return []
    return pinProfile.ends.map((end) => {
      const mate = connections.find(
        (c) =>
          (c.aInstanceId === instance.instanceId && c.aSnapId === end.id) ||
          (c.bInstanceId === instance.instanceId && c.bSnapId === end.id),
      )
      return {
        id: end.id,
        label: end.label,
        occupied: !!mate,
        usableLayers: end.usableLayers,
      }
    })
  }, [connections, instance, pinProfile])

  const depthCalibration = useMemo(() => {
    if (!instance || !def) return null

    const resolveEndpoint = (
      side: 'a' | 'b',
      instanceId: string,
      snapId: string,
    ): ResolvedEndpoint | null => {
      const endpointInstance = parts.find((p) => p.instanceId === instanceId)
      const endpointDef = endpointInstance
        ? getPartDefinition(endpointInstance.partId)
        : undefined
      if (!endpointInstance || !endpointDef) return null
      const endpointSnap = getWorldSnapPoints(
        endpointInstance,
        endpointDef,
      ).find((s) => s.id === snapId)
      if (!endpointSnap) return null
      const endpointSnapDefinition = getSnapPointResolution(
        endpointDef,
      ).snapPoints.find((s) => s.id === snapId)
      return {
        side,
        instance: endpointInstance,
        definition: endpointDef,
        snap: endpointSnap,
        snapDefinition: endpointSnapDefinition,
      }
    }

    for (const c of connections) {
      if (
        c.aInstanceId !== instance.instanceId &&
        c.bInstanceId !== instance.instanceId
      ) {
        continue
      }

      const a = resolveEndpoint('a', c.aInstanceId, c.aSnapId)
      const b = resolveEndpoint('b', c.bInstanceId, c.bSnapId)
      if (!a || !b) continue

      const pinEndpoint =
        isDepthAdjustableSnap(a.snap) && isReceivingHoleSnap(b.snap)
          ? a
          : isDepthAdjustableSnap(b.snap) && isReceivingHoleSnap(a.snap)
            ? b
            : null
      const holeEndpoint = pinEndpoint === a ? b : pinEndpoint === b ? a : null
      if (!pinEndpoint || !holeEndpoint) continue

      const sourceEndpoint = a
      const targetEndpoint = b
      const axis =
        targetEndpoint.snap.worldMateAxis ?? targetEndpoint.snap.worldAxis
      if (!axis || axis.lengthSq() < 1e-10) continue
      const normalized = axis.clone().normalize()
      const definitionSnap = pinEndpoint.snapDefinition
      const adjustmentField =
        pinEndpoint.side === 'a'
          ? 'sourceSideSeatAdjustment'
          : 'targetSideSeatAdjustment'
      const key = `${c.id}:${pinEndpoint.instance.instanceId}:${pinEndpoint.snap.id}:${adjustmentField}`
      const delta = calibrationDeltas[key] ?? 0
      const base =
        definitionSnap?.[adjustmentField] ??
        definitionSnap?.finalSeatAdjustment ??
        0

      return {
        key,
        adjustmentField,
        movingInstanceId: sourceEndpoint.instance.instanceId,
        movingPosition: sourceEndpoint.instance.position,
        movingRotation: sourceEndpoint.instance.rotation,
        axis: [normalized.x, normalized.y, normalized.z] as Vec3,
        snapId: pinEndpoint.snap.id,
        partName: pinEndpoint.definition.name,
        movingPartName: sourceEndpoint.definition.name,
        targetName: holeEndpoint.definition.name,
        targetSnapId: holeEndpoint.snap.id,
        baseFinalSeatAdjustment: base,
        suggestedFinalSeatAdjustment: base + delta,
        snapDefinition: definitionSnap,
      }
    }
    return null
  }, [calibrationDeltas, connections, def, instance, parts])

  function nudgeSnapDepth(delta: number) {
    if (!instance || !depthCalibration) return
    setSnapDepthAdjustment(
      depthCalibration.suggestedFinalSeatAdjustment + delta,
    )
  }

  function setSnapDepthAdjustment(value: number) {
    if (!instance || !depthCalibration || Number.isNaN(value)) return
    const delta = value - depthCalibration.suggestedFinalSeatAdjustment
    if (Math.abs(delta) < 1e-10) return
    const axis = depthCalibration.axis
    const position: Vec3 = [
      depthCalibration.movingPosition[0] + axis[0] * delta,
      depthCalibration.movingPosition[1] + axis[1] * delta,
      depthCalibration.movingPosition[2] + axis[2] * delta,
    ]
    updateTransform(
      depthCalibration.movingInstanceId,
      position,
      depthCalibration.movingRotation,
    )
    setCalibrationDeltas((prev) => ({
      ...prev,
      [depthCalibration.key]:
        value - depthCalibration.baseFinalSeatAdjustment,
    }))
    setStatus(
      `finalSeatAdjustment set to ${value.toFixed(4)}`,
    )
  }

  function calibrationOverrideJson(
    snap: SnapPointDefinition | undefined,
    finalSeatAdjustment: number,
  ): string {
    const sourceSideSeatAdjustment =
      depthCalibration?.adjustmentField === 'sourceSideSeatAdjustment'
        ? finalSeatAdjustment
        : snap?.sourceSideSeatAdjustment ?? snap?.finalSeatAdjustment ?? finalSeatAdjustment
    const targetSideSeatAdjustment =
      depthCalibration?.adjustmentField === 'targetSideSeatAdjustment'
        ? finalSeatAdjustment
        : snap?.targetSideSeatAdjustment ?? snap?.finalSeatAdjustment ?? finalSeatAdjustment
    return JSON.stringify(
      {
        id: snap?.id ?? depthCalibration?.snapId ?? 'pin-front',
        type: snap?.type ?? 'pin',
        role: snap?.role ?? 'insert',
        position: snap?.position,
        axis: snap?.axis,
        mateFrame: snap?.mateFrame,
        seatFrame: snap?.seatFrame,
        insertionDepthCorrection: snap?.insertionDepthCorrection ?? 0,
        finalSeatAdjustment: Number(finalSeatAdjustment.toFixed(4)),
        sourceSideSeatAdjustment: Number(
          sourceSideSeatAdjustment.toFixed(4),
        ),
        targetSideSeatAdjustment: Number(
          targetSideSeatAdjustment.toFixed(4),
        ),
        compatibleWith: snap?.compatibleWith ?? ['hole'],
      },
      null,
      2,
    )
  }

  async function copyCalibrationOverride() {
    if (!depthCalibration) return
    const json = calibrationOverrideJson(
      depthCalibration.snapDefinition,
      depthCalibration.suggestedFinalSeatAdjustment,
    )
    try {
      await navigator.clipboard.writeText(json)
      setStatus('Copied snap depth override JSON')
    } catch {
      setStatus('Clipboard unavailable for override JSON')
    }
  }

  async function copyInterPartClearanceConstant() {
    const text = `beamToBeamFaceClearance: ${SNAP_CALIBRATION.beamToBeamFaceClearance.toFixed(
      3,
    )}`
    try {
      await navigator.clipboard.writeText(text)
      setStatus('Copied beam-to-beam clearance constant')
    } catch {
      setStatus('Clipboard unavailable for clearance constant')
    }
  }

  return (
    <div className="panel right">
      <div className="panel-header">Properties</div>
      <div className="panel-scroll">
        <SnapSettings />
        {!instance || !def ? (
          <div className="empty-hint">
            No part selected.
            <br />
            Click a part in the viewport to edit its properties, or click a part
            in the library to add one.
          </div>
        ) : (
          <>
            <div className="prop-section">
              <div className="prop-row">
                <span className="label">Part Name</span>
                <span className="value">{def.name}</span>
              </div>
              <div className="prop-row">
                <span className="label">Category</span>
                <span className="value">{def.category}</span>
              </div>
              <div className="prop-row">
                <span className="label">Part ID</span>
                <span className="value">{def.id}</span>
              </div>
              {def.partNumber && (
                <div className="prop-row">
                  <span className="label">VEX Part #</span>
                  <span className="value">{def.partNumber}</span>
                </div>
              )}
              {def.ldcadVexFileName && (
                <div className="prop-row">
                  <span className="label">LDCad Ref</span>
                  <span className="value">{def.ldcadVexFileName}</span>
                </div>
              )}
              <div className="prop-row">
                <span className="label">Instance</span>
                <span
                  className="value"
                  style={{ fontSize: 10 }}
                  title={instance.instanceId}
                >
                  {instance.instanceId.slice(-10)}
                </span>
              </div>
              {def.sourceCollection && (
                <div className="prop-row">
                  <span className="label">Source</span>
                  <span className="value">{def.sourceCollection}</span>
                </div>
              )}
              {def.sourceStepPath && (
                <div className="prop-row">
                  <span className="label">Model</span>
                  <span
                    className="value"
                    style={{
                      color: def.hasConvertedModel
                        ? 'var(--green)'
                        : '#c9cf3d',
                    }}
                  >
                    {def.hasConvertedModel ? 'GLB Ready' : 'Placeholder'}
                  </span>
                </div>
              )}
            </div>

            {glbFailed ? (
              <div className="prop-section">
                <div className="warn-box error">
                  GLB failed to load. Falling back to placeholder geometry.
                </div>
              </div>
            ) : (
              def.sourceStepPath &&
              def.hasConvertedModel === false && (
                <div className="prop-section">
                  <div className="warn-box">
                    This part is using placeholder geometry. Convert STEP to GLB
                    to see the real model.
                  </div>
                </div>
              )
            )}

            <div className="prop-section">
              <VecEditor
                label="Position (world units)"
                value={instance.position}
                step={0.1}
                toDisplay={(v) => v}
                fromDisplay={(v) => v}
                onChange={(pos) =>
                  updateTransform(instance.instanceId, pos, instance.rotation)
                }
              />
            </div>

            <div className="prop-section">
              <VecEditor
                label="Rotation (degrees)"
                value={instance.rotation}
                step={5}
                toDisplay={(v) => (v * 180) / Math.PI}
                fromDisplay={(v) => (v * Math.PI) / 180}
                onChange={(rot) =>
                  updateTransform(instance.instanceId, instance.position, rot)
                }
              />
            </div>

            <div className="prop-section">
              <div className="prop-row">
                <span className="label">Color</span>
                <span className="value">{instance.color}</span>
              </div>
              <div className="color-swatches">
                {Array.from(
                  new Set([
                    ...def.colorOptions,
                    ...VEX_IQ_PALETTE,
                    instance.color,
                  ]),
                ).map((c) => (
                  <div
                    key={c}
                    className={`swatch${
                      instance.color.toLowerCase() === c.toLowerCase()
                        ? ' active'
                        : ''
                    }`}
                    style={{ background: c }}
                    onClick={() => setPartColor(instance.instanceId, c)}
                    title={c}
                  />
                ))}
                <label
                  className="swatch swatch-custom"
                  title="Custom color"
                  style={{ background: instance.color }}
                >
                  +
                  <input
                    type="color"
                    value={instance.color}
                    onChange={(e) =>
                      setPartColor(instance.instanceId, e.target.value)
                    }
                  />
                </label>
              </div>
            </div>

            <div className="prop-section">
              <div className="prop-row">
                <span className="label">Snap metadata</span>
                <span className="value">
                  {snapResolution
                    ? snapMetadataLabel(snapResolution.source)
                    : 'None'}
                </span>
              </div>
              <div className="prop-row">
                <span className="label">Snap points</span>
                <span className="value">{resolvedSnapPoints.length}</span>
              </div>
              {resolvedSnapPoints.length === 0 && (
                <div className="warn-box">
                  No snap points found. This part can be moved manually but
                  cannot snap yet.
                </div>
              )}
              {snapApproximate && resolvedSnapPoints.length > 0 && (
                <div className="warn-box">
                  Snap points are inferred and may not perfectly match the
                  visual model.
                </div>
              )}
              {pinSnapDepths.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {pinSnapDepths.map((sp) => (
                    <div className="prop-row" key={sp.id}>
                      <span className="label">{sp.id}</span>
                      <span className="value">
                        final{' '}
                        {Number(sp.finalSeatAdjustment ?? 0).toFixed(4)}
                        {' · source '}
                        {Number(
                          sp.sourceSideSeatAdjustment ??
                            sp.finalSeatAdjustment ??
                            0,
                        ).toFixed(4)}
                        {' · target '}
                        {Number(
                          sp.targetSideSeatAdjustment ??
                            sp.finalSeatAdjustment ??
                            0,
                        ).toFixed(4)}
                        {sp.insertionDepthCorrection !== undefined
                          ? ` · correction ${Number(
                              sp.insertionDepthCorrection,
                            ).toFixed(4)}`
                          : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {pinProfile && (
              <div className="prop-section">
                <div className="prop-row">
                  <span className="label">Pin Profile</span>
                  <span className="value">{pinProfile.displayName}</span>
                </div>
                <div className="prop-row">
                  <span className="label">Family</span>
                  <span className="value">
                    {pinProfile.family}
                    {pinProfile.capped ? ' · capped' : ''}
                  </span>
                </div>
                <div className="prop-row">
                  <span className="label">Metadata</span>
                  <span
                    className="value"
                    style={{
                      color:
                        pinProfile.metadataQuality === 'needs-calibration'
                          ? '#c9cf3d'
                          : 'var(--green)',
                    }}
                  >
                    {pinProfile.metadataQuality}
                  </span>
                </div>
                <div className="prop-row">
                  <span className="label">Inter-part clearance</span>
                  <span className="value">
                    {pinProfile.beamToBeamFaceClearance.toFixed(3)}
                  </span>
                </div>
                {pinEndOccupancy.map((end) => (
                  <div className="prop-row" key={end.id}>
                    <span className="label">
                      {pinProfile.capped ? end.label : end.id}
                      {end.usableLayers !== undefined
                        ? ` · ${end.usableLayers} layer${end.usableLayers === 1 ? '' : 's'}`
                        : ''}
                    </span>
                    <span
                      className="value"
                      style={{
                        color: end.occupied ? 'var(--green)' : 'var(--text-dim)',
                      }}
                    >
                      {end.occupied ? 'occupied' : 'free'}
                    </span>
                  </div>
                ))}
                {pinProfile.capped && (
                  <div className="prop-row">
                    <span className="label">Cap side</span>
                    <span className="value" style={{ color: 'var(--text-dim)' }}>
                      fixed (no insert)
                    </span>
                  </div>
                )}
                {pinProfile.curatedNeedsReview && (
                  <div className="warn-box" style={{ marginTop: 8 }}>
                    This pin profile needs visual calibration.
                  </div>
                )}
              </div>
            )}

            {depthCalibration && (
              <div className="prop-section">
                <div className="prop-row">
                  <span className="label">Pin Seat Adjustment</span>
                </div>
                <div className="prop-row">
                  <span className="label">Adjusted part</span>
                  <span className="value">
                    {depthCalibration.movingPartName}
                  </span>
                </div>
                <div className="prop-row">
                  <span className="label">Adjusted field</span>
                  <span className="value">
                    {depthCalibration.adjustmentField}
                  </span>
                </div>
                <div className="prop-row">
                  <span className="label">Connected snap</span>
                  <span className="value">
                    {depthCalibration.snapId} → {depthCalibration.targetSnapId}
                  </span>
                </div>
                <div className="prop-row">
                  <span className="label">Hole axis</span>
                  <span className="value">
                    [{depthCalibration.axis.map((n) => n.toFixed(3)).join(', ')}]
                  </span>
                </div>
                <div className="prop-row">
                  <span className="label">Current adjustment</span>
                  <span className="value">
                    {depthCalibration.baseFinalSeatAdjustment.toFixed(4)}
                  </span>
                </div>
                <div className="prop-row">
                  <span className="label">Suggested override</span>
                  <span className="value">
                    {depthCalibration.suggestedFinalSeatAdjustment.toFixed(4)}
                  </span>
                </div>
                <input
                  type="number"
                  step={0.001}
                  value={Number(
                    depthCalibration.suggestedFinalSeatAdjustment.toFixed(4),
                  )}
                  onChange={(e) =>
                    setSnapDepthAdjustment(parseFloat(e.target.value))
                  }
                  title="Edit finalSeatAdjustment directly"
                  style={{ width: '100%', marginTop: 6 }}
                />
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr 1fr',
                    gap: 6,
                    marginTop: 8,
                  }}
                >
                  <button onClick={() => nudgeSnapDepth(-0.001)}>
                    -0.001
                  </button>
                  <button onClick={() => nudgeSnapDepth(0.001)}>
                    +0.001
                  </button>
                  <button onClick={() => nudgeSnapDepth(-0.005)}>
                    -0.005
                  </button>
                  <button onClick={() => nudgeSnapDepth(0.005)}>
                    +0.005
                  </button>
                  <button onClick={() => nudgeSnapDepth(-0.01)}>-0.01</button>
                  <button onClick={() => nudgeSnapDepth(0.01)}>+0.01</button>
                  <button onClick={() => nudgeSnapDepth(-0.05)}>-0.05</button>
                  <button onClick={() => nudgeSnapDepth(0.05)}>+0.05</button>
                </div>
                <button
                  style={{ width: '100%', marginTop: 8 }}
                  onClick={() =>
                    setSnapDepthAdjustment(
                      depthCalibration.baseFinalSeatAdjustment,
                    )
                  }
                >
                  Reset Adjustment
                </button>
                <button
                  style={{ width: '100%', marginTop: 8 }}
                  onClick={copyCalibrationOverride}
                >
                  Copy Override JSON
                </button>
                <div className="prop-row" style={{ marginTop: 12 }}>
                  <span className="label">Inter-part clearance</span>
                  <span className="value">
                    {SNAP_CALIBRATION.beamToBeamFaceClearance.toFixed(3)}
                  </span>
                </div>
                <button
                  style={{ width: '100%', marginTop: 8 }}
                  onClick={copyInterPartClearanceConstant}
                >
                  Copy Calibration Constant
                </button>
              </div>
            )}

            <div className="prop-section">
              <div className="prop-row">
                <span className="label">
                  Connections ({mates.length})
                </span>
              </div>
              {mates.length === 0 ? (
                <div className="prop-row">
                  <span className="value" style={{ color: 'var(--text-dim)' }}>
                    Not connected
                  </span>
                </div>
              ) : (
                <>
                  {mates.map((m) => (
                    <div className="prop-row" key={m.id}>
                      <span className="value" style={{ color: 'var(--green)' }}>
                        {m.mine} → {m.otherName} · {m.otherSnapId}
                      </span>
                    </div>
                  ))}
                  {mates.length > 1 && (
                    <div className="prop-row" style={{ marginTop: 6 }}>
                      <span className="label">Active joint (Q/E/F pivot)</span>
                      <select
                        value={activeMateId[instance.instanceId] ?? mates[0].id}
                        onChange={(e) =>
                          setActiveMate(instance.instanceId, e.target.value)
                        }
                        style={{ width: '100%' }}
                      >
                        {mates.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.mine} → {m.otherName}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {selectedPinMateCount >= 2 && (
                    <div className="prop-row">
                      <span className="label">Beam-to-beam gap</span>
                      <span className="value">
                        {measuredBeamGap !== null
                          ? `${measuredBeamGap.toFixed(4)} measured`
                          : '—'}{' '}
                        / {SNAP_CALIBRATION.beamToBeamFaceClearance.toFixed(3)}{' '}
                        target
                      </span>
                    </div>
                  )}
                  <div className="warn-box" style={{ marginTop: 6 }}>
                    This part has connections. Moving it may break mates.
                  </div>
                </>
              )}
            </div>
          </>
        )}

        <BillOfMaterials />
      </div>
    </div>
  )
}
