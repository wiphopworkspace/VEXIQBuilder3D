/**
 * Tracked shaft-POSITIONING regression check (`npm run verify:slide`).
 *
 * `verify-shafts.ts` locks in where a shaft mate LANDS. This one locks in what
 * happens afterwards: moving a part along the shaft it is already on, which is
 * the one translational freedom a VEX IQ mate keeps and the only build step
 * that had no control at all before 2026-08-19.
 *
 *  1. Resolver: a station series is collinear-and-ordered, a rider finds its
 *     shaft, a shaft finds its rider, an unmated part finds nothing.
 *  2. Travel: one press moves the part exactly one station pitch along the
 *     shaft axis and nothing else moves; the MATE follows to the new station.
 *  3. Direction: +1 always moves the SELECTED part along +axis, whether the
 *     mover is the rider or the shaft itself.
 *  4. Ends and occupancy: the series clamps at both ends and refuses to land
 *     on a station another part already holds.
 *  5. Loops: a second path between the two sides blocks the slide.
 *  6. Carried bodies: a slide takes the mover's whole assembly and keeps every
 *     joint inside it exact.
 *  7. Durability: a slid position survives serialize → parse →
 *     `reseatAssemblyFromMates`, which rebuilds transforms FROM the mates.
 *  8. Undo restores the pre-slide pose AND the pre-slide station.
 *  9. `insertPartAtSnapPoint` seats a shaft in the Smart Motor socket exactly
 *     where Joint Mode does, refuses an occupied socket, and hangs a part that
 *     offers several compatible bores by the one nearest its own centre.
 *
 * Run with: npx tsx scripts/verify-shaft-slide.ts
 */
import * as THREE from 'three'
import { useAssemblyStore } from '../src/store/assemblyStore'
import { getPartDefinition } from '../src/data/parts'
import { getWorldSnapPoints, validateMate } from '../src/utils/snap'
import {
  findShaftSlide,
  slideStepDistance,
  stationSeriesFor,
} from '../src/utils/shaftSlide'
import { SHAFT_CALIBRATION } from '../src/data/shaftProfiles'
import { parseProject } from '../src/utils/projectIO'
import { reseatAssemblyFromMates } from '../src/utils/snap'
import type { ProjectFile, Vec3 } from '../src/types/assembly'

const TOL = 1e-4
let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const approx = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol
const store = useAssemblyStore
const state = () => store.getState()

const MOTOR = '228-2560'
const SHAFT_4X = '4x-pitch-shaft-228-2500-120'
const SHAFT_8X = '8x-pitch-shaft-228-2500-124'
const GEAR_60T = '60-tooth-gear-228-2500-215'
const GEAR_36T = '36-tooth-gear-228-2500-214'
const BEAM_1X8 = '1x8-beam-228-2500-007'
const LOCK_BEAM = '2x2-center-lock-beam-228-2500-140'

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

const posOf = (id: string) =>
  new THREE.Vector3(
    ...(state().parts.find((p) => p.instanceId === id)!.position as Vec3),
  )

const snapIdsOfMate = (mateId: string) => {
  const c = state().connections.find((m) => m.id === mateId)!
  return [c.aSnapId, c.bSnapId]
}

/** Worst contact-frame gap over every mate in the scene. 0 = everything seated. */
function worstGap(): number {
  let worst = 0
  for (const mate of state().connections) {
    const gap = validateMate(mate, state().parts, state().pinSeating).contactGap
    if (gap !== null && gap > worst) worst = gap
  }
  return worst
}

// -------------------------------------------------------- 1. resolver shape
console.log('\n[1] Station series and slide resolution')
{
  const def = getPartDefinition(SHAFT_4X)!
  const series = stationSeriesFor(def, 'axle-2')
  check('4x shaft resolves a station series', !!series)
  check(
    'series is every axle station, ascending',
    series!.stations.length === 4 &&
      series!.stations.every(
        (s, i) => i === 0 || s.t > series!.stations[i - 1].t,
      ),
    series!.stations.map((s) => `${s.snapId}@${s.t}`).join(' '),
  )
  check(
    'series pitch is the calibrated station pitch',
    approx(
      series!.stations[1].t - series!.stations[0].t,
      SHAFT_CALIBRATION.stationPitch,
    ),
  )
  check(
    'a non-station snap has no series',
    stationSeriesFor(def, 'shaft-end-a') === null,
  )

  state().clearProject()
  const lone = state().addPart(GEAR_60T, [0, 0, 0])!
  check('an unmated part has no slide', state().shaftSlideFor(lone) === null)
}

