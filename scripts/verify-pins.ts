/**
 * Tracked pin regression check (`npm run verify:pins`).
 *
 * Locks in the calibrated pin behavior headlessly (no WebGL):
 *  1. Profile-match audit: no PARTS entry without "pin" in its name/id may
 *     match a pin profile (guards the fuzzy `3x3`/`2x3` terms against
 *     angle-beam/panel false positives).
 *  2. Per-layer seat structure: every pin side exposes one seat per plastic
 *     layer (pin-front, pin-front-2, …), seat planes step by exactly one beam
 *     thickness, and the visually calibrated 1x2 pin-back-2 values are pinned.
 *  3. Same-hole seat equality: 1x1 / 2x2 / 3x3 seat at the IDENTICAL world
 *     transform when inserted into the same beam hole.
 *  4. Functional stacking: beams attached to layer seats land at the locked
 *     world offsets (the calibrated stacked-seat convention), every seat is
 *     independently occupiable, and an occupied seat rejects a second beam.
 *
 * Run with: npx tsx scripts/verify-pins.ts
 */
import { useAssemblyStore } from '../src/store/assemblyStore'
import { PARTS, getPartDefinition } from '../src/data/parts'
import { getWorldSnapPoints } from '../src/utils/snap'
import { matchPinProfile, PIN_PROFILES } from '../src/data/pinProfiles'
import { SNAP_CALIBRATION } from '../src/data/snapCalibration'

const BEAM_PART_ID = '1x4-beam-228-2500-003'
const POS_TOL = 1e-4

let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function approx(a: number, b: number, tol = POS_TOL): boolean {
  return Math.abs(a - b) <= tol
}

const store = useAssemblyStore
const state = () => store.getState()

// ---------------------------------------------------------------- 1. audit
console.log('\n[1] Profile-match audit over PARTS')
{
  let matched = 0
  const falsePositives: string[] = []
  for (const def of PARTS) {
    const profile = matchPinProfile(def)
    if (!profile) continue
    matched += 1
    const text = `${def.id} ${def.name}`.toLowerCase()
    if (!text.includes('pin')) {
      falsePositives.push(`${def.id} -> ${profile.key}`)
    }
  }
  check(
    `profile matches are all pins (${matched} matched)`,
    falsePositives.length === 0,
    falsePositives.join('; '),
  )
}

// ------------------------------------------------- 2. per-layer seat shape
console.log('\n[2] Per-layer seat structure')
{
  const layerStep = SNAP_CALIBRATION.beamReceivingDepth
  const expectedEndCounts: Record<string, number> = {
    pin1x1: 2,
    pin2x2: 4,
    pin3x3: 6,
    pin2x3: 5,
    pin1x2: 3,
    pin0x2SphericalCap: 2,
    pin0x2: 2,
    pin0x3: 3,
  }
  for (const profile of PIN_PROFILES) {
    const expected = expectedEndCounts[profile.key]
    check(
      `${profile.key} has ${expected} seats`,
      profile.ends.length === expected,
      `got ${profile.ends.length}`,
    )
    // Consecutive same-side layer seats must be exactly one beam thickness
    // apart along the seat axis.
    for (const side of ['front', 'back'] as const) {
      const sideEnds = profile.ends.filter((e) =>
        e.id === `pin-${side}` || e.id.startsWith(`pin-${side}-`),
      )
      for (let i = 1; i < sideEnds.length; i++) {
        const dz = Math.abs(
          sideEnds[i].seatPlanePosition[2] - sideEnds[i - 1].seatPlanePosition[2],
        )
        check(
          `${profile.key} ${sideEnds[i].id} seat plane one layer past ${sideEnds[i - 1].id}`,
          approx(dz, layerStep, 1e-9),
          `dz=${dz}`,
        )
      }
    }
  }
  // The 1x1 profile is the calibrated anchor — its shape must never change.
  const pin1x1 = PIN_PROFILES.find((p) => p.key === 'pin1x1')!
  check(
    'pin1x1 keeps exactly [pin-front, pin-back]',
    pin1x1.ends.map((e) => e.id).join(',') === 'pin-front,pin-back',
  )
  // The visually calibrated 1x2 pin-back-2 is pinned byte-for-byte.
  const pin1x2 = PIN_PROFILES.find((p) => p.key === 'pin1x2')!
  const back2 = pin1x2.ends.find((e) => e.id === 'pin-back-2')
  check('pin1x2 pin-back-2 exists', !!back2)
  if (back2) {
    check(
      'pin1x2 pin-back-2 seat plane at calibrated z',
      approx(back2.seatPlanePosition[2], -0.122 + layerStep, 1e-9),
      `z=${back2.seatPlanePosition[2]}`,
    )
    check(
      'pin1x2 pin-back-2 keeps calibrated adjustment -0.012',
      approx(back2.finalSeatAdjustment ?? 0, -0.012, 1e-9),
      `adj=${back2.finalSeatAdjustment}`,
    )
  }
}

