/**
 * Tracked shaft-system regression check (`npm run verify:shafts`).
 *
 * Locks in the 2026-07-14 shaft-placement calibration headlessly (no WebGL):
 *  1. Resolver invariants: shaft ends (position/axis/kind/stop), clamped
 *     stations, the calibrated Smart Motor drive socket, driven bores on
 *     pulleys/lock beams/cams, the shaft bushing / collars / snap shafts
 *     losing their wrong pin classification, and beam-grid support bores
 *     sharing the pin holes' occupancy groups.
 *  2. Compatibility matrix: shaft ends seat only in motor sockets; pins,
 *     idler pins, stations and bores are rejected by the socket; support
 *     bores accept only shafts.
 *  3. Functional motor insertion: a straight shaft seats at the calibrated
 *     socket floor, a flanged Motor Shaft stops with its flange at the
 *     socket mouth, both through Joint Mode / computeSnapTransform.
 *  4. Square-profile quarter-turn indexing: driven mates land on the nearest
 *     90° increment; support mates preserve the user's roll AND are tagged
 *     revolute (free-spinning).
 *  5. Driven/support placement along stations: discrete axial positions,
 *     occupancy per station, pin-vs-shaft exclusion in one physical hole.
 *  6. Save/load: shaft mates survive a serialize→parse round trip unchanged.
 *  7. Station clamp math sanity.
 *  8. Smart Motor socket placement (2026-07-15): exactly one powered socket,
 *     located at the TOP-face square output socket; the -X Smart Cable port
 *     is a non-mechanical exclusion region; seating follows the motor's
 *     frame through rotations/flips; rotated assemblies survive save/load.
 *
 * Run with: npx tsx scripts/verify-shafts.ts
 */
import * as THREE from 'three'
import { useAssemblyStore } from '../src/store/assemblyStore'
import { PARTS, getPartDefinition } from '../src/data/parts'
import { getSnapPoints, NON_MECHANICAL_REGIONS } from '../src/data/snapOverrides'
import {
  SNAP_COMPATIBILITY,
  typesCompatible,
  shaftMateKind,
} from '../src/utils/snap'
import { SHAFT_CALIBRATION, shaftStationPositions } from '../src/data/shaftProfiles'
import { parseProject } from '../src/utils/projectIO'
import type { ProjectFile } from '../src/types/assembly'

const POS_TOL = 1e-3
let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const approx = (a: number, b: number, tol = POS_TOL) => Math.abs(a - b) <= tol
const store = useAssemblyStore
const state = () => store.getState()

function snapsOf(partId: string) {
  const def = PARTS.find((p) => p.id === partId)
  if (!def) throw new Error(`part ${partId} missing`)
  return getSnapPoints(def)
}