// ------------------------------------------------------------- 2. one press
console.log('\n[2] One press = one station along the shaft axis')
{
  state().clearProject()
  const motor = state().addPart(MOTOR, [0, 0, 0])!
  const shaft = state().addPart(SHAFT_4X, [3, 1, 1])!
  check('shaft seats in the motor socket', joint(shaft, 'shaft-end-a', motor, 'motor-shaft'))
  const gear = state().addPart(GEAR_60T, [5, 5, 5])!
  check('gear seats on station axle-2', joint(gear, 'center', shaft, 'axle-2'))

  const slide = state().shaftSlideFor(gear)!
  check('gear resolves a slide', !!slide)
  check('the shaft is the other side', slide.shaftInstanceId === shaft)
  check('the gear is the mover', slide.moverInstanceId === gear && !slide.moverIsShaft)
  check('the gear carries only itself', slide.moverIds.length === 1)
  check('current station index is 2', slide.index === 2)
  check(
    'one step is the station pitch',
    approx(slideStepDistance(slide, -1), SHAFT_CALIBRATION.stationPitch),
  )

  const gearBefore = posOf(gear)
  const shaftBefore = posOf(shaft)
  const motorBefore = posOf(motor)
  state().slideAlongShaft(gear, -1)

  const travelled = posOf(gear).clone().sub(gearBefore)
  check(
    'gear moved exactly one pitch',
    approx(travelled.length(), SHAFT_CALIBRATION.stationPitch),
    `moved ${travelled.length().toFixed(5)}`,
  )
  check(
    'gear moved ALONG the shaft axis',
    approx(
      Math.abs(travelled.clone().normalize().dot(new THREE.Vector3(...slide.axis))),
      1,
    ),
  )
  check('the shaft did not move', posOf(shaft).distanceTo(shaftBefore) < TOL)
  check('the motor did not move', posOf(motor).distanceTo(motorBefore) < TOL)
  check(
    'the mate followed to axle-1',
    snapIdsOfMate(slide.mateId).includes('axle-1'),
    snapIdsOfMate(slide.mateId).join('/'),
  )
  check(
    'the connector ref followed too',
    (() => {
      const c = state().connections.find((m) => m.id === slide.mateId)!
      const ref = c.aInstanceId === shaft ? c.aConnectorRef : c.bConnectorRef
      return ref?.snapId === 'axle-1' && ref?.connectorId === 'axle-1'
    })(),
  )
  check('every mate in the scene is still seated', worstGap() < 1e-3, `worst ${worstGap()}`)

  // And back again: the move is reversible to the float.
  state().slideAlongShaft(gear, 1)
  check('sliding back returns the exact pose', posOf(gear).distanceTo(gearBefore) < 1e-9)
  check('sliding back returns the station', state().shaftSlideFor(gear)!.index === 2)
}

// ------------------------------------------------------------ 3. directions
console.log('\n[3] +1 always moves the SELECTED part along +axis')
{
  state().clearProject()
  const beam = state().addPart(BEAM_1X8, [0, 0, 0])!
  const shaft = state().addPart(SHAFT_8X, [4, 4, 4])!
  check('shaft passes through the beam bore', joint(shaft, 'axle-3', beam, 'hole-3-shaft'))

  const asShaft = state().shaftSlideFor(shaft)!
  check('the shaft is the mover when selected', asShaft.moverIsShaft)
  const axis = new THREE.Vector3(...asShaft.axis)
  const shaftBefore = posOf(shaft)
  state().slideAlongShaft(shaft, 1)
  const shaftTravel = posOf(shaft).clone().sub(shaftBefore)
  check(
    'shaft travelled along +axis',
    shaftTravel.dot(axis) > 0 &&
      approx(shaftTravel.length(), SHAFT_CALIBRATION.stationPitch),
    `dot ${shaftTravel.dot(axis).toFixed(4)}`,
  )
  check(
    'the station index went DOWN as the shaft went up',
    state().shaftSlideFor(shaft)!.index === asShaft.index - 1,
  )
  check('beam stayed put', posOf(beam).distanceTo(new THREE.Vector3(0, 0, 0)) < TOL)
  check('shaft/beam mate still seated', worstGap() < 1e-3)

  const asBeam = state().shaftSlideFor(beam)!
  check('the beam is the mover when IT is selected', !asBeam.moverIsShaft)
  const beamBefore = posOf(beam)
  state().slideAlongShaft(beam, 1)
  const beamTravel = posOf(beam).clone().sub(beamBefore)
  check(
    'beam travelled along +axis too',
    beamTravel.dot(new THREE.Vector3(...asBeam.axis)) > 0,
    `dot ${beamTravel.dot(new THREE.Vector3(...asBeam.axis)).toFixed(4)}`,
  )
}