// --------------------------------------------------------- store test rig
const beamDef = PARTS.find((p) => p.id === BEAM_PART_ID)
if (!beamDef || !getPartDefinition(BEAM_PART_ID)) {
  console.error(`FAIL reference beam ${BEAM_PART_ID} missing from PARTS`)
  failures += 1
}

function holeIdOf(instanceId: string): string {
  const inst = state().parts.find((p) => p.instanceId === instanceId)!
  const def = getPartDefinition(inst.partId)!
  const hole = getWorldSnapPoints(inst, def).find((s) => s.type === 'hole')
  if (!hole) throw new Error(`no hole snap on ${inst.partId}`)
  return hole.id
}

function partZ(instanceId: string): number {
  return state().parts.find((p) => p.instanceId === instanceId)!.position[2]
}

/** Insert `pinPartId` into a fresh beam at the origin; returns instance ids. */
function insertPin(pinPartId: string): { beamA: string; pinId: string } {
  state().clearProject()
  const beamA = state().addPart(BEAM_PART_ID, [0, 0, 0])!
  state().setSelectedPinPartId(pinPartId)
  state().insertPinAtSnapPoint(beamA, holeIdOf(beamA))
  const pinId = state().selectedInstanceId!
  if (pinId === beamA) throw new Error(`pin insert failed for ${pinPartId}`)
  return { beamA, pinId }
}

/** Joint Mode: attach a fresh beam's hole onto `seatId` of the pin. */
function attachBeam(pinId: string, seatId: string): string {
  const beamId = state().addPart(BEAM_PART_ID, [3, 3, 3])!
  const before = state().connections.length
  state().setMode('joint')
  state().jointPick(beamId, holeIdOf(beamId))
  state().jointPick(pinId, seatId)
  if (state().connections.length !== before + 1) {
    throw new Error(`joint onto ${seatId} did not create a mate`)
  }
  return beamId
}

// ------------------------------------------- 3. identical-seat equality
console.log('\n[3] 1x1 / 2x2 / 3x3 seat at the identical world transform')
const seatTransforms: Record<string, [number, number, number]> = {}
for (const pinPartId of [
  '1x1-connector-pin-228-2500-060',
  '2x2-connector-pin-228-2500-062',
  '3x3-connector-pin-228-2500-089',
]) {
  const { pinId } = insertPin(pinPartId)
  const inst = state().parts.find((p) => p.instanceId === pinId)!
  seatTransforms[pinPartId] = [...inst.position] as [number, number, number]
}
{
  const [ref, ...rest] = Object.entries(seatTransforms)
  for (const [id, pos] of rest) {
    check(
      `${id} seats like the 1x1`,
      pos.every((v, i) => approx(v, ref[1][i], 1e-6)),
      `${id}=[${pos}] vs 1x1=[${ref[1]}]`,
    )
  }
}

// ------------------------------------------------- 4. functional stacking
// Locked-in world Z offsets (beam A at z=0, hole axis = world Z), measured
// after the per-layer seat calibration. beamB(flange) carries the 0.010
// beam-to-beam clearance; stacked layers follow the calibrated 1x2
// convention (one layer out, slight seat pre-load — no gap).
console.log('\n[4] Stacked seats land at the locked offsets')

function runStack(
  pinPartId: string,
  expected: Array<{ seat: string; z: number }>,
  expectedPinZ?: number,
) {
  const { pinId } = insertPin(pinPartId)
  if (expectedPinZ !== undefined) {
    check(
      `${pinPartId} pin seats at z=${expectedPinZ}`,
      approx(partZ(pinId), expectedPinZ),
      `z=${partZ(pinId).toFixed(5)}`,
    )
  }
  for (const { seat, z } of expected) {
    const beamId = attachBeam(pinId, seat)
    check(
      `${pinPartId} beam@${seat} lands at z=${z}`,
      approx(partZ(beamId), z),
      `z=${partZ(beamId).toFixed(5)}`,
    )
  }
  // Every used seat must now be occupied: a second beam on the first seat
  // must be rejected without creating a mate.
  const before = state().connections.length
  const dupBeam = state().addPart(BEAM_PART_ID, [5, 5, 5])!
  state().setMode('joint')
  state().jointPick(dupBeam, holeIdOf(dupBeam))
  state().jointPick(pinId, expected[0].seat)
  check(
    `${pinPartId} occupied seat ${expected[0].seat} rejects a second beam`,
    state().connections.length === before,
  )
}

