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
 *  5. Auto Snap overlap protection: deep-overlap candidates are rejected and
 *     rerouted to the next candidate; intentional stacked pre-loads pass.
 *  6. When every in-range candidate is overlap-rejected, trySnap reports it
 *     in the status message instead of failing silently.
 *  7. Measured-hole layer invariants (fast, resolver-only): known parts keep
 *     their mhole-* counts, exact positions, inward-axis/outward-normal
 *     convention, shared front/back occupancy groups, and receiving depths;
 *     the gear keeps its curated center AND its supplemental face holes, and
 *     the center-bore clearance guard keeps axle bores out of the pin holes.
 *  8. Project loading reports outdated connections: mates whose saved snap
 *     ids no longer resolve are dropped AND counted in the load status;
 *     valid mates survive unchanged.
 *  9. BaseBot assembly fixes (2026-07-19): peg mates keep the staged roll
 *     (quarter-turn indexed); Joint Mode refuses a joint that would tear an
 *     anchored part off its other mates and records an aligned pattern joint
 *     in place; Washer/Lock-Beam/Brain metadata (bore + independent brain
 *     walls on the 0.5 pitch, Smart Cable port bands excluded).
 * 10. Joint Mode preservation hardening (2026-07-20): simulated candidate
 *     moves measure every preserved mate's CONTACT geometry against the
 *     strict 0.12 preservation tolerance (independent from the snap-distance
 *     slider); the far-face mis-pick is refused fully non-destructively;
 *     aligned patterns keep using the simulated-move workhorse while
 *     join-in-place stays a narrow fallback (forced synthetic fixture);
 *     undo/redo and save/load stay coherent through refusals and in-place
 *     joins.
 *
 * Run with: npx tsx scripts/verify-pins.ts
 */
import * as THREE from 'three'
import { useAssemblyStore } from '../src/store/assemblyStore'
import { PARTS, getPartDefinition } from '../src/data/parts'
import {
  getWorldSnapPoints,
  mateWorldGap,
  worldSnapContactPosition,
} from '../src/utils/snap'
import { matchPinProfile, PIN_PROFILES } from '../src/data/pinProfiles'
import { SNAP_CALIBRATION } from '../src/data/snapCalibration'
import { getSnapPointResolution } from '../src/data/snapOverrides'
import { parseProject, type ProjectParseInfo } from '../src/utils/projectIO'

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

// ----------------------- 6. all-rejected overlap drop reports a status
// When EVERY in-range Auto Snap candidate is overlap-rejected, trySnap must
// tell the user why instead of showing the generic no-snap state
// (NEXT-STEPS 2026-07-04 /scrutinize item 2).
console.log('\n[6] All-rejected overlap drop reports a status message')
{
  state().clearProject()
  const beamA = state().addPart(BEAM_PART_ID, [0, 0, 0])!
  state().setSelectedPinPartId('2x2-connector-pin-228-2500-062')
  state().insertPinAtSnapPoint(beamA, 'hole-0')
  const pin1 = state().selectedInstanceId!
  attachBeam(pin1, 'pin-back') // occupy the flange seat
  // Find the exact stack-seat landing transform, then swap the seated beam for
  // an UNMATED copy: the seat reads free, but any placement onto it now deeply
  // overlaps the loose beam — so every candidate gets overlap-rejected.
  const seated = attachBeam(pin1, 'pin-back-2')
  const seatedPos = [
    ...state().parts.find((p) => p.instanceId === seated)!.position,
  ] as [number, number, number]
  state().selectPart(seated)
  state().deleteSelected()
  state().addPart(BEAM_PART_ID, seatedPos)
  const red = state().addPart(BEAM_PART_ID, [
    seatedPos[0],
    seatedPos[1],
    seatedPos[2] + 0.15,
  ])!
  state().setMode('select')
  state().trySnap(red)
  const mate = state().connections.find(
    (c) => c.aInstanceId === red || c.bInstanceId === red,
  )
  check('all-overlap drop does not snap', !mate)
  check(
    'all-overlap drop reports overlap in the status',
    /overlap/i.test(state().statusMessage),
    `status="${state().statusMessage}"`,
  )
}