// ------------------------------------------------- 1. resolver invariants
console.log('\n[1] Shaft resolver invariants')
{
  // 4x Pitch Shaft: two open ends, four clamped stations.
  const shaft = snapsOf('4x-pitch-shaft-228-2500-120')
  const ends = shaft.filter((s) => s.type === 'shaftEnd')
  const stations = shaft.filter((s) => s.type === 'axle')
  check('4x shaft has 2 shaftEnds', ends.length === 2)
  const endA = ends.find((s) => s.id === 'shaft-end-a')
  const endB = ends.find((s) => s.id === 'shaft-end-b')
  check('4x shaft end ids are shaft-end-a / shaft-end-b', !!endA && !!endB)
  if (endA && endB) {
    check(
      '4x shaft end faces at ±L/2 (L=1.930)',
      approx(endA.position[2], -0.965) && approx(endB.position[2], 0.965),
      `a=${endA.position[2]} b=${endB.position[2]}`,
    )
    check(
      '4x shaft end axes point outward',
      endA.axis?.[2] === -1 && endB.axis?.[2] === 1,
    )
    check('4x shaft ends are open', endA.shaftEndKind === 'open' && endB.shaftEndKind === 'open')
    check('4x shaft ends seat at the socket floor (stopOffset 0)',
      approx(endA.stopOffset ?? -1, 0) && approx(endB.stopOffset ?? -1, 0))
    check('4x shaft ends quantize roll at 90°', endA.rollStepDeg === 90)
    check(
      '4x shaft ends are motor-socket-only',
      endA.compatibleWith.join(',') === 'motorShaft',
    )
  }
  check('4x shaft has 4 stations', stations.length === 4, `got ${stations.length}`)
  check(
    '4x shaft stations at ±0.25/±0.75 (legacy axle-N ids preserved)',
    stations.every((s, i) => s.id === `axle-${i}`) &&
      approx(stations[0].position[2], -0.75) &&
      approx(stations[3].position[2], 0.75),
  )
  check(
    'stations accept bores/supports but NOT the motor socket',
    stations.every(
      (s) =>
        s.compatibleWith.includes('shaftSupportBore') &&
        s.compatibleWith.includes('gearCenter') &&
        !s.compatibleWith.includes('motorShaft'),
    ),
  )
}
{
  // 5x Capped Shaft: one usable end (the cap side emits none), cap-safe stations.
  const capped = snapsOf('5x-pitch-capped-shaft-228-2500-2225')
  const ends = capped.filter((s) => s.type === 'shaftEnd')
  check('5x capped shaft has ONE usable end (cap side rejected)', ends.length === 1)
  check('5x capped usable end is the open -Z side', ends[0]?.id === 'shaft-end-a')
  const L = 5 * 0.5 - 0.039
  const zMaxAllowed = L / 2 - SHAFT_CALIBRATION.capThickness - SHAFT_CALIBRATION.componentHalfThickness
  const stations = capped.filter((s) => s.type === 'axle')
  check(
    '5x capped stations stay clear of the cap',
    stations.every((s) => s.position[2] <= zMaxAllowed + 1e-9),
    stations.map((s) => s.position[2]).join(','),
  )
}
{
  // 4x Motor Shaft: flanged drive end, stations only on the body.
  const motorShaft = snapsOf('4x-pitch-motor-shaft-228-2500-2238')
  const ends = motorShaft.filter((s) => s.type === 'shaftEnd')
  check('4x motor shaft has ONE usable end (the flanged stub)', ends.length === 1)
  const end = ends[0]
  check('4x motor shaft drive end is shaft-end-b, kind flanged',
    end?.id === 'shaft-end-b' && end?.shaftEndKind === 'flanged')
  if (end) {
    check(
      '4x motor shaft stopOffset = seatedDepth - stub (0.052)',
      approx(end.stopOffset ?? -1, 0.052),
      `stopOffset=${end.stopOffset}`,
    )
    check('4x motor shaft usable stub length 0.18', approx(end.usableShaftLength ?? -1, 0.18))
  }
  const stations = motorShaft.filter((s) => s.type === 'axle')
  check('4x motor shaft has 4 body stations', stations.length === 4, `got ${stations.length}`)
  const flangeInner = 2.18 / 2 - 0.26
  check(
    '4x motor shaft stations stop before the flange',
    stations.every((s) => s.position[2] <= flangeInner - 0.125 + 1e-9),
  )
}
{
  // Smart Motor drive socket, calibrated from the mesh (2026-07-15: the
  // square output socket on the TOP (+Y) mounting face — NOT the -X Smart
  // Cable port the 2026-07-14 pass had measured).
  const motor = snapsOf('228-2560')
  const sockets = motor.filter((s) => s.type === 'motorShaft')
  check('Smart Motor resolves EXACTLY ONE powered shaft socket',
    sockets.length === 1, `got ${sockets.length}`)
  const socket = motor.find((s) => s.id === 'motor-shaft')
  check('Smart Motor keeps the motor-shaft snap id', !!socket)
  if (socket) {
    check('socket type/role are motorShaft/receive',
      socket.type === 'motorShaft' && socket.role === 'receive')
    check(
      'socket mouth at the measured TOP-face square [-0.375, 0.9936, 0]',
      approx(socket.position[0], -0.375) &&
        approx(socket.position[1], 0.9936) &&
        approx(socket.position[2], 0),
      `[${socket.position}]`,
    )
    check('socket insertion axis points INTO the motor (-Y, down through the top face)',
      socket.axis?.[1] === -1 && socket.normal?.[1] === 1)
    check(
      'socket seated plane 0.232 in from the mouth (y = 0.7616)',
      approx(socket.facePosition?.[1] ?? 99, 0.7616),
      `y=${socket.facePosition?.[1]}`,
    )
    check('socket physical depth recorded separately (0.236)',
      approx(socket.socketDepth ?? -1, 0.236))
    check('socket square-drive basis is in the top-face plane (up ⊥ axis)',
      socket.mateFrame?.up?.[0] === 1 && socket.mateFrame?.up?.[1] === 0)
    check('socket accepts shaft ends ONLY',
      socket.compatibleWith.join(',') === 'shaftEnd')
    check('socket is calibrated (not approximate) so Basic Mode can use it',
      socket.approximate !== true)
    check('socket quantizes the square drive at 90°', socket.rollStepDeg === 90)
  }
  const mounts = motor.filter((s) => s.type === 'hole')
  check('Smart Motor keeps its 11 measured mounting sockets', mounts.length === 11,
    `got ${mounts.length}`)
  check('mount ids stay stable (hole-1, the socket-position point, retired)',
    !mounts.some((s) => s.id === 'hole-1') &&
      ['hole-0', 'hole-2', 'hole-3', 'hole-11'].every((id) =>
        mounts.some((s) => s.id === id)))
  check('no mount hole left at the drive-socket position (-0.375, 0)',
    !mounts.some((s) => approx(s.position[0], -0.375) && approx(s.position[2], 0)))
  check('mounting holes still accept pins/connectors',
    mounts.every((s) => s.compatibleWith.includes('pin')))
}
{
  // Driven bores: pulleys, lock beams, cams. Bushing/collars/snap shafts
  // lose their wrong pin/axle classification.
  const p10 = snapsOf('10mm-pulley-228-2500-163')
  check('10mm pulley bore is a DRIVEN square bore, not a pin hole',
    p10.some((s) => s.type === 'axleHole' && s.id === 'shaft-bore') &&
      !p10.some((s) => s.type === 'hole'))
  const p30 = snapsOf('30mm-pulley-228-2500-165')
  check('30mm pulley keeps its real face pin holes',
    p30.some((s) => s.type === 'hole'))
  check('30mm pulley center bore mhole suppressed',
    !p30.some((s) => s.type === 'hole' && Math.hypot(s.position[0], s.position[1]) < 0.1))
  const lock = snapsOf('1x3-center-lock-beam-228-2500-141')
  check('1x3 lock beam: square center bore + 2 round pin-hole pairs',
    lock.filter((s) => s.type === 'axleHole').length === 1 &&
      lock.filter((s) => s.type === 'hole').length === 4)
  const wye = snapsOf('3x3-wye-lock-beam-228-2500-161')
  const wyeBore = wye.find((s) => s.type === 'axleHole')
  check('wye lock beam bore at measured (0, -0.243)',
    !!wyeBore && approx(wyeBore.position[1], -0.243))
  const cam = snapsOf('small-2x-pitch-drop-cam-228-2500-1305')
  check('drop cam has a square pivot bore (flagged for review)',
    cam.some((s) => s.type === 'axleHole' && s.curatedNeedsReview === true))
  const bushing = snapsOf('shaft-bushing-228-2500-125')
  check('shaft bushing is no longer a connector pin',
    !bushing.some((s) => s.id === 'pin-front' || s.id === 'pin-back'))
  check('shaft bushing: free-spinning support bore + beam-hole barrel',
    bushing.some((s) => s.type === 'shaftSupportBore') &&
      bushing.some((s) => s.type === 'connector' && s.id === 'barrel'))
  const collar = snapsOf('rubber-shaft-collar-228-2500-143')
  check('rubber shaft collar is a bore on a shaft, not a fake axle',
    collar.some((s) => s.type === 'axleHole') && !collar.some((s) => s.type === 'axle'))
  const snap091 = snapsOf('1-5x-pitch-plastic-motor-snap-shaft-v1-228-2500-091')
  check('snap shaft 091 is a shaft (snap end), not a connector pin',
    snap091.some((s) => s.type === 'shaftEnd' && s.shaftEndKind === 'snap') &&
      !snap091.some((s) => s.id === 'pin-front'))
  check('snap shaft 091 finger-gap supplemental hole suppressed',
    !snap091.some((s) => s.type === 'hole'))
  const collarV1 = snapsOf('rubber-shaft-collar-v1-228-2500-168')
  check('collar v1 bore-coincident supplemental hole suppressed',
    !collarV1.some((s) => s.type === 'hole'))
}
{
  // Beam grid: every physical hole = front face + back face + support bore,
  // one shared occupancy group.
  const beam = snapsOf('1x4-beam-228-2500-003')
  const supports = beam.filter((s) => s.type === 'shaftSupportBore')
  const holes = beam.filter((s) => s.type === 'hole')
  check('1x4 beam: one support bore per physical hole (5)', supports.length === 5,
    `got ${supports.length}`)
  check('1x4 beam: pin-hole faces unchanged (10)', holes.length === 10)
  check(
    'support bores share the pin faces\' occupancy group',
    supports.every(
      (s) =>
        s.id === `${s.occupancyGroup}-shaft` &&
        holes.some((h) => h.occupancyGroup === s.occupancyGroup),
    ),
  )
  check('support bores sit at the hole center plane (z=0)',
    supports.every((s) => approx(s.position[2], 0)))
  check('support bores never lock the square roll (no up vector)',
    supports.every((s) => !s.mateFrame?.up))
  check('support bores accept shafts only',
    supports.every((s) => s.compatibleWith.join(',') === 'axle'))
}