// --------------------------------------------------- 4. ends and occupancy
console.log('\n[4] Shaft ends clamp; occupied stations refuse')
{
  state().clearProject()
  const shaft = state().addPart(SHAFT_4X, [0, 0, 0])!
  const gearA = state().addPart(GEAR_60T, [3, 3, 3])!
  const gearB = state().addPart(GEAR_36T, [5, 5, 5])!
  joint(gearA, 'center', shaft, 'axle-1')
  joint(gearB, 'center', shaft, 'axle-3')

  state().slideAlongShaft(gearA, -1)
  check('gear A reached station 0', state().shaftSlideFor(gearA)!.index === 0)
  const atEnd = posOf(gearA)
  state().slideAlongShaft(gearA, -1)
  check('a press past the end does not move it', posOf(gearA).distanceTo(atEnd) < 1e-9)
  check(
    'and says so',
    /Already at position 1 of 4/.test(state().statusMessage),
    state().statusMessage,
  )

  state().slideAlongShaft(gearA, 1)
  state().slideAlongShaft(gearA, 1) // -> axle-2
  check('gear A is at station 2', state().shaftSlideFor(gearA)!.index === 2)
  const before = posOf(gearA)
  state().slideAlongShaft(gearA, 1) // axle-3 is taken by gear B
  check('an occupied station refuses the slide', posOf(gearA).distanceTo(before) < 1e-9)
  check(
    'and names the part in the way',
    /is taken by 36 Tooth Gear/.test(state().statusMessage),
    state().statusMessage,
  )
  check(
    'occupancy is reported by the resolver',
    state().shaftSlideFor(gearA)!.stations[3].occupiedBy === gearB,
  )
}

// --------------------------------------------------------------- 5. loops
console.log('\n[5] A second path between the two sides blocks the slide')
{
  // A shaft carrying two lock beams that are ALSO bolted to each other: the
  // shaft is then reachable from either beam without using the mate being slid,
  // so translating one relative to the other is a tear, not a move. Built by
  // LOADING a project rather than by Joint Mode — Joint Mode refuses to create
  // the closing mate precisely because the parts are already held, which is the
  // gate working, and leaves no way to reach this state interactively. A saved
  // file, a paste, or a future authoring path can still present one.
  state().clearProject()
  const shaft = state().addPart(SHAFT_8X, [0, 0, 0])!
  const lockA = state().addPart(LOCK_BEAM, [3, 3, 3])!
  const lockB = state().addPart(LOCK_BEAM, [5, 5, 5])!
  joint(lockA, 'shaft-bore', shaft, 'axle-2')
  joint(lockB, 'shaft-bore', shaft, 'axle-4')
  const file: ProjectFile = {
    projectName: 'loop-fixture',
    version: 3,
    parts: JSON.parse(JSON.stringify(state().parts)),
    connections: [
      ...JSON.parse(JSON.stringify(state().connections)),
      {
        id: 'mate-loop-closer',
        aInstanceId: lockA,
        aSnapId: 'mhole-0',
        bInstanceId: lockB,
        bSnapId: 'mhole-0-back',
        type: 'snap',
      },
    ],
  }
  state().loadProject(JSON.parse(JSON.stringify(file)))
  check('the loop fixture loaded', state().connections.length === 3)

  const slide = state().shaftSlideFor(lockA)!
  check('the resolver flags the loop', !!slide && slide.looped)
  const before = posOf(lockA)
  state().slideAlongShaft(lockA, 1)
  check('the slide is refused', posOf(lockA).distanceTo(before) < 1e-9)
  check(
    'and explains why',
    /also joined another way/.test(state().statusMessage),
    state().statusMessage,
  )
}

