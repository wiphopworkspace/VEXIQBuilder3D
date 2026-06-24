// Mate calibration persistence (Phase 1).
//
// Saved Fastened Mate parameters keyed by a source/target connector
// combination, stored in localStorage. This is SEPARATE from project JSON —
// calibrations are reusable across projects and are exported/imported on their
// own. The next time the same connector combination is mated, the editor can
// prefill the saved offset/flip/roll/gap.

import type { CalibrationRecord, FastenedMateParams } from '../types/mate'

const STORAGE_KEY = 'vex-iq-mate-calibration'

/** Identity of a connector for calibration matching (profile/part + connector id). */
export type ConnectorIdentity = {
  partNumber?: string
  partName: string
  profileKey?: string
  connectorId: string
}

function comboKey(source: ConnectorIdentity, target: ConnectorIdentity): string {
  const s = `${source.partNumber ?? source.partName}:${source.connectorId}`
  const t = `${target.partNumber ?? target.partName}:${target.connectorId}`
  return `${s}=>${t}`
}

function readAll(): CalibrationRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CalibrationRecord[]) : []
  } catch {
    return []
  }
}

function writeAll(records: CalibrationRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch {
    // Best-effort: ignore quota / availability errors.
  }
}

export function loadCalibrations(): CalibrationRecord[] {
  return readAll()
}

/**
 * Save (insert or update) a calibration for a source/target combination. The
 * combination identity (not the random id) is the uniqueness key.
 */
export function saveCalibration(
  source: ConnectorIdentity,
  target: ConnectorIdentity,
  params: FastenedMateParams,
): CalibrationRecord {
  const records = readAll()
  const key = comboKey(source, target)
  const now = Date.now()
  const existing = records.find(
    (r) =>
      comboKey(
        {
          partNumber: r.sourcePartNumber,
          partName: r.sourcePartName,
          profileKey: r.sourceProfileKey,
          connectorId: r.sourceConnectorId,
        },
        {
          partNumber: r.targetPartNumber,
          partName: r.targetPartName,
          profileKey: r.targetProfileKey,
          connectorId: r.targetConnectorId,
        },
      ) === key,
  )
  const record: CalibrationRecord = {
    id: existing?.id ?? `cal-${now.toString(36)}`,
    sourcePartNumber: source.partNumber,
    sourcePartName: source.partName,
    sourceProfileKey: source.profileKey,
    sourceConnectorId: source.connectorId,
    targetPartNumber: target.partNumber,
    targetPartName: target.partName,
    targetProfileKey: target.profileKey,
    targetConnectorId: target.connectorId,
    mateType: 'fastened',
    offsetX: params.offsetX,
    offsetY: params.offsetY,
    offsetZ: params.offsetZ,
    rollDeg: params.rollDeg,
    flipPrimary: params.flipPrimary,
    flipSecondary: params.flipSecondary,
    targetGap: params.targetGap,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const next = existing
    ? records.map((r) => (r.id === existing.id ? record : r))
    : [...records, record]
  writeAll(next)
  return record
}

export function deleteCalibration(id: string): void {
  writeAll(readAll().filter((r) => r.id !== id))
}

/** Best saved calibration for a source/target combination, if any. */
export function findBestCalibration(
  source: ConnectorIdentity,
  target: ConnectorIdentity,
): CalibrationRecord | null {
  const key = comboKey(source, target)
  const records = readAll()
  const match = records.find(
    (r) =>
      comboKey(
        {
          partNumber: r.sourcePartNumber,
          partName: r.sourcePartName,
          profileKey: r.sourceProfileKey,
          connectorId: r.sourceConnectorId,
        },
        {
          partNumber: r.targetPartNumber,
          partName: r.targetPartName,
          profileKey: r.targetProfileKey,
          connectorId: r.targetConnectorId,
        },
      ) === key,
  )
  return match ?? null
}

export function calibrationToParams(record: CalibrationRecord): FastenedMateParams {
  return {
    offsetX: record.offsetX,
    offsetY: record.offsetY,
    offsetZ: record.offsetZ,
    rollDeg: record.rollDeg,
    flipPrimary: record.flipPrimary,
    flipSecondary: record.flipSecondary,
    targetGap: record.targetGap,
  }
}

export function exportCalibrationsJson(): string {
  return JSON.stringify(readAll(), null, 2)
}

/** Import calibrations from JSON, merging by combination identity. Returns count. */
export function importCalibrationsJson(json: string): number {
  let incoming: CalibrationRecord[]
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return 0
    incoming = parsed as CalibrationRecord[]
  } catch {
    return 0
  }
  const current = readAll()
  const byKey = new Map<string, CalibrationRecord>()
  for (const r of current) {
    byKey.set(
      comboKey(
        {
          partNumber: r.sourcePartNumber,
          partName: r.sourcePartName,
          connectorId: r.sourceConnectorId,
        },
        {
          partNumber: r.targetPartNumber,
          partName: r.targetPartName,
          connectorId: r.targetConnectorId,
        },
      ),
      r,
    )
  }
  let added = 0
  for (const r of incoming) {
    if (!r || typeof r !== 'object' || !r.sourceConnectorId) continue
    const key = comboKey(
      {
        partNumber: r.sourcePartNumber,
        partName: r.sourcePartName,
        connectorId: r.sourceConnectorId,
      },
      {
        partNumber: r.targetPartNumber,
        partName: r.targetPartName,
        connectorId: r.targetConnectorId,
      },
    )
    byKey.set(key, r)
    added += 1
  }
  writeAll([...byKey.values()])
  return added
}

/** Build a connector identity for calibration from part metadata. */
export function connectorIdentity(
  partNumber: string | undefined,
  partName: string,
  connectorId: string,
  profileKey?: string,
): ConnectorIdentity {
  return { partNumber, partName, connectorId, profileKey }
}