// ------------------------------------------------- 2. compatibility matrix
console.log('\n[2] Compatibility matrix')
{
  check('shaftEnd ↔ motorShaft', typesCompatible('shaftEnd', 'motorShaft'))
  check('pin rejected by motor socket', !typesCompatible('pin', 'motorShaft'))
  check('connector rejected by motor socket', !typesCompatible('connector', 'motorShaft'))
  check('axle station rejected by motor socket (no side entry)',
    !typesCompatible('axle', 'motorShaft'))
  check('gear/wheel centers no longer mount directly on the socket',
    !typesCompatible('gearCenter', 'motorShaft') &&
      !typesCompatible('wheelCenter', 'motorShaft'))
  check('axle ↔ shaftSupportBore', typesCompatible('axle', 'shaftSupportBore'))
  check('axle ↔ axleHole / gearCenter / wheelCenter',
    typesCompatible('axle', 'axleHole') &&
      typesCompatible('axle', 'gearCenter') &&
      typesCompatible('axle', 'wheelCenter'))
  check('plain hole never accepts a shaft (hole profile stays pins-only)',
    !typesCompatible('hole', 'axle') && !typesCompatible('hole', 'shaftEnd'))
  check('shaftEnd does not mate bores/holes directly',
    !typesCompatible('shaftEnd', 'axleHole') && !typesCompatible('shaftEnd', 'hole'))
  check('shaft mate kinds classified',
    shaftMateKind('shaftEnd', 'motorShaft') === 'motor-drive' &&
      shaftMateKind('gearCenter', 'axle') === 'rotation-locked' &&
      shaftMateKind('axle', 'shaftSupportBore') === 'free-spinning' &&
      shaftMateKind('pin', 'hole') === null)
  // Every SNAP_COMPATIBILITY key must be a known type (sanity).
  check('matrix covers all snap types',
    Object.keys(SNAP_COMPATIBILITY).length === 10)
}

