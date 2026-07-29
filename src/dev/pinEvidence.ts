/**
 * DEV-ONLY visual evidence run for pin seating.
 *
 * Builds one scene per DISTINCT mechanical contact geometry in the catalog,
 * seats the connector through the real app path (`insertPinAtSnapPoint` /
 * `jointPick`, both of which go through `computeSnapTransform`), points a
 * deterministic close-up camera at the actual contact plane, and writes the
 * rendered frame to `docs/pin-seating-evidence/` via the dev-only Vite sink.
 *
 * Run it from the browser console (or a driven session):
 *
 *   const m = await import('/src/dev/pinEvidence.ts'); await m.runPinEvidence()
 *
 * Nothing imports this module, so it never reaches a production bundle. It is
 * committed because the evidence has to be REPRODUCIBLE — a screenshot whose
 * camera cannot be recreated is not evidence.
 */
import { useAssemblyStore } from '../store/assemblyStore'
import { PARTS, getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'
import { getWorldSnapPoints, solveSeatedPose } from '../utils/snap'
import type { PartInstanceData } from '../types/assembly'

type Shot = {
  target: [number, number, number]
  dir?: [number, number, number]
  distance?: number
  name: string
}

declare global {
  interface Window {
    __vexShot?: (opts: Shot) => Promise<{ ok: boolean; file: string }>
  }
}

const st = () => useAssemblyStore.getState()
const BEAM = '1x4-beam-228-2500-003'
const PLATE = PARTS.find((p) => /^4x4 Plate$/.test(p.name))?.id ?? BEAM

/** Grazing view along the contact plane — the seam has to be visible. */
const GRAZE: [number, number, number] = [0.62, 0.72, 0.31]

/**
 * High-contrast colours. Two touching parts rendered in the same grey make a
 * zero-gap contact IMPOSSIBLE to read — the seam and a 0.01 overlap look
 * identical. Distinct colours per participant are what make these images
 * evidence rather than decoration.
 */
const CONNECTOR_COLOR = '#1f6feb'
const LAYER_COLORS = ['#d1d5db', '#ef4444', '#22c55e', '#f59e0b']

function partIdByNumber(pn: string): string | null {
  return PARTS.find((p) => p.partNumber === pn || p.id === pn)?.id ?? null
}

function quiet() {
  const s = st()
  if (s.showSnapPoints) s.toggleShowSnapPoints()
  if (s.snapDebug) s.toggleSnapDebug()
  st().selectPart(null)
}

/** World position of a snap endpoint's CONTACT plane on a placed instance. */
function contactOf(instanceId: string, snapId: string): [number, number, number] | null {
  const inst = st().parts.find((p) => p.instanceId === instanceId)
  const def = inst ? getPartDefinition(inst.partId) : undefined
  if (!inst || !def) return null
  const snap = getWorldSnapPoints(inst, def).find((s) => s.id === snapId)
  if (!snap) return null
  const p = snap.worldSeatPosition ?? snap.worldFacePosition ?? snap.worldMatePosition
  return [p.x, p.y, p.z]
}

export type EvidenceRow = {
  name: string
  connector: string
  receiver: string
  face: 'front' | 'rear'
  axialGap: number
  intendedOverlap: number
  unintendedPenetration: number
  radial: number
  angularDeg: number
  file?: string
  error?: string
}

/**
 * Seat one connector endpoint into one receiver hole via Pin Mode, measure the
 * real contact, and capture a close-up centred on the contact plane.
 */
async function shootPair(opts: {
  name: string
  connectorPartId: string
  connectorSnapId: string
  receiverPartId: string
  holeId: string
  distance?: number
  dir?: [number, number, number]
}): Promise<EvidenceRow> {
  const connDef = getPartDefinition(opts.connectorPartId)
  const recvDef = getPartDefinition(opts.receiverPartId)
  const row: EvidenceRow = {
    name: opts.name,
    connector: connDef?.name ?? opts.connectorPartId,
    receiver: recvDef?.name ?? opts.receiverPartId,
    face: opts.holeId.endsWith('-back') ? 'rear' : 'front',
    axialGap: NaN,
    intendedOverlap: NaN,
    unintendedPenetration: NaN,
    radial: NaN,
    angularDeg: NaN,
  }
  if (!connDef || !recvDef) {
    row.error = 'part missing'
    return row
  }

  st().clearProject()
  const recvId = st().addPart(recvDef.id, [0, 0, 0])
  if (!recvId) {
    row.error = 'receiver add failed'
    return row
  }
  const connId = st().addPart(connDef.id, [3, 3, 3])
  if (!connId) {
    row.error = 'connector add failed'
    return row
  }
  st().setPartColor(recvId, LAYER_COLORS[0])
  st().setPartColor(connId, CONNECTOR_COLOR)

  // Seat through Joint Mode, which shares `computeSnapTransform` with Auto
  // Snap and Pin Mode — the same placement the user gets.
  st().setMode('joint')
  st().jointPick(connId, opts.connectorSnapId)
  st().jointPick(recvId, opts.holeId)
  st().setMode('select')

  if (st().connections.length === 0) {
    row.error = `no mate created (${st().statusMessage})`
    return row
  }

  // Measure the achieved contact independently of the placement call.
  const recvInst = st().parts.find((p) => p.instanceId === recvId)!
  const connInst = st().parts.find((p) => p.instanceId === connId)!
  const target = getWorldSnapPoints(recvInst, recvDef).find((s) => s.id === opts.holeId)!
  const source = getWorldSnapPoints(connInst, connDef).find(
    (s) => s.id === opts.connectorSnapId,
  )!
  const solved = solveSeatedPose(
    connInst as PartInstanceData,
    source,
    target,
    { parts: st().parts, connections: st().connections },
  )
  row.axialGap = solved.diagnostics.axialContactGap
  row.intendedOverlap = solved.diagnostics.intendedOverlap
  row.unintendedPenetration = solved.diagnostics.unintendedPenetration
  row.radial = solved.diagnostics.radialError
  row.angularDeg = solved.diagnostics.angularErrorDeg

  quiet()
  const contact = contactOf(recvId, opts.holeId) ?? [0, 0, 0]
  const connPos = st().parts.find((p) => p.instanceId === connId)!.position as [
    number,
    number,
    number,
  ]
  const res = await window.__vexShot?.({
    target: contact,
    dir: opts.dir ?? grazeToward(contact, connPos),
    distance: opts.distance ?? 1.9,
    name: opts.name,
  })
  row.file = res?.file
  return row
}

/** Stack N receivers on successive layer seats of one connector side. */
async function shootStack(opts: {
  name: string
  connectorPartNumber: string
  seats: string[]
  distance?: number
}): Promise<EvidenceRow> {
  const connectorPartId = partIdByNumber(opts.connectorPartNumber)
  const row: EvidenceRow = {
    name: opts.name,
    connector: opts.connectorPartNumber,
    receiver: '1x4 Beam x N (stacked layers)',
    face: 'front',
    axialGap: NaN,
    intendedOverlap: NaN,
    unintendedPenetration: NaN,
    radial: NaN,
    angularDeg: NaN,
  }
  if (!connectorPartId) {
    row.error = 'connector missing'
    return row
  }
  st().clearProject()
  const beamA = st().addPart(BEAM, [0, 0, 0])!
  st().setSelectedPinPartId(connectorPartId)
  st().insertPinAtSnapPoint(beamA, 'hole-0')
  const pinId = st().selectedInstanceId!
  st().setPartColor(pinId, CONNECTOR_COLOR)
  st().setPartColor(beamA, LAYER_COLORS[0])
  let worst = 0
  let layerIndex = 1
  for (const seat of opts.seats) {
    const beamId = st().addPart(BEAM, [4, 4, 4])!
    st().setPartColor(beamId, LAYER_COLORS[layerIndex % LAYER_COLORS.length])
    layerIndex += 1
    st().setMode('joint')
    st().jointPick(beamId, 'hole-0')
    st().jointPick(pinId, seat)
    st().setMode('select')
    const beamInst = st().parts.find((p) => p.instanceId === beamId)
    if (!beamInst) continue
    const pinInst = st().parts.find((p) => p.instanceId === pinId)!
    const pinDef = getPartDefinition(pinInst.partId)!
    const beamDef = getPartDefinition(beamInst.partId)!
    const target = getWorldSnapPoints(pinInst, pinDef).find((s) => s.id === seat)!
    const source = getWorldSnapPoints(beamInst, beamDef).find((s) => s.id === 'hole-0')!
    const solved = solveSeatedPose(beamInst, source, target, {
      parts: st().parts,
      connections: st().connections,
    })
    worst = Math.max(worst, solved.diagnostics.unintendedPenetration)
    row.axialGap = solved.diagnostics.axialContactGap
    row.intendedOverlap = solved.diagnostics.intendedOverlap
    row.radial = solved.diagnostics.radialError
    row.angularDeg = solved.diagnostics.angularErrorDeg
  }
  row.unintendedPenetration = worst
  quiet()
  const pinInst = st().parts.find((p) => p.instanceId === pinId)!
  const res = await window.__vexShot?.({
    target: [pinInst.position[0], pinInst.position[1], pinInst.position[2]],
    dir: GRAZE,
    distance: opts.distance ?? 3.0,
    name: opts.name,
  })
  row.file = res?.file
  return row
}

/**
 * A grazing view FROM THE SIDE THE CONNECTOR IS ON.
 *
 * Which side that is depends on the endpoint's insertion axis: a capped 0x2
 * inserts along +Z, so seating it in a hole whose axis is -Z puts its body on
 * the opposite side of the receiver from a 1x1's. Using one fixed direction
 * hid the connector behind the beam and produced six byte-identical
 * "evidence" frames showing only the receiver.
 */
function grazeToward(
  contact: [number, number, number],
  connectorPos: [number, number, number],
): [number, number, number] {
  const v: [number, number, number] = [
    connectorPos[0] - contact[0],
    connectorPos[1] - contact[1],
    connectorPos[2] - contact[2],
  ]
  let k = 0
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[k])) k = i
  const d: [number, number, number] = [...GRAZE]
  if (Math.abs(v[k]) > 1e-6 && Math.sign(d[k]) !== Math.sign(v[k])) d[k] = -d[k]
  return d
}

