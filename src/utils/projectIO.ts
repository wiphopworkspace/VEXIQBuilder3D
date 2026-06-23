import type {
  ConnectionMate,
  PartInstanceData,
  ProjectFile,
} from '../types/assembly'

export const PROJECT_VERSION = 2

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
    if (
      typeof m.aInstanceId === 'string' &&
      typeof m.aSnapId === 'string' &&
      typeof m.bInstanceId === 'string' &&
      typeof m.bSnapId === 'string'
    ) {
      out.push({
        id: typeof m.id === 'string' ? m.id : `mate-${out.length + 1}`,
        aInstanceId: m.aInstanceId,
        aSnapId: m.aSnapId,
        bInstanceId: m.bInstanceId,
        bSnapId: m.bSnapId,
        type: 'snap',
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

  // Keep only connections whose endpoints reference parts that exist.
  const ids = new Set(parts.map((p) => p.instanceId))
  const connections = parseConnections(obj.connections).filter(
    (c) => ids.has(c.aInstanceId) && ids.has(c.bInstanceId),
  )

  return {
    projectName:
      typeof obj.projectName === 'string' ? obj.projectName : 'My Robot',
    version: typeof obj.version === 'number' ? obj.version : PROJECT_VERSION,
    parts,
    connections,
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