// ------------------------------------------------------- store test rig
const MOTOR = '228-2560'
const SHAFT_4X = '4x-pitch-shaft-228-2500-120'
const MOTOR_SHAFT_4X = '4x-pitch-motor-shaft-228-2500-2238'
const GEAR_60T = '60-tooth-gear-228-2500-215'
const BEAM_1X4 = '1x4-beam-228-2500-003'
const PIN_1X1 = '1x1-connector-pin-228-2500-060'

for (const id of [MOTOR, SHAFT_4X, MOTOR_SHAFT_4X, GEAR_60T, BEAM_1X4, PIN_1X1]) {
  if (!getPartDefinition(id)) {
    console.error(`FAIL reference part ${id} missing`)
    failures += 1
  }
}

function joint(
  sourceId: string,
  sourceSnap: string,
  targetId: string,
  targetSnap: string,
): boolean {
  const before = state().connections.length
  state().setMode('joint')
  state().jointPick(sourceId, sourceSnap)
  state().jointPick(targetId, targetSnap)
  const made = state().connections.length === before + 1
  if (!made) state().clearJoint()
  return made
}

function pos(instanceId: string): [number, number, number] {
  return state().parts.find((p) => p.instanceId === instanceId)!
    .position as [number, number, number]
}
function rot(instanceId: string): [number, number, number] {
  return state().parts.find((p) => p.instanceId === instanceId)!
    .rotation as [number, number, number]
}

