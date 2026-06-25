import type { PartDefinition } from '../types/assembly'
import type { MateConnectorDefinition } from '../types/mate'

const STORAGE_KEY = 'vex-iq-manual-mate-connectors'

export type ManualMateConnectorRecord = MateConnectorDefinition & {
  partId?: string
  partNumber?: string
  partName: string
  createdAt: number
  updatedAt: number
}

function readAll(): ManualMateConnectorRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ManualMateConnectorRecord[]) : []
  } catch {
    return []
  }
}

function writeAll(records: ManualMateConnectorRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch {
    // Best-effort persistence only.
  }
}

function samePart(record: ManualMateConnectorRecord, def: PartDefinition): boolean {
  return (
    (!!record.partId && record.partId === def.id) ||
    (!!record.partNumber && !!def.partNumber && record.partNumber === def.partNumber)
  )
}

export function loadManualMateConnectorRecords(): ManualMateConnectorRecord[] {
  return readAll()
}

export function manualMateConnectorDefinitionsForPart(
  def: PartDefinition,
): ManualMateConnectorRecord[] {
  return readAll().filter((record) => samePart(record, def))
}

export function saveManualMateConnectorDefinition(
  def: PartDefinition,
  connector: MateConnectorDefinition,
): ManualMateConnectorRecord {
  const now = Date.now()
  const records = readAll()
  const id = connector.id || `manual-${now.toString(36)}`
  const nextRecord: ManualMateConnectorRecord = {
    ...connector,
    id,
    source: 'manual',
    quality: connector.quality ?? 'needsCalibration',
    partId: def.id,
    partNumber: def.partNumber,
    partName: def.name,
    createdAt:
      records.find((r) => samePart(r, def) && r.id === id)?.createdAt ?? now,
    updatedAt: now,
  }
  const next = [
    ...records.filter((r) => !(samePart(r, def) && r.id === id)),
    nextRecord,
  ]
  writeAll(next)
  return nextRecord
}

export function exportManualMateConnectorsJson(): string {
  return JSON.stringify(readAll(), null, 2)
}
