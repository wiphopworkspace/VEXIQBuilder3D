import type {
  ConnectionMate,
  PartInstanceData,
  ProjectFile,
  Vec3,
} from '../types/assembly'
import type {
  MateConnectorFallbackFrame,
  MateConnectorProjectRef,
  MateConnectorQuality,
  MateConnectorSource,
  MateConnectorType,
} from '../types/mate'
import { getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'

export const PROJECT_VERSION = 3

export function serializeProject(
  projectName: string,
  parts: PartInstanceData[],
  connections: ConnectionMate[] = [],
): ProjectFile {
  return {
    projectName,
    version: PROJECT_VERSION,
    parts,
    connections,
  }
}

function parseConnections(value: unknown): ConnectionMate[] {
  if (!Array.isArray(value)) return []
  const out: ConnectionMate[] = []
  for (const c of value) {
    if (typeof c !== 'object' || c === null) continue
    const m = c as Record<string, unknown>
    const aConnectorRef = parseConnectorRef(
      m.aConnectorRef ?? m.sourceConnectorRef,
    )
    const bConnectorRef = parseConnectorRef(
      m.bConnectorRef ?? m.targetConnectorRef,
    )
    const aSnapId =
      typeof m.aSnapId === 'string'
        ? m.aSnapId
        : aConnectorRef?.snapId ?? aConnectorRef?.connectorId
    const bSnapId =
      typeof m.bSnapId === 'string'
        ? m.bSnapId
        : bConnectorRef?.snapId ?? bConnectorRef?.connectorId
    if (
      typeof m.aInstanceId === 'string' &&
      typeof aSnapId === 'string' &&
      typeof m.bInstanceId === 'string' &&
      typeof bSnapId === 'string'
    ) {
      out.push({
        id: typeof m.id === 'string' ? m.id : `mate-${out.length + 1}`,
        aInstanceId: m.aInstanceId,
        aSnapId,
        bInstanceId: m.bInstanceId,
        bSnapId,
        type: 'snap',
        jointKind: m.jointKind === 'revolute' ? 'revolute' : undefined,
        aConnectorRef,
        bConnectorRef,
        mateParams: parseFastenedParams(m.mateParams),
      })
    }
  }
  return out
}

/**
 * Validate and normalize an unknown parsed JSON object into a ProjectFile.
 * Throws a descriptive error when the structure is invalid.
 */
export function parseProject(raw: unknown): ProjectFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Project file is not a valid object.')
  }
  const obj = raw as Record<string, unknown>

  if (!Array.isArray(obj.parts)) {
    throw new Error('Project file is missing a "parts" array.')
  }

  const parts: PartInstanceData[] = obj.parts.map((p, i) => {
    if (typeof p !== 'object' || p === null) {
      throw new Error(`Part at index ${i} is invalid.`)
    }
    const part = p as Record<string, unknown>
    if (typeof part.partId !== 'string') {
      throw new Error(`Part at index ${i} is missing "partId".`)
    }
    return {
      instanceId:
        typeof part.instanceId === 'string'
          ? part.instanceId
          : `inst-${Date.now()}-${i}`,
      partId: part.partId,
      position: toVec3(part.position),
      rotation: toVec3(part.rotation),
      scale: toVec3(part.scale, 1),
      color: typeof part.color === 'string' ? part.color : '#7d8794',
    }
  })

  // Resolve each instance's available snap-point ids once, so we can drop
  // connections that reference a snap point which no longer exists on the part
  // (e.g. an old capped-pin 'pin-back' after the profile became single-ended).
  // Filtering by snapId — not just instanceId — prevents dangling mates and
  // phantom occupancy from surviving a load.
  const snapIdsByInstance = new Map<string, Set<string>>()
  for (const p of parts) {
    const def = getPartDefinition(p.partId)
    snapIdsByInstance.set(
      p.instanceId,
      def ? new Set(getSnapPoints(def).map((s) => s.id)) : new Set<string>(),
    )
  }
  const instanceIds = new Set(parts.map((p) => p.instanceId))
  const endpointValid = (
    instanceId: string,
    snapId: string,
    ref: MateConnectorProjectRef | undefined,
  ) => {
    if (!instanceIds.has(instanceId)) return false
    const ids = snapIdsByInstance.get(instanceId)
    if (ids?.has(snapId)) return true
    // Ref-backed CAD-lite mates can be restored from connector id or fallback
    // frame even when no old snap id exists. Do not silently drop them.
    return !!ref?.connectorId && (!!ref.fallbackFrame || !!ref.snapId)
  }
  const connections = parseConnections(obj.connections).filter((c) => {
    const aIds = snapIdsByInstance.get(c.aInstanceId)
    const bIds = snapIdsByInstance.get(c.bInstanceId)
    return (
      aIds != null &&
      bIds != null &&
      endpointValid(c.aInstanceId, c.aSnapId, c.aConnectorRef) &&
      endpointValid(c.bInstanceId, c.bSnapId, c.bConnectorRef)
    )
  })

  return {
    projectName:
      typeof obj.projectName === 'string' ? obj.projectName : 'My Robot',
    version: typeof obj.version === 'number' ? obj.version : PROJECT_VERSION,
    parts,
    connections,
  }
}