// ----------------------- 7. measured-hole layer resolver invariants
// Fast, resolver-only (no GLB parsing, no full hole audit). Pins the
// 2026-07-12 measured layer for representative geometry classes so a future
// change cannot silently flip an axis/normal, break front/back occupancy
// grouping, rename/remove mhole-* snaps, detach the measured layer, or move
// a measured position beyond tolerance.
console.log('\n[7] Measured-hole layer resolver invariants')
{
  const MHOLE_ID = /^mhole-\d+(-back)?$/
  const POS_DRIFT_TOL = 0.02 // regeneration jitter allowance << hole pitch
  type MeasuredExpectation = {
    partId: string
    label: string
    physicalHoles: number
    holeAxis: 0 | 1 | 2
    // One pinned front-face sample per part (drift/axis-flip tripwire).
    sample: { id: string; pos: [number, number, number]; depth: number }
  }
  const expectations: MeasuredExpectation[] = [
    {
      // Specialty beam, holes through Y. Also locks the 2026-07-12 fix that
      // removed the fabricated 8-hole "1xN in the name" row: the real part
      // has exactly 3 through-holes.
      partId: '1x8-ballista-arm-228-2500-293',
      label: 'specialty beam (Y-axis holes)',
      physicalHoles: 3,
      holeAxis: 1,
      sample: { id: 'mhole-0', pos: [-1.815, 0.12, 0.11], depth: 0.24 },
    },
    {
      // Angled structural beam, holes through Z; browser-verified 2026-07-12
      // (1x1 pin seated on mhole-0 through computeSnapTransform).
      partId: '2x2-45-degree-beam-228-2500-1486',
      label: '45-degree beam (Z-axis holes)',
      physicalHoles: 3,
      holeAxis: 2,
      sample: { id: 'mhole-0', pos: [-0.075, -0.175, 0.12], depth: 0.24 },
    },
    {
      // Flat truss panel — the largest full measured set in the checks.
      partId: '7x9x11-6-8-10-triangle-truss-plate-228-2500-1117',
      label: 'triangle truss plate',
      physicalHoles: 24,
      holeAxis: 2,
      sample: { id: 'mhole-0', pos: [-1.5, -2, 0.12], depth: 0.24 },
    },
  ]

  function mholeChecks(
    partId: string,
    label: string,
    holeAxis: 0 | 1 | 2,
  ): ReturnType<typeof getSnapPointResolution>['snapPoints'] {
    const def = getPartDefinition(partId)
    check(`${label}: part exists (${partId})`, !!def)
    if (!def) return []
    const res = getSnapPointResolution(def)
    const mholes = res.snapPoints.filter((s) => s.id.startsWith('mhole'))
    check(`${label}: resolver output includes the measured layer`, mholes.length > 0)
    check(
      `${label}: every measured snap is a well-formed hole`,
      mholes.every(
        (s) =>
          MHOLE_ID.test(s.id) &&
          s.type === 'hole' &&
          (s.compatibleWith ?? []).includes('pin') &&
          s.approximate === true &&
          s.curatedNeedsReview === true &&
          (s.receivingDepth ?? 0) > 0.05,
      ),
    )
    // Front/back pairing: every physical hole is one `mhole-N` + `mhole-N-back`
    // pair sharing one occupancy group, offset only along the hole axis, with
    // inward axis / outward normal pointing INTO / OUT OF the material.
    const fronts = mholes.filter((s) => !s.id.endsWith('-back'))
    let pairingOk = fronts.length * 2 === mholes.length
    for (const front of fronts) {
      const back = mholes.find((s) => s.id === `${front.id}-back`)
      if (!back || front.occupancyGroup !== back.occupancyGroup) {
        pairingOk = false
        break
      }
      const inPlaneAxes = [0, 1, 2].filter((k) => k !== holeAxis)
      const sameInPlane = inPlaneAxes.every((k) =>
        approx(front.position[k], back.position[k], 1e-9),
      )
      const frontOutward = front.position[holeAxis] > back.position[holeAxis]
      const axisOk =
        approx(front.axis?.[holeAxis] ?? 0, -1, 1e-9) &&
        approx(front.normal?.[holeAxis] ?? 0, 1, 1e-9) &&
        approx(back.axis?.[holeAxis] ?? 0, 1, 1e-9) &&
        approx(back.normal?.[holeAxis] ?? 0, -1, 1e-9)
      if (!sameInPlane || !frontOutward || !axisOk) {
        pairingOk = false
        break
      }
    }
    check(
      `${label}: front/back pairs share groups + inward/outward convention`,
      pairingOk,
    )
    return mholes
  }

  for (const exp of expectations) {
    const mholes = mholeChecks(exp.partId, exp.label, exp.holeAxis)
    check(
      `${exp.label}: exactly ${exp.physicalHoles} physical holes`,
      mholes.length === exp.physicalHoles * 2,
      `got ${mholes.length} snaps`,
    )
    const sample = mholes.find((s) => s.id === exp.sample.id)
    check(`${exp.label}: sample ${exp.sample.id} exists`, !!sample)
    if (sample) {
      check(
        `${exp.label}: ${exp.sample.id} position within tolerance`,
        exp.sample.pos.every((v, i) =>
          approx(sample.position[i], v, POS_DRIFT_TOL),
        ),
        `pos=[${sample.position}]`,
      )
      check(
        `${exp.label}: ${exp.sample.id} receiving depth within tolerance`,
        approx(sample.receivingDepth ?? 0, exp.sample.depth, POS_DRIFT_TOL),
        `depth=${sample.receivingDepth}`,
      )
    }
  }

  // Rotating part with a SUPPLEMENTAL measured layer: the curated gearCenter
  // must survive, the measured face holes must be appended, and the
  // center-bore clearance guard must keep the axle bore out of the pin holes.
  {
    const label = '60 Tooth Gear (supplemental layer)'
    const gearId = '60-tooth-gear-228-2500-215'
    const mholes = mholeChecks(gearId, label, 2)
    const def = getPartDefinition(gearId)!
    const res = getSnapPointResolution(def)
    check(
      `${label}: curated gearCenter snap survives the supplement`,
      res.snapPoints.some((s) => s.type === 'gearCenter'),
    )
    check(
      `${label}: 14 supplemental face holes appended`,
      mholes.length === 28,
      `got ${mholes.length} snaps`,
    )
    check(
      `${label}: no measured hole within 0.12 of the axle center bore`,
      mholes.every(
        (s) => Math.hypot(s.position[0], s.position[1]) >= 0.12,
      ),
    )
  }
}