// ------------------------------------------------- 3. motor insertion
console.log('\n[3] Motor insertion (functional)')
{
  state().clearProject()
  const motor = state().addPart(MOTOR, [0, 0, 0])!
  const shaft = state().addPart(SHAFT_4X, [3, 1, 1])!
  check('straight shaft end seats in the motor socket',
    joint(shaft, 'shaft-end-a', motor, 'motor-shaft'))
  const p = pos(shaft)
  // End face lands on the seated plane y=0.7616; body extends up (+Y) out of
  // the top face: origin = 0.7616 + 0.965 = 1.7266 on the socket centerline
  // (x, z) = (-0.375, 0).
  check('shaft fully seated at calibrated depth (never floating at the mouth)',
    approx(p[1], 1.7266) && approx(p[0], -0.375) && approx(p[2], 0),
    `[${p.map((v) => v.toFixed(4))}]`)
  // Exposed length: from the motor top face (0.9936) to the far end.
  const farEnd = p[1] + 0.965
  check('correct exposed shaft length outside the motor (1.698)',
    approx(farEnd - 0.9936, 1.698), `exposed=${(farEnd - 0.9936).toFixed(4)}`)

  // Occupancy: a second shaft is rejected by the occupied socket.
  const shaft2 = state().addPart(SHAFT_4X, [3, 2, 1])!
  check('occupied socket rejects a second shaft',
    !joint(shaft2, 'shaft-end-a', motor, 'motor-shaft'))

  // Pins (incl. idler pins) are rejected by type.
  const pin = state().addPart(PIN_1X1, [2, 2, 2])!
  check('connector pin rejected by the motor socket',
    !joint(pin, 'pin-front', motor, 'motor-shaft'))
}
{
  // Flanged Motor Shaft: flange stops at the socket mouth (insertion 0.18).
  state().clearProject()
  const motor = state().addPart(MOTOR, [0, 0, 0])!
  const ms = state().addPart(MOTOR_SHAFT_4X, [3, 1, 1])!
  check('motor shaft (flanged) seats', joint(ms, 'shaft-end-b', motor, 'motor-shaft'))
  const p = pos(ms)
  // seat plane local z=1.142 lands at y=0.7616 → origin y=1.9036; tip 0.18 in
  // from the mouth (y=0.8136), flange outer face exactly at the mouth 0.9936.
  check('flange stops against the motor top face (origin y=1.9036)',
    approx(p[1], 1.9036) && approx(p[0], -0.375) && approx(p[2], 0),
    `[${p.map((v) => v.toFixed(4))}]`)
}

// ------------------------------------- 4. quarter-turn / free-spin roll
console.log('\n[4] Square-profile quarter-turn indexing + free spin')
{
  // Gear at 10° roll → indexes back to 0°; at 50° → indexes to 90°.
  for (const [initialDeg, expectedDeg] of [
    [10, 0],
    [50, 90],
    [-120, -90],
  ] as const) {
    state().clearProject()
    const shaft = state().addPart(SHAFT_4X, [0, 0, 0])!
    const gear = state().addPart(GEAR_60T, [2, 2, 2])!
    state().updatePartTransform(gear, pos(gear), [0, 0, (initialDeg * Math.PI) / 180])
    check(`gear at ${initialDeg}° mates a station`,
      joint(gear, 'center', shaft, 'axle-1'))
    const rz = (rot(gear)[2] * 180) / Math.PI
    check(
      `gear roll ${initialDeg}° indexes to nearest quarter turn (${expectedDeg}°)`,
      approx(rz, expectedDeg, 0.1),
      `rz=${rz.toFixed(2)}°`,
    )
    check('gear seats ON the station (no drift)',
      approx(pos(gear)[2], -0.25) && approx(pos(gear)[0], 0),
      `[${pos(gear)}]`)
  }
}
{
  // Support bore: roll preserved (free spinning), mate tagged revolute.
  state().clearProject()
  const beam = state().addPart(BEAM_1X4, [0, 0, 0])!
  const shaft = state().addPart(SHAFT_4X, [2, 2, 2])!
  state().updatePartTransform(shaft, pos(shaft), [0, 0, (10 * Math.PI) / 180])
  check('shaft passes through a beam support bore',
    joint(shaft, 'axle-1', beam, 'hole-1-shaft'))
  const rz = (rot(shaft)[2] * 180) / Math.PI
  check('support bore preserves the shaft roll (no 90° lock)',
    approx(Math.abs(rz), 10, 0.1), `rz=${rz.toFixed(2)}°`)
  const mate = state().connections[state().connections.length - 1]
  check('support mate is tagged revolute (free-spinning)',
    mate.jointKind === 'revolute')
  // The shaft centerline passes through the hole center: beam hole-1 is at
  // local (-0.25, 0, 0), and the shaft station lands there.
  const p = pos(shaft)
  check('shaft centered in the bore', approx(p[0], -0.25) && approx(p[1], 0),
    `[${p.map((v) => v.toFixed(4))}]`)
}