// ------------------------------------------------------- 6. carried bodies
console.log('\n[6] A slide carries the mover assembly, joints intact')
{
  state().clearProject()
  const shaft = state().addPart(SHAFT_8X, [0, 0, 0])!
  const lock = state().addPart(LOCK_BEAM, [3, 3, 3])!
  joint(lock, 'shaft-bore', shaft, 'axle-2')
  const partCount = state().parts.length
  state().insertPinAtSnapPoint(lock, 'mhole-0')
  check('a pin is mounted on the lock beam', state().parts.length === partCount + 1)
  const pinId = state().parts[state().parts.length - 1].instanceId

  const slide = state().shaftSlideFor(lock)!
  check('the lock beam carries its pin', slide.moverIds.length === 2, slide.moverIds.join(','))
  const lockBefore = posOf(lock)
  const relBefore = posOf(pinId).clone().sub(lockBefore)
  state().slideAlongShaft(lock, 1)
  check(
    'the lock beam moved one pitch',
    approx(posOf(lock).distanceTo(lockBefore), SHAFT_CALIBRATION.stationPitch),
  )
  check(
    'the pin came with it, rigidly',
    posOf(pinId).clone().sub(posOf(lock)).distanceTo(relBefore) < 1e-9,
  )
  check('every joint in the scene is still exact', worstGap() < 1e-3, `worst ${worstGap()}`)
}

// ---------------------------------------------------------- 7. durability
console.log('\n[7] A slid position survives save → load → re-seat')
{
  state().clearProject()
  const motor = state().addPart(MOTOR, [0, 0, 0])!
  const shaft = state().addPart(SHAFT_4X, [3, 1, 1])!
  joint(shaft, 'shaft-end-a', motor, 'motor-shaft')
  const gear = state().addPart(GEAR_60T, [5, 5, 5])!
  joint(gear, 'center', shaft, 'axle-3')
  state().slideAlongShaft(gear, -2)
  check('gear slid to station 1', state().shaftSlideFor(gear)!.index === 1)
  const slidPose = posOf(gear)

  const file: ProjectFile = {
    projectName: 'slide-roundtrip',
    version: 3,
    parts: JSON.parse(JSON.stringify(state().parts)),
    connections: JSON.parse(JSON.stringify(state().connections)),
  }
  const parsed = parseProject(JSON.parse(JSON.stringify(file)))
  const reseated = reseatAssemblyFromMates(parsed.parts, parsed.connections)
  const loadedGear = reseated.parts.find((p) => p.partId === GEAR_60T)!
  check(
    'the re-seat puts the gear back on station 1, not its old station',
    new THREE.Vector3(...loadedGear.position).distanceTo(slidPose) < 1e-6,
    `off by ${new THREE.Vector3(...loadedGear.position).distanceTo(slidPose).toFixed(6)}`,
  )
  check(
    'the saved mate names the new station',
    parsed.connections.some((c) => c.aSnapId === 'axle-1' || c.bSnapId === 'axle-1'),
    parsed.connections.map((c) => `${c.aSnapId}/${c.bSnapId}`).join(' '),
  )
}

// ---------------------------------------------------------------- 8. undo
console.log('\n[8] Undo restores pose AND station')
{
  state().clearProject()
  const shaft = state().addPart(SHAFT_4X, [0, 0, 0])!
  const gear = state().addPart(GEAR_60T, [3, 3, 3])!
  joint(gear, 'center', shaft, 'axle-2')
  const before = posOf(gear)
  state().slideAlongShaft(gear, -1)
  check('slid', state().shaftSlideFor(gear)!.index === 1)
  state().undo()
  check('undo restores the pose', posOf(gear).distanceTo(before) < 1e-9)
  check('undo restores the station', state().shaftSlideFor(gear)!.index === 2)
  state().redo()
  check('redo re-applies it', state().shaftSlideFor(gear)!.index === 1)
}