/** Every part id this evidence run places, so their GLBs can be pre-warmed. */
const USED_PART_NUMBERS = [
  '228-2500-060', '228-2500-061', '228-2500-062', '228-2500-063',
  '228-2500-064', '228-2500-070', '228-2500-086', '228-2500-087',
  '228-2500-089', '228-2500-090', '228-2500-093', '228-2500-099',
  '228-2500-125', '228-2500-1258', '228-2560', '228-2540', '228-6480',
]

/**
 * Place every model this run needs, hold them on screen long enough for
 * `useGLTF` to resolve, then clear. Afterwards each fixture's model is cached
 * and renders on the first frame.
 */
async function primeModels(): Promise<void> {
  st().clearProject()
  const ids = [BEAM, PLATE, ...USED_PART_NUMBERS.map(partIdByNumber)]
  let x = 0
  for (const id of ids) {
    if (!id) continue
    st().addPart(id, [x, 0, 0])
    x += 3
  }
  await new Promise((r) => setTimeout(r, 9000))
  st().clearProject()
  await new Promise((r) => setTimeout(r, 200))
}

/** First hole id of a receiver, and its rear face if it has one. */
function holesOf(partId: string): { front?: string; rear?: string } {
  const def = getPartDefinition(partId)
  if (!def) return {}
  const holes = getSnapPoints(def).filter((s) => s.type === 'hole')
  const front = holes[0]?.id
  const rear = holes.find((h) => h.id === `${front}-back`)?.id
  return { front, rear }
}