runStack(
  '2x2-connector-pin-228-2500-062',
  [
    { seat: 'pin-back', z: 0.25016 },
    { seat: 'pin-back-2', z: 0.47032 },
    { seat: 'pin-front-2', z: -0.22016 },
  ],
  0.12508,
)
runStack(
  '3x3-connector-pin-228-2500-089',
  [
    { seat: 'pin-back', z: 0.25016 },
    { seat: 'pin-back-2', z: 0.47032 },
    { seat: 'pin-back-3', z: 0.70048 },
  ],
  0.12508,
)
runStack(
  '1x2-connector-pin-228-2500-061',
  [
    { seat: 'pin-back', z: 0.25016 },
    // Visually calibrated 2026-06-28 (backLayer2FinalSeatAdjustment -0.012).
    { seat: 'pin-back-2', z: 0.47632 },
  ],
  0.25008,
)
runStack(
  '0x2-connector-pin-228-2500-086',
  [{ seat: 'pin-front-2', z: -0.23016 }],
  -0.06992,
)
runStack(
  '0x3-connector-pin-228-2500-087',
  [
    { seat: 'pin-front-2', z: -0.23016 },
    { seat: 'pin-front-3', z: -0.46032 },
  ],
  -0.17992,
)

// ------------------------------------- 5. Auto Snap overlap protection
// Two pins on one beam, a beam mated on pin1's back seat, then a beam dropped
// where the nearest candidate would land it in the SAME plane (hole faces sit
// one beam thickness apart — the same spacing as pin layer seats — so such
// candidates are always nearby). findNearestCompatibleSnap must reject the
// deep-overlap placement and pick the next candidate; intentional stacked
// pre-loads (~0.02) must still pass.
console.log('\n[5] Auto Snap rejects deep-overlap placements')
{
  const HALF = { x: 1.0, y: 0.25, z: 0.12008 } // 1x4 beam half-extents
  const spanOf = (instanceId: string) => {
    const p = state().parts.find((x) => x.instanceId === instanceId)!
    return {
      x: [p.position[0] - HALF.x, p.position[0] + HALF.x],
      y: [p.position[1] - HALF.y, p.position[1] + HALF.y],
      z: [p.position[2] - HALF.z, p.position[2] + HALF.z],
    }
  }
  const penetration = (a: string, b: string) => {
    const sa = spanOf(a)
    const sb = spanOf(b)
    const o = (u: number[], v: number[]) =>
      Math.min(u[1], v[1]) - Math.max(u[0], v[0])
    const ox = o(sa.x, sb.x)
    const oy = o(sa.y, sb.y)
    const oz = o(sa.z, sb.z)
    return ox > 0 && oy > 0 && oz > 0 ? Math.min(ox, oy, oz) : 0
  }

  state().clearProject()
  const beamA = state().addPart(BEAM_PART_ID, [0, 0, 0])!
  state().setSelectedPinPartId('2x2-connector-pin-228-2500-062')
  state().insertPinAtSnapPoint(beamA, 'hole-0')
  const pin1 = state().selectedInstanceId!
  state().insertPinAtSnapPoint(beamA, 'hole-1')
  const green = attachBeam(pin1, 'pin-back')

  const dropAndSnap = (z: number) => {
    const red = state().addPart(BEAM_PART_ID, [-1, 0, z])!
    state().setMode('select')
    state().trySnap(red)
    const mate = state().connections.find(
      (c) => c.aInstanceId === red || c.bInstanceId === red,
    )
    return { red, mate }
  }

  // The drop that used to bury the beam in green's plane (0.2402 deep).
  const bug = dropAndSnap(0.22)
  check('overlap drop still snaps somewhere', !!bug.mate)
  check(
    'overlap drop avoids deep penetration with the seated beam',
    penetration(bug.red, green) <= 0.05,
    `pen=${penetration(bug.red, green).toFixed(4)}`,
  )
  state().selectPart(bug.red)
  state().deleteSelected()

  // Intentional stacked seats must NOT be rejected by the overlap gate.
  const stack = dropAndSnap(0.3)
  check(
    'stacked drop still seats on a layer seat (pre-load passes the gate)',
    !!stack.mate &&
      (stack.mate.aSnapId.startsWith('pin-back-') ||
        stack.mate.bSnapId.startsWith('pin-back-')),
    stack.mate ? `${stack.mate.aSnapId}<->${stack.mate.bSnapId}` : 'no mate',
  )
}

// ------------------------------------------------------------------ result
state().clearProject()
if (failures > 0) {
  console.error(`\nverify:pins FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify:pins passed')
