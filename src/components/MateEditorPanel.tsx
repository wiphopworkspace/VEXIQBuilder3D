import { useEffect, useRef, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { matchPinProfile } from '../data/pinProfiles'
import {
  connectorIdentity,
  findBestCalibration,
  calibrationToParams,
  saveCalibration,
} from '../data/mateCalibration'
import {
  DEFAULT_FASTENED_MATE_PARAMS,
  type FastenedMateParams,
} from '../types/mate'
import type { JointKind } from '../types/assembly'
import ManualConnectorEditor from './ManualConnectorEditor'

function NumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string
  value: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="mate-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={Number(value.toFixed(4))}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </label>
  )
}

/**
 * Mate Editor (Advanced CAD-lite). Shown once a source and target Mate
 * Connector are picked. Edits a Fastened Mate (offset / flip / roll / gap),
 * previews it live (without committing), and applies, cancels, or saves a
 * reusable calibration.
 */
export default function MateEditorPanel() {
  const mateSource = useAssemblyStore((s) => s.mateSource)
  const mateTarget = useAssemblyStore((s) => s.mateTarget)
  const parts = useAssemblyStore((s) => s.parts)
  const previewFastenedMate = useAssemblyStore((s) => s.previewFastenedMate)
  const restoreMatePreview = useAssemblyStore((s) => s.restoreMatePreview)
  const applyFastenedMate = useAssemblyStore((s) => s.applyFastenedMate)
  const cancelMate = useAssemblyStore((s) => s.cancelMate)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  const mateEditingMateId = useAssemblyStore((s) => s.mateEditingMateId)
  const mateInitialParams = useAssemblyStore((s) => s.mateInitialParams)
  const mateInitialKind = useAssemblyStore((s) => s.mateInitialKind)
  const easyMode = useAssemblyStore((s) => s.easyMode)

  const [params, setParams] = useState<FastenedMateParams>(
    DEFAULT_FASTENED_MATE_PARAMS,
  )
  const [preview, setPreview] = useState(true)
  const [mateType, setMateType] = useState<JointKind>('fastened')

  const open = !!mateSource && !!mateTarget
  const pairKey =
    open && mateSource && mateTarget
      ? `${mateEditingMateId ?? 'new'}:${mateSource.instanceId}:${mateSource.connector.id}=>${mateTarget.instanceId}:${mateTarget.connector.id}`
      : null

  // Resolve part metadata for both endpoints (for labels + calibration keys).
  const sourceInstance = mateSource
    ? parts.find((p) => p.instanceId === mateSource.instanceId)
    : null
  const targetInstance = mateTarget
    ? parts.find((p) => p.instanceId === mateTarget.instanceId)
    : null
  const sourceDef = sourceInstance
    ? getPartDefinition(sourceInstance.partId)
    : null
  const targetDef = targetInstance
    ? getPartDefinition(targetInstance.partId)
    : null

  // When a new connector pair is picked, prefill from any saved calibration.
  const lastPairRef = useRef<string | null>(null)
  useEffect(() => {
    if (!pairKey || pairKey === lastPairRef.current) return
    lastPairRef.current = pairKey
    let next = mateInitialParams ?? DEFAULT_FASTENED_MATE_PARAMS
    if (!mateInitialParams && sourceDef && targetDef && mateSource && mateTarget) {
      const saved = findBestCalibration(
        connectorIdentity(
          sourceDef.partNumber,
          sourceDef.name,
          mateSource.connector.id,
          matchPinProfile(sourceDef)?.key,
        ),
        connectorIdentity(
          targetDef.partNumber,
          targetDef.name,
          mateTarget.connector.id,
          matchPinProfile(targetDef)?.key,
        ),
      )
      if (saved) {
        next = calibrationToParams(saved)
        setStatus('Loaded saved calibration for this connector pair')
      }
    }
    setParams(next)
    setPreview(true)
    setMateType(mateInitialKind ?? 'fastened')
  }, [
    pairKey,
    sourceDef,
    targetDef,
    mateSource,
    mateTarget,
    mateInitialParams,
    mateInitialKind,
    setStatus,
  ])

  // Live preview whenever params / preview toggle change.
  useEffect(() => {
    if (!open) return
    if (preview) previewFastenedMate(params)
    else restoreMatePreview()
  }, [
    open,
    preview,
    params,
    mateSource,
    mateTarget,
    previewFastenedMate,
    restoreMatePreview,
  ])

  if (easyMode || !open || !mateSource || !mateTarget) return null

  const set = (patch: Partial<FastenedMateParams>) =>
    setParams((p) => ({ ...p, ...patch }))

  const canStoreMate =
    !!mateSource.connector.snapId && !!mateTarget.connector.snapId

  const handleSaveCalibration = () => {
    if (!sourceDef || !targetDef) return
    saveCalibration(
      connectorIdentity(
        sourceDef.partNumber,
        sourceDef.name,
        mateSource.connector.id,
        matchPinProfile(sourceDef)?.key,
      ),
      connectorIdentity(
        targetDef.partNumber,
        targetDef.name,
        mateTarget.connector.id,
        matchPinProfile(targetDef)?.key,
      ),
      params,
    )
    setStatus('Calibration saved for this connector pair')
  }

  const calibrationJson = () =>
    JSON.stringify(
      {
        source: {
          part: sourceDef?.name,
          partNumber: sourceDef?.partNumber,
          connector: mateSource.connector.id,
        },
        target: {
          part: targetDef?.name,
          partNumber: targetDef?.partNumber,
          connector: mateTarget.connector.id,
        },
        mateType,
        ...params,
      },
      null,
      2,
    )

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(calibrationJson())
      setStatus('Copied calibration JSON')
    } catch {
      setStatus('Clipboard unavailable for calibration JSON')
    }
  }

  const isRevolute = mateType === 'revolute'

  return (
    <div className="mate-editor">
      <div className="mate-editor-header">
        Mate Editor — {isRevolute ? 'Revolute' : 'Fastened'}
      </div>

      <div className="mate-editor-body">
        <div className="mate-type">
          <button
            className={!isRevolute ? 'active' : ''}
            onClick={() => setMateType('fastened')}
            title="Rigid: parts are fixed relative to each other"
          >
            Fastened
          </button>
          <button
            className={isRevolute ? 'active' : ''}
            onClick={() => setMateType('revolute')}
            title="Revolute: parts share an axis and can rotate about it (1 DOF)"
          >
            Revolute
          </button>
        </div>

        <div className="mate-endpoints">
          <div>
            <span className="label">Source</span>
            <span className="value">
              {sourceDef?.name ?? mateSource.instanceId} ·{' '}
              {mateSource.connector.label ?? mateSource.connector.id}
            </span>
          </div>
          <div>
            <span className="label">Target</span>
            <span className="value">
              {targetDef?.name ?? mateTarget.instanceId} ·{' '}
              {mateTarget.connector.label ?? mateTarget.connector.id}
            </span>
          </div>
        </div>

        <div className="mate-grid">
          <NumberField
            label="Offset X"
            value={params.offsetX}
            step={0.01}
            onChange={(v) => set({ offsetX: v })}
          />
          <NumberField
            label="Offset Y"
            value={params.offsetY}
            step={0.01}
            onChange={(v) => set({ offsetY: v })}
          />
          <NumberField
            label="Along Axis (Z)"
            value={params.offsetZ}
            step={0.01}
            onChange={(v) => set({ offsetZ: v })}
          />
          <NumberField
            label="Target Gap"
            value={params.targetGap}
            step={0.005}
            onChange={(v) => set({ targetGap: v })}
          />
          <NumberField
            label={isRevolute ? 'Angle (deg)' : 'Roll (deg)'}
            value={params.rollDeg}
            step={15}
            onChange={(v) => set({ rollDeg: v })}
          />
        </div>

        <div className="mate-toggles">
          <label>
            <input
              type="checkbox"
              checked={params.flipPrimary}
              onChange={(e) => set({ flipPrimary: e.target.checked })}
            />
            Flip primary axis
          </label>
          <label>
            <input
              type="checkbox"
              checked={params.flipSecondary}
              onChange={(e) => set({ flipSecondary: e.target.checked })}
            />
            Flip secondary axis
          </label>
          <label>
            <input
              type="checkbox"
              checked={preview}
              onChange={(e) => setPreview(e.target.checked)}
            />
            Live preview
          </label>
        </div>

        {!canStoreMate && (
          <div className="warn-box">
            One endpoint is a surface/manual pick — Apply positions the part but
            stores a project connector snapshot instead of a snap id.
          </div>
        )}

        {(mateSource.connector.quality === 'needsCalibration' ||
          mateTarget.connector.quality === 'needsCalibration') && (
          <div className="warn-box">
            One or both connectors need calibration. Adjust the connector frame
            below, then save it so this part can reuse the correction.
          </div>
        )}

        {isRevolute && (
          <div className="mate-hint">
            Aligns both connectors on one axis. After Apply, use the Angle slider
            in the Properties panel (or Q/E) to rotate about the joint.
          </div>
        )}

        <div className="mate-actions">
          <button
            className="primary"
            onClick={() => applyFastenedMate(params, mateType)}
          >
            {isRevolute ? 'Apply Joint' : 'Apply Mate'}
          </button>
          <button onClick={cancelMate}>Cancel</button>
        </div>
        <div className="mate-actions">
          <button onClick={handleSaveCalibration}>Save Calibration</button>
          <button onClick={handleCopyJson}>Copy Calibration JSON</button>
        </div>

        <ManualConnectorEditor />
      </div>
    </div>
  )
}