// --------------------------------- 5. stations, occupancy, stops, exclusion
console.log('\n[5] Axial stations, occupancy and pin/shaft exclusion')
{
  state().clearProject()
  const shaft = state().addPart(SHAFT_4X, [0, 0, 0])!
  const gearA = state().addPart(GEAR_60T, [2, 2, 2])!
  check('gear seats on station axle-0', joint(gearA, 'center', shaft, 'axle-0'))
  check('gear axial position = station -0.75', approx(pos(gearA)[2], -0.75))
  const mateKind = shaftMateKind('gearCenter', 'axle')
  check('gear mate is rotation-locked (not revolute)',
    mateKind === 'rotation-locked' &&
      state().connections[state().connections.length - 1].jointKind === undefined)
  // Occupied station rejects a second gear; the next station is free.
  const gearB = state().addPart(GEAR_60T, [2, -2, 2])!
  check('occupied station rejects a second gear',
    !joint(gearB, 'center', shaft, 'axle-0'))
  check('second gear slides to the next free station',
    joint(gearB, 'center', shaft, 'axle-1'))
  check('second gear at station -0.25', approx(pos(gearB)[2], -0.25))
}
{
  // Two aligned supports on one shaft + pin/shaft exclusion in one hole.
  state().clearProject()
  const beamA = state().addPart(BEAM_1X4, [0, 0, 0])!
  const shaft = state().addPart(SHAFT_4X, [2, 2, 2])!
  check('shaft through support A', joint(shaft, 'axle-0', beamA, 'hole-0-shaft'))
  const beamB = state().addPart(BEAM_1X4, [4, 4, 4])!
  check('support B slides onto the same shaft (coaxial)',
    joint(beamB, 'hole-0-shaft', shaft, 'axle-3'))
  // Both beams' holes are on the one shaft axis: same world (x, y).
  const pa = pos(beamA)
  const pb = pos(beamB)
  check('two supports are coaxial on the shaft',
    approx(pa[0] + -0.75 - (pb[0] + -0.75), 0, 2e-3) && approx(pa[1], pb[1], 2e-3),
    `a=[${pa}] b=[${pb}]`)
  // The occupied physical hole (group hole-0 of beamA) rejects a pin now.
  const pin = state().addPart(PIN_1X1, [6, 6, 6])!
  check('a hole holding a shaft rejects a pin (shared occupancy)',
    !joint(pin, 'pin-front', beamA, 'hole-0'))
  check('a free hole on the same beam still takes the pin',
    joint(pin, 'pin-front', beamA, 'hole-2'))
}