// --------------------------------------------- 9. one-click motor insertion
console.log('\n[9] insertPartAtSnapPoint seats a shaft in the motor socket')
{
  state().clearProject()
  const motorA = state().addPart(MOTOR, [0, 0, 0])!
  const shaftA = state().addPart(SHAFT_4X, [4, 4, 4])!
  joint(shaftA, 'shaft-end-a', motorA, 'motor-shaft')
  const jointSeatedPose = posOf(shaftA)
  const jointSeatedRot = state().parts.find((p) => p.instanceId === shaftA)!
    .rotation as Vec3

  state().clearProject()
  const motorB = state().addPart(MOTOR, [0, 0, 0])!
  const inserted = state().insertPartAtSnapPoint(motorB, 'motor-shaft', SHAFT_4X)
  check('a shaft was inserted', !!inserted)
  check(
    'it lands exactly where Joint Mode puts it',
    posOf(inserted!).distanceTo(jointSeatedPose) < 1e-9,
    `off by ${posOf(inserted!).distanceTo(jointSeatedPose)}`,
  )
  const rot = state().parts.find((p) => p.instanceId === inserted)!.rotation
  check(
    'with the same orientation',
    rot.every((v, i) => Math.abs(v - jointSeatedRot[i]) < 1e-9),
  )
  check(
    'the mate uses an insertable shaft end',
    state().connections.some((c) => c.aSnapId.startsWith('shaft-end')),
  )
  check(
    'the socket mate seats to zero gap',
    worstGap() < 1e-3,
    `worst ${worstGap()}`,
  )
  const again = state().insertPartAtSnapPoint(motorB, 'motor-shaft', SHAFT_4X)
  check('a second insert into the same socket is refused', again === null)
  check(
    'and says the socket is taken',
    /already occupied/i.test(state().statusMessage),
    state().statusMessage,
  )

  // A part offering SEVERAL compatible points is hung by the one nearest its
  // own centre, not by whichever the definition happens to list first — a 1x8
  // beam has eight support bores and definition order would mount it by an end.
  {
    state().clearProject()
    const shaft = state().addPart(SHAFT_8X, [0, 0, 0])!
    const beam = state().insertPartAtSnapPoint(shaft, 'axle-3', BEAM_1X8)
    check('a beam was fitted onto the shaft', !!beam)
    check(
      'it hangs by its CENTRE bore, not hole-0',
      state().connections.some(
        (c) => c.aSnapId === 'hole-center-shaft' || c.bSnapId === 'hole-center-shaft',
      ),
      state().connections.map((c) => `${c.aSnapId}/${c.bSnapId}`).join(' '),
    )
    state().clearProject()
    const motorC = state().addPart(MOTOR, [0, 0, 0])!
    const inserted2 = state().insertPartAtSnapPoint(motorC, 'motor-shaft', SHAFT_4X)
    check(
      'a two-ended shaft still leads with shaft-end-a (ends are equidistant)',
      state().connections.some((c) => c.aSnapId === 'shaft-end-a'),
      state().connections.map((c) => c.aSnapId).join(' '),
    )
    check('and it seated', !!inserted2 && worstGap() < 1e-3)
  }

  // The freshly inserted shaft is immediately slidable-onto: the whole point
  // of putting the motor drive first.
  state().clearProject()
  const motorD = state().addPart(MOTOR, [0, 0, 0])!
  const shaftD = state().insertPartAtSnapPoint(motorD, 'motor-shaft', SHAFT_4X)!
  const gear = state().addPart(GEAR_60T, [6, 6, 6])!
  joint(gear, 'center', shaftD, 'axle-0')
  const slide = state().shaftSlideFor(gear)
  check('a gear on the inserted shaft can slide', !!slide && slide.stations.length === 4)
  const worldStations = getWorldSnapPoints(
    state().parts.find((p) => p.instanceId === shaftD)!,
    getPartDefinition(SHAFT_4X)!,
  ).filter((s) => s.type === 'axle')
  check(
    'its stations climb out of the motor',
    worldStations.every((s, i) => i === 0 || s.worldPosition.y > worldStations[i - 1].worldPosition.y),
    worldStations.map((s) => s.worldPosition.y.toFixed(3)).join(' '),
  )
}

console.log(
  failures === 0
    ? '\nverify:slide PASS'
    : `\nverify:slide FAIL — ${failures} check(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