// ----------------------- 8. project load reports outdated connections
// Old projects can reference snap ids from a previous metadata generation
// (e.g. the fabricated hole rows replaced by measured mhole-* sets). The
// loader must DROP those mates, KEEP valid ones unchanged, and REPORT how
// many were removed in the load status.
console.log('\n[8] Project load drops + reports outdated connections')
{
  const ARM_ID = '1x8-ballista-arm-228-2500-293'
  const PIN_ID = '1x1-connector-pin-228-2500-060'
  const inst = (instanceId: string, partId: string) => ({
    instanceId,
    partId,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: '#7d8794',
  })
  const conn = (id: string, aSnapId: string, bSnapId = 'pin-front') => ({
    id,
    aInstanceId: 'arm-1',
    aSnapId,
    bInstanceId: 'pin-1',
    bSnapId,
    type: 'snap',
  })
  const proj = (connections: unknown[]) => ({
    projectName: 'LoadCheck',
    version: 3,
    parts: [inst('arm-1', ARM_ID), inst('pin-1', PIN_ID)],
    connections,
  })

  // parseProject unit level: the out-param counts exactly the dropped mates.
  {
    const info: ProjectParseInfo = {}
    const parsed = parseProject(proj([conn('m1', 'mhole-0')]), info)
    check('valid-only project keeps its connection', parsed.connections.length === 1)
    check('valid-only project counts 0 removed', info.removedConnectionCount === 0)
  }
  {
    const info: ProjectParseInfo = {}
    const parsed = parseProject(
      proj([conn('m1', 'mhole-0'), conn('m2', 'hole-5'), conn('m3', 'hole-6')]),
      info,
    )
    check('mixed project keeps only the valid connection', parsed.connections.length === 1)
    check('mixed project counts 2 removed', info.removedConnectionCount === 2)
    const kept = parsed.connections[0]
    check(
      'kept connection survives unchanged',
      kept.id === 'm1' &&
        kept.aInstanceId === 'arm-1' &&
        kept.aSnapId === 'mhole-0' &&
        kept.bInstanceId === 'pin-1' &&
        kept.bSnapId === 'pin-front',
    )
  }

  // Store level: the load status message carries the removal note.
  const loadAndStatus = (connections: unknown[]) => {
    state().loadProject(proj(connections))
    return state().statusMessage
  }
  {
    const status = loadAndStatus([conn('m1', 'mhole-0')])
    check(
      'clean load status has no removal note',
      /Loaded "LoadCheck"/.test(status) && !/outdated/i.test(status),
      `status="${status}"`,
    )
    check('clean load keeps the mate in the store', state().connections.length === 1)
  }
  {
    const status = loadAndStatus([conn('m1', 'hole-5')])
    check(
      'single outdated connection is reported (singular)',
      /1 outdated connection removed/.test(status) &&
        !/connections removed/.test(status),
      `status="${status}"`,
    )
    check('outdated mate is dropped from the store', state().connections.length === 0)
  }
  {
    const status = loadAndStatus([
      conn('m1', 'hole-5'),
      conn('m2', 'hole-6'),
      conn('m3', 'mhole-0'),
      conn('m4', 'hole-7'),
    ])
    check(
      'multiple outdated connections are reported (plural)',
      /3 outdated connections removed/.test(status),
      `status="${status}"`,
    )
    check('valid mate still loads alongside outdated ones', state().connections.length === 1)
  }
}

