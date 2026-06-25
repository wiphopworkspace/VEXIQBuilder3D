import { useEffect, useMemo, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { saveManualMateConnectorDefinition } from '../data/manualMateConnectors'
import {
  compatibleConnectorTypes,
  connectorConfidenceLabel,
  connectorToLocalDefinition,
  connectorWithFramePatch,
} from '../utils/mateConnectors'
import type {
  MateConnectorQuality,
  MateConnectorType,
} from '../types/mate'
import type { Vec3 } from '../types/assembly'

const CONNECTOR_TYPES: MateConnectorType[] = [
  'hole',
  'pin',
  'face',
  'axle',
  'shaft',
  'gear',
  'wheel',
  'electronicsPort',
  'surface',
  'manual',
  'inferred',
]

const QUALITIES: MateConnectorQuality[] = [
  'verified',
  'measured',
  'estimated',
  'needsCalibration',
]

function vecString(v: Vec3): string {
  return v.map((n) => Number(n.toFixed(4))).join(', ')
}

function parseVec(input: string, fallback: Vec3): Vec3 {
  const parts = input
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
  if (parts.length !== 3) return fallback
  return [parts[0], parts[1], parts[2]]
}

function parseTypes(input: string, fallback: MateConnectorType[]): MateConnectorType[] {
  const set = new Set(CONNECTOR_TYPES)
  const values = input
    .split(',')
    .map((s) => s.trim() as MateConnectorType)
    .filter((t) => set.has(t))
  return values.length > 0 ? values : fallback
}

type Endpoint = 'source' | 'target'

export default function ManualConnectorEditor() {
  const mateSource = useAssemblyStore((s) => s.mateSource)
  const mateTarget = useAssemblyStore((s) => s.mateTarget)
  const parts = useAssemblyStore((s) => s.parts)
  const updatePick = useAssemblyStore((s) => s.updateMateConnectorPick)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  const [endpoint, setEndpoint] = useState<Endpoint>('source')
  const pick = endpoint === 'source' ? mateSource : mateTarget

  const connector = pick?.connector ?? null
  const instance = pick
    ? parts.find((p) => p.instanceId === pick.instanceId) ?? null
    : null
  const def = instance ? getPartDefinition(instance.partId) : null

  const [label, setLabel] = useState('')
  const [origin, setOrigin] = useState('')
  const [axis, setAxis] = useState('')
  const [rollDeg, setRollDeg] = useState(0)
  const [type, setType] = useState<MateConnectorType>('manual')
  const [quality, setQuality] =
    useState<MateConnectorQuality>('needsCalibration')
  const [compatible, setCompatible] = useState('')

  const connectorKey = connector
    ? `${endpoint}:${connector.partInstanceId}:${connector.id}`
    : 'none'

  useEffect(() => {
    if (!connector) return
    setLabel(connector.label ?? connector.id)
    setOrigin(vecString(connector.origin))
    setAxis(vecString(connector.axisZ))
    setRollDeg(0)
    setType(connector.type)
    setQuality(connector.quality)
    setCompatible(connector.compatibleWith.join(', '))
  }, [connectorKey, connector])

  const edited = useMemo(() => {
    if (!connector) return null
    const nextType = type
    const next = connectorWithFramePatch(connector, {
      origin: parseVec(origin, connector.origin),
      axisZ: parseVec(axis, connector.axisZ),
      rollDeg,
      type: nextType,
      quality,
      label,
      compatibleWith: parseTypes(
        compatible,
        connector.compatibleWith.length
          ? connector.compatibleWith
          : compatibleConnectorTypes(nextType),
      ),
    })
    return {
      ...next,
      source: 'manual' as const,
      quality,
      label,
      replacesConnectorId:
        connector.replacesConnectorId ??
        (connector.source === 'surfacePick' ? undefined : connector.id),
    }
  }, [axis, compatible, connector, label, origin, quality, rollDeg, type])

  if (!mateSource) return null

  const applyEdited = () => {
    if (!edited) return
    updatePick(endpoint, edited)
  }

  const localDefinition = () => {
    if (!edited || !instance) return null
    return connectorToLocalDefinition(instance, edited, {
      id: edited.id,
      label: edited.label,
      quality,
      source: 'manual',
      replacesConnectorId: edited.replacesConnectorId,
    })
  }

  const saveManual = () => {
    if (!def || !instance || !edited) return
    const local = localDefinition()
    if (!local) return
    saveManualMateConnectorDefinition(def, local)
    updatePick(endpoint, edited)
    setStatus(
      `Saved manual connector for ${def.name}: ${edited.label ?? edited.id}`,
    )
  }

  const copyJson = async () => {
    const local = localDefinition()
    if (!local || !def) return
    const json = JSON.stringify(
      {
        partId: def.id,
        partNumber: def.partNumber,
        partName: def.name,
        connector: local,
      },
      null,
      2,
    )
    try {
      await navigator.clipboard.writeText(json)
      setStatus('Copied connector override JSON')
    } catch {
      setStatus('Clipboard unavailable for connector JSON')
    }
  }

  return (
    <div className="manual-connector-editor">
      <div className="mate-editor-subhead">Manual Connector Authoring</div>
      <div className="mate-type">
        <button
          className={endpoint === 'source' ? 'active' : ''}
          onClick={() => setEndpoint('source')}
        >
          Source
        </button>
        <button
          className={endpoint === 'target' ? 'active' : ''}
          onClick={() => setEndpoint('target')}
          disabled={!mateTarget}
        >
          Target
        </button>
      </div>

      {!connector || !instance || !def ? (
        <div className="warn-box">
          Pick a connector or surface point to create a manual connector.
        </div>
      ) : (
        <>
          <div className="mate-endpoints">
            <div>
              <span className="label">Part</span>
              <span className="value">{def.name}</span>
            </div>
            <div>
              <span className="label">Connector</span>
              <span className="value">
                {connector.id} · {connector.source} ·{' '}
                {connectorConfidenceLabel(connector)}
              </span>
            </div>
          </div>

          <label className="mate-field">
            <span>Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="mate-field">
            <span>Position X,Y,Z</span>
            <input value={origin} onChange={(e) => setOrigin(e.target.value)} />
          </label>
          <label className="mate-field">
            <span>Axis X,Y,Z</span>
            <input value={axis} onChange={(e) => setAxis(e.target.value)} />
          </label>
          <div className="mate-grid">
            <label className="mate-field">
              <span>Roll</span>
              <input
                type="number"
                step={5}
                value={rollDeg}
                onChange={(e) => setRollDeg(parseFloat(e.target.value) || 0)}
              />
            </label>
            <label className="mate-field">
              <span>Type</span>
              <select
                value={type}
                onChange={(e) => {
                  const nextType = e.target.value as MateConnectorType
                  setType(nextType)
                  setCompatible(compatibleConnectorTypes(nextType).join(', '))
                }}
              >
                {CONNECTOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="mate-field">
              <span>Quality</span>
              <select
                value={quality}
                onChange={(e) =>
                  setQuality(e.target.value as MateConnectorQuality)
                }
              >
                {QUALITIES.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mate-field">
            <span>Compatible With</span>
            <input
              value={compatible}
              onChange={(e) => setCompatible(e.target.value)}
            />
          </label>
          <div className="mate-actions">
            <button onClick={applyEdited}>Preview Connector</button>
            <button
              onClick={() =>
                setAxis(
                  vecString(
                    parseVec(axis, connector.axisZ).map((n) => -n) as Vec3,
                  ),
                )
              }
            >
              Flip Axis
            </button>
          </div>
          <div className="mate-actions">
            <button onClick={saveManual}>Save Connector</button>
            <button onClick={copyJson}>Copy Connector JSON</button>
          </div>
          <div className="warn-box">
            Saved manual connectors are reusable local calibrations. Surface
            picks remain needs-calibration until visually verified.
          </div>
        </>
      )}
    </div>
  )
}