function isConnectorSource(value: unknown): value is MateConnectorSource {
  return (
    value === 'curated' ||
    value === 'snapPoint' ||
    value === 'generated' ||
    value === 'boundsInferred' ||
    value === 'surfacePick' ||
    value === 'manual' ||
    value === 'fallback'
  )
}

function isConnectorQuality(value: unknown): value is MateConnectorQuality {
  return (
    value === 'verified' ||
    value === 'measured' ||
    value === 'estimated' ||
    value === 'needsCalibration'
  )
}

function isConnectorType(value: unknown): value is MateConnectorType {
  return (
    value === 'hole' ||
    value === 'pin' ||
    value === 'face' ||
    value === 'axle' ||
    value === 'shaft' ||
    value === 'gear' ||
    value === 'wheel' ||
    value === 'electronicsPort' ||
    value === 'surface' ||
    value === 'manual' ||
    value === 'inferred'
  )
}

function parseConnectorTypes(value: unknown): MateConnectorType[] {
  if (!Array.isArray(value)) return []
  return value.filter(isConnectorType)
}

function parseFrame(value: unknown): MateConnectorFallbackFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as Record<string, unknown>
  const origin = toVec3OrNull(frame.origin)
  if (!origin) return undefined
  const q =
    Array.isArray(frame.quaternion) && frame.quaternion.length === 4
      ? (frame.quaternion.map((n) => Number(n) || 0) as [
          number,
          number,
          number,
          number,
        ])
      : undefined
  return {
    origin,
    xAxis: toVec3OrNull(frame.xAxis),
    yAxis: toVec3OrNull(frame.yAxis),
    zAxis: toVec3OrNull(frame.zAxis),
    quaternion: q,
  }
}

function parseConnectorRef(value: unknown): MateConnectorProjectRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const ref = value as Record<string, unknown>
  if (typeof ref.connectorId !== 'string') return undefined
  if (typeof ref.partInstanceId !== 'string') return undefined
  const type = isConnectorType(ref.type) ? ref.type : 'manual'
  return {
    connectorId: ref.connectorId,
    partInstanceId: ref.partInstanceId,
    partDefId: typeof ref.partDefId === 'string' ? ref.partDefId : undefined,
    snapId: typeof ref.snapId === 'string' ? ref.snapId : undefined,
    source: isConnectorSource(ref.source) ? ref.source : 'fallback',
    quality: isConnectorQuality(ref.quality)
      ? ref.quality
      : 'needsCalibration',
    type,
    compatibleWith: parseConnectorTypes(ref.compatibleWith),
    fallbackFrame: parseFrame(ref.fallbackFrame),
    manualConnectorId:
      typeof ref.manualConnectorId === 'string'
        ? ref.manualConnectorId
        : undefined,
    occupancyGroup:
      typeof ref.occupancyGroup === 'string' ? ref.occupancyGroup : undefined,
    label: typeof ref.label === 'string' ? ref.label : undefined,
  }
}

function parseFastenedParams(value: unknown) {
  if (typeof value !== 'object' || value === null) return undefined
  const params = value as Record<string, unknown>
  return {
    offsetX: Number(params.offsetX) || 0,
    offsetY: Number(params.offsetY) || 0,
    offsetZ: Number(params.offsetZ) || 0,
    rollDeg: Number(params.rollDeg) || 0,
    flipPrimary: params.flipPrimary === true,
    flipSecondary: params.flipSecondary === true,
    targetGap: Number(params.targetGap) || 0,
  }
}

function toVec3(value: unknown, fallback = 0): [number, number, number] {
  if (Array.isArray(value) && value.length === 3) {
    return [
      Number(value[0]) || (fallback ? fallback : 0),
      Number(value[1]) || (fallback ? fallback : 0),
      Number(value[2]) || (fallback ? fallback : 0),
    ]
  }
  return [fallback, fallback, fallback]
}

function toVec3OrNull(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const out = value.map((n) => Number(n))
  if (!out.every(Number.isFinite)) return undefined
  return [out[0], out[1], out[2]]
}

/** Trigger a browser download of the project as a .json file. */
export function downloadProjectJSON(project: ProjectFile) {
  const blob = new Blob([JSON.stringify(project, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const safeName = project.projectName.replace(/[^a-z0-9-_]+/gi, '_')
  a.href = url
  a.download = `${safeName || 'project'}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