// ---------------------------------------------- 9. BaseBot assembly fixes
// Locks the 2026-07-19 fixes from the end-to-end BaseBot build report:
// peg-mate roll follows the staged orientation (quarter-turn indexed),
// Joint Mode never tears an anchored part off its other mates (refusal +
// join-in-place), and the Brain/Washer/Lock-Beam metadata is usable.
console.log('\n[9] BaseBot assembly fixes (2026-07-19)')
{
  const CORNER = '1x-wide-1x1-corner-connector-228-2500-129'
  // Corner-connector peg mates: the staged roll must survive (quantized to
  // the nearest 90°), not be forced to one canonical up.
  const finals: THREE.Quaternion[] = []
  for (const rot of [[0, 0, 0], [0, 0, Math.PI / 2]] as const) {
    state().clearProject()
    const beam = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    const conn = state().addPart(CORNER, [2, 2, 2])!
    state().updatePartTransform(conn, [2, 2, 2], [...rot])
    state().jointPick(conn, 'peg-0')
    state().jointPick(beam, 'hole-0')
    const inst = state().parts.find((p) => p.instanceId === conn)!
    finals.push(new THREE.Quaternion().setFromEuler(new THREE.Euler(...inst.rotation)))
  }
  const stagedAngle = (finals[0].angleTo(finals[1]) * 180) / Math.PI
  check(
    'peg mate keeps the staged 90° roll (quarter-turn indexed)',
    approx(stagedAngle, 90, 1),
    `angle between stagings = ${stagedAngle.toFixed(1)}°`,
  )
  const pegSnap = getWorldSnapPoints(
    { instanceId: 'x', partId: CORNER, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#fff' },
    getPartDefinition(CORNER)!,
  ).find((s) => s.id === 'peg-0')
  check('corner peg declares rollStepDeg 90', pegSnap?.rollStepDeg === 90)
}
{
  // Joint Mode multi-pin teardown protection. Two pins 0.5 apart in beam A;
  // beam B seated onto pin1 via its underside face.
  const setup = () => {
    state().clearProject()
    state().setSelectedPinPartId('1x1-connector-pin-228-2500-060')
    const beamA = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    state().insertPinAtSnapPoint(beamA, 'hole-0')
    const pin1 = state().selectedInstanceId!
    state().insertPinAtSnapPoint(beamA, 'hole-1')
    const pin2 = state().selectedInstanceId!
    const beamB = state().addPart(BEAM_PART_ID, [3, 0, 0])!
    state().jointPick(beamB, 'hole-0-back')
    state().jointPick(pin1, 'pin-back')
    return { beamA, pin1, pin2, beamB }
  }
  const posOf = (id: string) =>
    new THREE.Vector3(...state().parts.find((p) => p.instanceId === id)!.position)
  const matesOf = (id: string) =>
    state().connections.filter((c) => c.aInstanceId === id || c.bInstanceId === id)

  {
    // Mismatched pick (impossible geometry): refuse, move nothing, prune nothing.
    const { pin1, pin2, beamB } = setup()
    const before = posOf(beamB)
    const matesBefore = state().connections.length
    state().jointPick(pin2, 'pin-back')
    state().jointPick(beamB, 'hole-3')
    check(
      'mismatched 2nd pin joint is refused with an explanation',
      /^Joint refused/.test(state().statusMessage),
      `status="${state().statusMessage}"`,
    )
    check('refused joint moves nothing', posOf(beamB).distanceTo(before) < 1e-9)
    check(
      'refused joint prunes nothing',
      state().connections.length === matesBefore &&
        matesOf(beamB).some((c) => c.aInstanceId === pin1 || c.bInstanceId === pin1),
    )
  }
  {
    // Aligned pattern joint (2nd pin of a real pattern): mate is recorded
    // without moving the anchored beam, and the first mate survives.
    const { pin2, beamB } = setup()
    const before = posOf(beamB)
    const pin2Back = getWorldSnapPoints(
      state().parts.find((p) => p.instanceId === pin2)!,
      getPartDefinition(state().parts.find((p) => p.instanceId === pin2)!.partId)!,
    ).find((s) => s.id === 'pin-back')!
    const beamBInst = state().parts.find((p) => p.instanceId === beamB)!
    const holes = getWorldSnapPoints(beamBInst, getPartDefinition(beamBInst.partId)!)
      .filter((s) => s.type === 'hole')
      .sort(
        (a, b) =>
          a.worldPosition.distanceTo(pin2Back.worldPosition) -
          b.worldPosition.distanceTo(pin2Back.worldPosition),
      )
    state().jointPick(pin2, 'pin-back')
    state().jointPick(beamB, holes[0].id)
    check(
      'aligned 2nd pin joint is created',
      /Joint created/.test(state().statusMessage),
      `status="${state().statusMessage}"`,
    )
    check(
      'aligned 2nd pin joint moves the anchored beam at most a hair',
      posOf(beamB).distanceTo(before) < 0.03,
      `moved ${posOf(beamB).distanceTo(before).toFixed(4)}`,
    )
    check('beam B now has both pin mates', matesOf(beamB).length === 2)
  }
  state().clearProject()
}
{
  // Metadata: Washer bore takes a pin OR a shaft (one occupancy group).
  const washer = PARTS.find((p) => p.id === 'washer-228-2500-112')!
  const snaps = getSnapPointResolution(washer).snapPoints
  const ids = snaps.map((s) => `${s.id}:${s.type}`).sort()
  check(
    'washer = pin-hole pair + shaft support bore',
    ids.join(',') ===
      'mhole-0-back:hole,mhole-0-shaft:shaftSupportBore,mhole-0:hole',
    ids.join(','),
  )
  check(
    'washer bore is one shared occupancy group',
    snaps.every((s) => s.occupancyGroup === 'mhole-0'),
  )
}
{
  // Metadata: 2x2 Center Offset Round Lock Beam has its center drive bore.
  const lock = PARTS.find(
    (p) => p.id === '2x2-center-offset-round-lock-beam-228-2500-1925',
  )!
  const snaps = getSnapPointResolution(lock).snapPoints
  const bore = snaps.find((s) => s.type === 'axleHole')
  check('lock beam has a square drive bore', !!bore && bore.id === 'shaft-bore')
  check(
    'lock beam bore runs along Y through the hub',
    !!bore &&
      bore.axis?.[1] === 1 &&
      approx(bore.receivingDepth ?? 0, 0.465, 1e-3) &&
      bore.position.every((v) => approx(v, 0, 1e-9)),
  )
  check(
    'lock beam keeps its 8 real measured holes',
    snaps.filter((s) => s.type === 'hole').length === 16,
    `${snaps.filter((s) => s.type === 'hole').length} hole faces`,
  )
}
{
  // Metadata: Robot Brain mount sockets are the 0.5-pitch base row, walls are
  // independent, and nothing mechanical lives in the Smart Cable port bands.
  const brain = PARTS.find((p) => p.id === '228-2540')!
  const snaps = getSnapPointResolution(brain).snapPoints
  const front = snaps.filter((s) => /^mount-\d+$/.test(s.id))
  const back = snaps.filter((s) => /-back$/.test(s.id))
  check('brain has 8 front + 8 back mount sockets', front.length === 8 && back.length === 8)
  check(
    'brain mount row is on the exact 0.5 pitch',
    front.every((s, i) => approx(s.position[0], -1.65 + i * 0.5, 1e-6)),
  )
  check(
    'brain front/back walls occupy independently',
    front.every((s) => {
      const b = snaps.find((x) => x.id === `${s.id}-back`)
      return b && s.occupancyGroup !== b.occupancyGroup
    }),
  )
  check(
    'brain mount sockets are blind (0.298 deep)',
    front.every((s) => approx(s.receivingDepth ?? 0, 0.298, 1e-6)),
  )
  check(
    'no mechanical snap inside the Smart Cable port bands',
    snaps.every(
      (s) =>
        !(s.position[1] >= 0.05 && s.position[1] <= 0.55 && Math.abs(s.position[2]) >= 0.9),
    ),
  )
  check('the old port-band hole ids are gone', !snaps.some((s) => /^hole-\d/.test(s.id)))
}

// ---------------------- 10. Joint Mode preservation hardening (2026-07-20)
// `jointPick` simulates candidate moves and measures every preserved mate's
// CONTACT geometry against the STRICT preservation tolerance
// (JOINT_EXISTING_MATE_MAX_ERROR = 0.12) — independent from the user
// snap-distance slider and the 0.35 stale-mate prune, so a mate can never
// remain stored while geometrically stretched by a joint pick. The
// non-destructive simulated move is the normal workhorse for aligned pattern
// joints; join-in-place is a narrow safety fallback for cases where both
// candidate moves are unsafe but the requested contact frames are already
// aligned; everything else is refused without touching parts, mates,
// selection, or history.
console.log('\n[10] Joint Mode preservation hardening (2026-07-20)')
{
  const jointSetup = () => {
    state().clearProject()
    state().setSelectedPinPartId('1x1-connector-pin-228-2500-060')
    const beamA = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    state().insertPinAtSnapPoint(beamA, 'hole-0')
    const pin1 = state().selectedInstanceId!
    state().insertPinAtSnapPoint(beamA, 'hole-1')
    const pin2 = state().selectedInstanceId!
    const beamB = state().addPart(BEAM_PART_ID, [3, 0, 0])!
    state().jointPick(beamB, 'hole-0-back')
    state().jointPick(pin1, 'pin-back')
    return { beamA, pin1, pin2, beamB }
  }
  const transformOf = (id: string) => {
    const p = state().parts.find((x) => x.instanceId === id)!
    return { position: [...p.position], rotation: [...p.rotation] }
  }
  const sameTransform = (
    a: ReturnType<typeof transformOf>,
    b: ReturnType<typeof transformOf>,
    tol = 1e-12,
  ) =>
    a.position.every((v, i) => Math.abs(v - b.position[i]) <= tol) &&
    a.rotation.every((v, i) => Math.abs(v - b.rotation[i]) <= tol)
  const mateBetween = (idA: string, idB: string) =>
    state().connections.find(
      (c) =>
        (c.aInstanceId === idA && c.bInstanceId === idB) ||
        (c.aInstanceId === idB && c.bInstanceId === idA),
    )
  const worldSnap = (instId: string, snapId: string) => {
    const inst = state().parts.find((p) => p.instanceId === instId)!
    return getWorldSnapPoints(inst, getPartDefinition(inst.partId)!).find(
      (s) => s.id === snapId,
    )!
  }

  {
    // Far-face mis-pick (pin2 pin-back → beamB hole-1 FAR face, one beam
    // thickness beyond the near face): refused, fully non-destructive. The
    // pre-fix behavior moved the pin 0.2502, flipped it to [π, 0, π], and
    // left the pin↔beamA mate stored but stretched to 0.2552.
    const { beamA, pin1, pin2, beamB } = jointSetup()
    const ids = [beamA, pin1, pin2, beamB]
    const beforeT = ids.map(transformOf)
    const beforeConnIds = state().connections.map((c) => c.id).sort().join(',')
    const beamAMate = mateBetween(pin2, beamA)!
    const gapBefore = mateWorldGap(beamAMate, state().parts)!
    const selBefore = state().selectedInstanceId
    const histBefore = state().historyPast.length
    state().jointPick(pin2, 'pin-back')
    state().jointPick(beamB, 'hole-1')
    check(
      'far-face pick is refused with the measured mate movement',
      /^Joint refused: this connection would move an existing mate by 0\.26\. Select the nearer face/.test(
        state().statusMessage,
      ),
      `status="${state().statusMessage}"`,
    )
    check(
      'refusal changes no transform on any part',
      ids.every((id, i) => sameTransform(transformOf(id), beforeT[i])),
    )
    check(
      'refusal keeps every mate (ids identical)',
      state().connections.map((c) => c.id).sort().join(',') === beforeConnIds,
    )
    check(
      'refusal leaves the existing mate geometry untouched',
      approx(mateWorldGap(beamAMate, state().parts)!, gapBefore, 1e-9),
      `gap=${mateWorldGap(beamAMate, state().parts)?.toFixed(4)}`,
    )
    check(
      'refusal preserves the selection',
      state().selectedInstanceId === selBefore,
    )
    check(
      'refusal adds no history entry',
      state().historyPast.length === histBefore,
    )
    check('refusal clears the pending joint source', state().jointSource === null)
    state().undo()
    check(
      'undo after refusal removes the last REAL action (the beamB seat)',
      state().connections.length === 2,
      `${state().connections.length} mates`,
    )
    state().redo()
    check(
      'redo after refusal restores the beamB seat mate',
      state().connections.length === 3 && !!mateBetween(pin1, beamB),
    )
  }

  {
    // Role reversal: the same far-face pick in the opposite order must behave
    // equivalently (refusal, zero movement, zero mate loss).
    const { pin2, beamB } = jointSetup()
    const before = [transformOf(pin2), transformOf(beamB)]
    const beforeCount = state().connections.length
    state().jointPick(beamB, 'hole-1')
    state().jointPick(pin2, 'pin-back')
    check(
      'far-face pick refused with roles reversed',
      /^Joint refused/.test(state().statusMessage),
      `status="${state().statusMessage}"`,
    )
    check(
      'reversed refusal moves nothing and prunes nothing',
      sameTransform(transformOf(pin2), before[0]) &&
        sameTransform(transformOf(beamB), before[1]) &&
        state().connections.length === beforeCount,
    )
  }

  {
    // The strict preservation tolerance is independent from the user
    // snap-distance slider: a maximally loose slider must not re-enable the
    // far-face teardown, and a tight slider must not block or silently prune
    // an aligned pattern joint the strict gate verified.
    const { pin2, beamB } = jointSetup()
    state().setSnapThreshold(5)
    state().jointPick(pin2, 'pin-back')
    state().jointPick(beamB, 'hole-1')
    check(
      'far-face refusal survives a maximally loose snap slider',
      /^Joint refused/.test(state().statusMessage),
      `status="${state().statusMessage}"`,
    )
    state().setSnapThreshold(0.02)
    state().jointPick(pin2, 'pin-back')
    state().jointPick(beamB, 'hole-1-back')
    check(
      'aligned pattern joint still lands with a tight slider',
      state().statusMessage === 'Joint created.',
      `status="${state().statusMessage}"`,
    )
    check(
      'tight slider silently prunes nothing after the aligned joint',
      state().connections.length === 4,
      `${state().connections.length} mates`,
    )
    state().setSnapThreshold(SNAP_CALIBRATION.pinSnapThreshold)
  }

  {
    // The ordinary aligned pattern joint must keep using the non-destructive
    // simulated-move path — its status is the PLAIN 'Joint created.', not the
    // join-in-place wording, and the anchored beam does not move.
    const { pin2, beamB } = jointSetup()
    const beforeB = transformOf(beamB)
    const beforeP = transformOf(pin2)
    state().jointPick(pin2, 'pin-back')
    state().jointPick(beamB, 'hole-1-back')
    check(
      'aligned pattern joint uses the simulated-move path (plain status)',
      state().statusMessage === 'Joint created.',
      `status="${state().statusMessage}"`,
    )
    check(
      'aligned pattern joint moves neither part more than a hair',
      sameTransform(transformOf(beamB), beforeB, 1e-9) &&
        sameTransform(transformOf(pin2), beforeP, 0.02),
    )
    check(
      'aligned pattern records the 4th mate',
      state().connections.length === 4,
    )
  }

  {
    // Anchored-loop bypass (found by the 2026-07-20 scrutiny pass): two parts
    // mated ONLY to each other are both "not anchored elsewhere", so the
    // mover used to be chosen with NO preservation check — a pin seated
    // pin-front↔hole-0 and re-picked pin-back→hole-2 teleported 1.0, flipped
    // to [π,0,π], and silently pruned its original mate. The strict gate now
    // applies to whichever part actually moves, not only in the
    // both-anchored branch.
    state().clearProject()
    state().setSelectedPinPartId('1x1-connector-pin-228-2500-060')
    const beam = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    state().insertPinAtSnapPoint(beam, 'hole-0')
    const pin = state().selectedInstanceId!
    const beforePin = transformOf(pin)
    const originalMate = state().connections[0]
    state().jointPick(pin, 'pin-back')
    state().jointPick(beam, 'hole-2')
    check(
      'counterpart-only pair: geometrically impossible re-pick is refused',
      /^Joint refused/.test(state().statusMessage),
      `status="${state().statusMessage}"`,
    )
    check(
      'counterpart-only refusal moves nothing',
      sameTransform(transformOf(pin), beforePin),
    )
    check(
      'counterpart-only refusal keeps the original mate intact',
      state().connections.length === 1 &&
        state().connections[0].id === originalMate.id &&
        approx(mateWorldGap(state().connections[0], state().parts)!, 0.005, 1e-3),
    )
  }

  {
    // The legitimate counterpart re-seat must still work: re-picking the SAME
    // snap point onto a different hole replaces that mate (nothing is
    // preserved), so the pin relocates as the user asked.
    state().clearProject()
    state().setSelectedPinPartId('1x1-connector-pin-228-2500-060')
    const beam = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    state().insertPinAtSnapPoint(beam, 'hole-0')
    const pin = state().selectedInstanceId!
    const beforePin = transformOf(pin)
    state().jointPick(pin, 'pin-front')
    state().jointPick(beam, 'hole-2')
    check(
      'same-snap re-seat onto another hole still succeeds',
      state().statusMessage === 'Joint created.',
      `status="${state().statusMessage}"`,
    )
    check(
      'same-snap re-seat actually relocates the pin',
      !sameTransform(transformOf(pin), beforePin, 1e-6),
    )
    check(
      'same-snap re-seat leaves exactly one (fresh) mate',
      state().connections.length === 1 &&
        mateWorldGap(state().connections[0], state().parts)! <= 0.02,
    )
  }

  {
    // Forced join-in-place: both sides anchored, BOTH candidate re-seats
    // would disturb a (deliberately pre-stretched, still stored) mate beyond
    // the strict tolerance, but the picked pair's CONTACT frames are already
    // aligned. The mate must be recorded with zero movement, zero mate loss,
    // and the dedicated status.
    const { beamA, pin1, pin2, beamB } = jointSetup()
    state().toggleJointPositionLock(beamA)
    const a = state().parts.find((p) => p.instanceId === beamA)!
    state().updatePartTransform(
      beamA,
      [a.position[0] + 0.2, a.position[1], a.position[2]],
      [...a.rotation] as [number, number, number],
    )
    state().toggleJointPositionLock(pin1)
    const p1 = state().parts.find((p) => p.instanceId === pin1)!
    state().updatePartTransform(
      pin1,
      [p1.position[0], p1.position[1], p1.position[2] + 0.2],
      [...p1.rotation] as [number, number, number],
    )
    const stretchedA = mateWorldGap(mateBetween(pin2, beamA)!, state().parts)!
    const stretchedB = mateWorldGap(mateBetween(pin1, beamB)!, state().parts)!
    check(
      'fixture: both anchor mates stretched past 0.12 but still stored',
      stretchedA > 0.12 && stretchedA < 0.35 && stretchedB > 0.12 && stretchedB < 0.35,
      `pin2↔beamA=${stretchedA.toFixed(3)} pin1↔beamB=${stretchedB.toFixed(3)}`,
    )
    const contactGap = worldSnapContactPosition(
      worldSnap(pin2, 'pin-back'),
    ).distanceTo(worldSnapContactPosition(worldSnap(beamB, 'hole-1-back')))
    check(
      'fixture: picked contact frames already aligned (≤ 0.12)',
      contactGap <= 0.12,
      `contact gap=${contactGap.toFixed(4)}`,
    )
    const ids = [beamA, pin1, pin2, beamB]
    const beforeT = ids.map(transformOf)
    const oldIds = state().connections.map((c) => c.id).sort()
    state().jointPick(pin2, 'pin-back')
    state().jointPick(beamB, 'hole-1-back')
    check(
      'join-in-place fires with the already-aligned status',
      state().statusMessage ===
        'Joint created — parts were already aligned, locked in place.',
      `status="${state().statusMessage}"`,
    )
    check(
      'join-in-place changes no transform on any part',
      ids.every((id, i) => sameTransform(transformOf(id), beforeT[i])),
    )
    check(
      'join-in-place keeps every existing mate',
      oldIds.every((id) => state().connections.some((c) => c.id === id)),
    )
    check(
      'join-in-place records exactly one new mate',
      state().connections.length === 4,
      `${state().connections.length} mates`,
    )
    const newMate = state().connections.find((c) => !oldIds.includes(c.id))!
    check(
      'the new mate joins exactly the picked pair',
      !!newMate &&
        [newMate.aInstanceId, newMate.bInstanceId].sort().join() ===
          [pin2, beamB].sort().join() &&
        [newMate.aSnapId, newMate.bSnapId].sort().join() ===
          ['pin-back', 'hole-1-back'].sort().join(),
    )
    state().undo()
    check(
      'undo removes only the in-place mate (transforms untouched)',
      state().connections.length === 3 &&
        ids.every((id, i) => sameTransform(transformOf(id), beforeT[i])),
    )
    state().redo()
    check(
      'redo restores the in-place mate',
      state().connections.length === 4,
    )
    const file = state().exportProject()
    state().loadProject(JSON.parse(JSON.stringify(file)))
    check(
      'save/load keeps the in-place join and all transforms',
      state().connections.length === 4 &&
        ids.every((id, i) => sameTransform(transformOf(id), beforeT[i])),
    )
  }
  state().clearProject()
}

// ------------------------------------------------------------------ result
state().clearProject()
if (failures > 0) {
  console.error(`\nverify:pins FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify:pins passed')