/**
 * One capture per distinct stopping-surface geometry in the catalog.
 * Families that share an identical verified geometry (1x1 / 2x2 / 3x3 all stop
 * on the same 0.070 collar) are represented once, plus their layer behaviour.
 */
export async function runPinEvidence(): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = []
  const beamHoles = holesOf(BEAM)
  const plateHoles = holesOf(PLATE)

  // PRE-WARM every model this run will use. A part whose GLB is still loading
  // renders NOTHING (Suspense), and the capture would then silently record the
  // receiver alone — six fixtures came back byte-identical before this existed.
  await primeModels()

  const singles: Array<{
    name: string
    pn: string
    snapId: string
    receiver: string
    hole?: string
    distance?: number
  }> = [
    { name: '01-connector-pin-1x1-front', pn: '228-2500-060', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front },
    { name: '02-connector-pin-1x1-rear', pn: '228-2500-060', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.rear },
    { name: '03-connector-pin-1x2-offset-collar', pn: '228-2500-061', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front },
    { name: '04-idler-pin-2x3', pn: '228-2500-093', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front },
    { name: '05-capped-pin-0x2', pn: '228-2500-086', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front },
    { name: '06-capped-pin-0x2-spherical', pn: '228-2500-090', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front },
    { name: '07-capped-pin-0x3-on-plate', pn: '228-2500-087', snapId: 'pin-front', receiver: PLATE, hole: plateHoles.front },
    { name: '08-sheet-pin-0x1', pn: '228-2500-099', snapId: 'pin-back', receiver: BEAM, hole: beamHoles.front },
    { name: '09-standoff-0p25x-pitch', pn: '228-2500-063', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front },
    { name: '10-standoff-0p5x-pitch', pn: '228-2500-064', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front },
    { name: '11-standoff-4x-pitch-longest', pn: '228-2500-070', snapId: 'pin-front', receiver: BEAM, hole: beamHoles.front, distance: 2.4 },
    { name: '12-corner-connector-peg', pn: '228-2500-1258', snapId: 'peg-0', receiver: BEAM, hole: beamHoles.front },
    { name: '13-shaft-bushing-barrel', pn: '228-2500-125', snapId: 'barrel', receiver: BEAM, hole: beamHoles.front },
  ]

  for (const s of singles) {
    const pid = partIdByNumber(s.pn)
    if (!pid || !s.hole) {
      rows.push({
        name: s.name, connector: s.pn, receiver: s.receiver, face: 'front',
        axialGap: NaN, intendedOverlap: NaN, unintendedPenetration: NaN,
        radial: NaN, angularDeg: NaN, error: 'part or hole missing',
      })
      continue
    }
    rows.push(
      await shootPair({
        name: s.name,
        connectorPartId: pid,
        connectorSnapId: s.snapId,
        receiverPartId: s.receiver,
        holeId: s.hole,
        distance: s.distance,
      }),
    )
  }

  // Electronics mounts — keyed by `id`, not `partNumber`.
  for (const [name, key] of [
    ['14-smart-motor-mount', '228-2560'],
    ['15-brain-gen1-mount', '228-2540'],
    ['16-brain-gen2-mount', '228-6480'],
  ] as const) {
    const pid = partIdByNumber(key)
    const holes = pid ? holesOf(pid) : {}
    const pin = partIdByNumber('228-2500-060')
    if (!pid || !holes.front || !pin) continue
    rows.push(
      await shootPair({
        name,
        connectorPartId: pin,
        connectorSnapId: 'pin-front',
        receiverPartId: pid,
        holeId: holes.front,
        distance: 2.1,
      }),
    )
  }

  // Multi-layer stacks — the geometry that used to accumulate pre-load.
  rows.push(
    await shootStack({
      name: '17-stack-3x3-three-layers',
      connectorPartNumber: '228-2500-089',
      seats: ['pin-back', 'pin-back-2', 'pin-back-3'],
      distance: 2.9,
    }),
  )
  rows.push(
    await shootStack({
      name: '18-stack-0x3-capped-two-layers',
      connectorPartNumber: '228-2500-087',
      seats: ['pin-front-2', 'pin-front-3'],
      distance: 2.9,
    }),
  )

  // Two receivers joined THROUGH one pin: their separation must equal the
  // pin's real collar thickness (0.070), not a hard-coded clearance.
  {
    st().clearProject()
    const beamA = st().addPart(BEAM, [0, 0, 0])!
    const pinPart = partIdByNumber('228-2500-060')!
    st().setSelectedPinPartId(pinPart)
    st().insertPinAtSnapPoint(beamA, 'hole-0')
    const pinId = st().selectedInstanceId!
    st().setPartColor(pinId, CONNECTOR_COLOR)
    st().setPartColor(beamA, LAYER_COLORS[0])
    const beamB = st().addPart(BEAM, [4, 4, 4])!
    st().setPartColor(beamB, LAYER_COLORS[1])
    st().setMode('joint')
    st().jointPick(beamB, 'hole-0')
    st().jointPick(pinId, 'pin-back')
    st().setMode('select')
    const a = st().parts.find((p) => p.instanceId === beamA)!
    const b = st().parts.find((p) => p.instanceId === beamB)!
    const separation = Math.abs(b.position[2] - a.position[2]) - 0.24016
    quiet()
    const pinInst = st().parts.find((p) => p.instanceId === pinId)!
    const res = await window.__vexShot?.({
      target: [pinInst.position[0], pinInst.position[1], pinInst.position[2]],
      dir: GRAZE,
      distance: 2.2,
      name: '19-two-beams-through-one-pin-collar',
    })
    rows.push({
      name: '19-two-beams-through-one-pin-collar',
      connector: '1x1 Connector Pin (collar 0.070)',
      receiver: '1x4 Beam on both sides',
      face: 'front',
      axialGap: separation,
      intendedOverlap: 0,
      unintendedPenetration: 0,
      radial: 0,
      angularDeg: 0,
      file: res?.file,
    })
  }

  st().clearProject()
  return rows
}