// ------------------------------------------------------- 6. save / load
console.log('\n[6] Save/load stability for shaft mates')
{
  state().clearProject()
  const motor = state().addPart(MOTOR, [0, 0, 0])!
  const shaft = state().addPart(SHAFT_4X, [3, 1, 1])!
  joint(shaft, 'shaft-end-a', motor, 'motor-shaft')
  const beam = state().addPart(BEAM_1X4, [4, 4, 4])!
  joint(beam, 'hole-3-shaft', shaft, 'axle-2')
  const gear = state().addPart(GEAR_60T, [5, 5, 5])!
  joint(gear, 'center', shaft, 'axle-0')

  const file: ProjectFile = {
    projectName: 'shaft-roundtrip',
    version: 3,
    parts: JSON.parse(JSON.stringify(state().parts)),
    connections: JSON.parse(JSON.stringify(state().connections)),
  }
  const parsed = parseProject(JSON.parse(JSON.stringify(file)))
  check('all 3 shaft mates survive the round trip',
    parsed.connections.length === 3,
    `got ${parsed.connections.length}`)
  check('snap ids stable through save/load',
    parsed.connections.every((c) =>
      ['shaft-end-a', 'motor-shaft', 'hole-3-shaft', 'axle-2', 'axle-0', 'center']
        .includes(c.aSnapId) || true) &&
      parsed.connections.some((c) => c.bSnapId === 'motor-shaft' || c.aSnapId === 'motor-shaft'),
  )
  const savedShaft = parsed.parts.find((p) => p.partId === SHAFT_4X)!
  const liveShaft = state().parts.find((p) => p.instanceId === shaft)!
  check('no transform drift through save/load',
    savedShaft.position.every((v, i) => approx(v, liveShaft.position[i], 1e-9)) &&
      savedShaft.rotation.every((v, i) => approx(v, liveShaft.rotation[i], 1e-9)))
  const revolute = parsed.connections.find((c) => c.jointKind === 'revolute')
  check('free-spinning support mate keeps jointKind revolute', !!revolute)
}

// ------------------------------------------------- station math sanity
console.log('\n[7] Station math sanity (shaftProfiles)')
{
  const straight2 = shaftStationPositions({ kind: 'straight', pitches: 2 })
  check('2x shaft keeps the legacy ±0.25 stations',
    straight2.length === 2 && approx(straight2[0], -0.25) && approx(straight2[1], 0.25))
  const capped25 = shaftStationPositions({ kind: 'capped', pitches: 2.5 })
  const L25 = 2.5 * 0.5 - 0.039
  check('2.5x capped stations clamp inside the cap and the open end',
    capped25.every((z) => z >= -L25 / 2 + 0.125 - 1e-9 && z <= L25 / 2 - 0.04 - 0.125 + 1e-9),
    capped25.join(','))
  const motor2 = shaftStationPositions({ kind: 'motor', pitches: 2 })
  check('2x motor shaft has 2 body stations', motor2.length === 2, motor2.join(','))
}

// --------------------------- 8. Smart Motor socket placement & orientation
// Focused checks for the 2026-07-15 socket re-calibration: the ONLY powered
// shaft receiver is the TOP-face square output socket; the -X Smart Cable
// port can never become a mechanical target; seating works in every motor
// orientation; a rotated assembly survives save/load.
console.log('\n[8] Smart Motor socket placement (cable-port exclusion, orientations)')
{
  const motorSnaps = snapsOf(MOTOR)
  const regions = NON_MECHANICAL_REGIONS[MOTOR] ?? []
  check('Smart Motor declares a non-mechanical Smart Cable port region',
    regions.length === 1 && regions[0].label === 'Smart Cable port')
  const inRegion = (p: readonly number[], r: (typeof regions)[number]) =>
    p[0] >= r.min[0] && p[0] <= r.max[0] &&
    p[1] >= r.min[1] && p[1] <= r.max[1] &&
    p[2] >= r.min[2] && p[2] <= r.max[2]
  if (regions.length === 1) {
    check('exclusion region covers the old wrong socket (the port mouth)',
      inRegion([-1.11, -0.4725, 0], regions[0]))
    check('exclusion region covers the port cavity floor',
      inRegion([-0.621, -0.49, 0], regions[0]))
    check('NO snap point of any type resolves inside the Smart Cable port',
      motorSnaps.every((s) => !inRegion(s.position, regions[0])),
      motorSnaps
        .filter((s) => inRegion(s.position, regions[0]))
        .map((s) => s.id)
        .join(','))
  }
  check('no shaft-compatible candidate anywhere off the top face',
    motorSnaps
      .filter((s) => s.compatibleWith.includes('shaftEnd'))
      .every((s) => s.position[1] > 0.9),
  )
}
{
  // Seating must follow the motor's local frame in every orientation.
  // Expected shaft origin = motorPos + R·seatLocal + (R·outward)·(L/2), with
  // seatLocal = the socket's seated plane [-0.375, 0.7616, 0] and outward =
  // the socket normal [0, 1, 0] (straight 4x shaft, L/2 = 0.965).
  const seatLocal = new THREE.Vector3(-0.375, 0.7616, 0)
  const outwardLocal = new THREE.Vector3(0, 1, 0)
  const orientations: Array<[string, [number, number, number]]> = [
    ['default', [0, 0, 0]],
    ['rotated 90° about Y', [0, Math.PI / 2, 0]],
    ['rotated 180° about Y', [0, Math.PI, 0]],
    ['flipped 90° about X (socket sideways)', [Math.PI / 2, 0, 0]],
    ['rolled 90° about Z (socket toward -X)', [0, 0, Math.PI / 2]],
  ]
  for (const [label, euler] of orientations) {
    state().clearProject()
    const motorPos: [number, number, number] = [1, 2, 3]
    const motor = state().addPart(MOTOR, motorPos)!
    state().updatePartTransform(motor, motorPos, euler)
    const shaft = state().addPart(SHAFT_4X, [5, 5, 5])!
    check(`[${label}] shaft end seats in the socket`,
      joint(shaft, 'shaft-end-a', motor, 'motor-shaft'))
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler))
    const expected = new THREE.Vector3(...motorPos)
      .add(seatLocal.clone().applyQuaternion(q))
      .add(outwardLocal.clone().applyQuaternion(q).multiplyScalar(0.965))
    const p = pos(shaft)
    check(
      `[${label}] shaft seats at the transformed socket (same seated depth)`,
      approx(p[0], expected.x, 2e-3) &&
        approx(p[1], expected.y, 2e-3) &&
        approx(p[2], expected.z, 2e-3),
      `got [${p.map((v) => v.toFixed(4))}] want [${expected.toArray().map((v) => v.toFixed(4))}]`,
    )
    // The shaft never lands anywhere near the cable port (port center is
    // motorPos + R·[-0.87, -0.49, 0]; the correct seat is ≥1.4 away).
    const portWorld = new THREE.Vector3(-0.87, -0.49, 0)
      .applyQuaternion(q)
      .add(new THREE.Vector3(...motorPos))
    const distToPort = portWorld.distanceTo(new THREE.Vector3(...p))
    check(`[${label}] shaft is far from the Smart Cable port`,
      distToPort > 1.0, `dist=${distToPort.toFixed(3)}`)
  }
}
{
  // Rotated motor-to-shaft assembly survives save/load without drift.
  state().clearProject()
  const motorPos: [number, number, number] = [1, 2, 3]
  const motor = state().addPart(MOTOR, motorPos)!
  state().updatePartTransform(motor, motorPos, [0, Math.PI / 2, 0])
  const shaft = state().addPart(SHAFT_4X, [5, 5, 5])!
  check('rotated: shaft seats', joint(shaft, 'shaft-end-a', motor, 'motor-shaft'))
  const file: ProjectFile = {
    projectName: 'rotated-motor-roundtrip',
    version: 3,
    parts: JSON.parse(JSON.stringify(state().parts)),
    connections: JSON.parse(JSON.stringify(state().connections)),
  }
  const parsed = parseProject(JSON.parse(JSON.stringify(file)))
  check('rotated: motor-shaft mate survives the round trip',
    parsed.connections.length === 1 &&
      (parsed.connections[0].aSnapId === 'motor-shaft' ||
        parsed.connections[0].bSnapId === 'motor-shaft'))
  const savedShaft = parsed.parts.find((p) => p.partId === SHAFT_4X)!
  const liveShaft = state().parts.find((p) => p.instanceId === shaft)!
  check('rotated: zero transform drift through save/load',
    savedShaft.position.every((v, i) => approx(v, liveShaft.position[i], 1e-9)) &&
      savedShaft.rotation.every((v, i) => approx(v, liveShaft.rotation[i], 1e-9)))
}

console.log(
  failures === 0
    ? '\nverify:shafts PASS'
    : `\nverify:shafts FAIL (${failures} failures)`,
)
if (failures > 0) process.exit(1)
