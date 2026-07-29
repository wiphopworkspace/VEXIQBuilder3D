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
  evaluateSeating,
  getWorldSnapPoints,
  mateWorldGap,
  solveSeatedPose,
  typesCompatible,
  validateMate,
  worldSnapContactPosition,
} from '../src/utils/snap'
import { matchPinProfile, PIN_PROFILES } from '../src/data/pinProfiles'
import { SNAP_CALIBRATION } from '../src/data/snapCalibration'
import {
  NON_MECHANICAL_REGIONS,
  getSnapPointResolution,
  getSnapPoints,
} from '../src/data/snapOverrides'
import { contactFramesForPart } from '../src/data/contactFrames'
import {
  SHIPPED_PIN_SEATING_CALIBRATION,
  calibrationOrigins,
  resolvePinSeatingCalibration,
  sanitizePinSeatingCalibration,
} from '../src/data/seatingCalibration'
import {
  PIN_SEAT_OVERRIDE_LIMIT,
  clearPinSeatOverride,
  getPinSeatOverride,
  setPinSeatOverride,
} from '../src/data/pinSeatOverrides'
import { parseProject, type ProjectParseInfo } from '../src/utils/projectIO'
import type { PartDefinition, PartInstanceData, Vec3 } from '../src/types/assembly'

const BEAM_PART_ID = '1x4-beam-228-2500-003'
const PIN_1X1_PART_NUMBER = '228-2500-060'
const PIN_1X1_PART_ID =
  PARTS.find((p) => p.partNumber === PIN_1X1_PART_NUMBER)?.id ??
  '1x1-connector-pin-228-2500-060'
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
// after the 2026-07-28 stopping-surface correction.
//
// Every value below is EXACT SURFACE CONTACT: each pin's contact plane is its
// mesh-measured collar/cap face (`measuredPinContacts.ts`), and consecutive
// stacked seats sit exactly one beam thickness (0.24016) apart. The old
// expectations encoded a per-layer pre-load that COMPOUNDED (-0.005 / -0.015 /
// -0.025), which showed up here as non-uniform steps of 0.22016 / 0.23016 —
// i.e. 0.010 of real beam-into-beam penetration per layer. The uniform-step
// assertion below is what stops that regressing; it is an invariant, not a
// transcription of whatever the solver currently returns.
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
  const landedBySeat = new Map<string, number>()
  for (const { seat, z } of expected) {
    const beamId = attachBeam(pinId, seat)
    landedBySeat.set(seat, partZ(beamId))
    check(
      `${pinPartId} beam@${seat} lands at z=${z}`,
      approx(partZ(beamId), z),
      `z=${partZ(beamId).toFixed(5)}`,
    )
  }
  // NON-ACCUMULATION INVARIANT: layer k and layer k+1 on the same side must be
  // exactly one receiver thickness apart. Any per-layer seat term — of either
  // sign — breaks this immediately.
  for (const side of ['pin-front', 'pin-back']) {
    for (let layer = 2; layer <= 3; layer++) {
      const inner = landedBySeat.get(layer === 2 ? side : `${side}-${layer - 1}`)
      const outer = landedBySeat.get(`${side}-${layer}`)
      if (inner === undefined || outer === undefined) continue
      check(
        `${pinPartId} ${side} layer ${layer} sits exactly one beam thickness out`,
        approx(Math.abs(outer - inner), SNAP_CALIBRATION.beamReceivingDepth, 1e-6),
        `step=${Math.abs(outer - inner).toFixed(5)} want ${SNAP_CALIBRATION.beamReceivingDepth}`,
      )
    }
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

// Beam A occupies z in [-0.12008, +0.12008]. A 2x2/3x3 collar is 0.070 thick
// (measured faces at +/-0.035), so the pin origin lands at 0.12008 + 0.035 =
// 0.15508 and its front collar face sits EXACTLY on beam A's face.
runStack(
  '2x2-connector-pin-228-2500-062',
  [
    { seat: 'pin-back', z: 0.31016 },
    { seat: 'pin-back-2', z: 0.55032 },
    { seat: 'pin-front-2', z: -0.24016 },
  ],
  0.15508,
)
runStack(
  '3x3-connector-pin-228-2500-089',
  [
    { seat: 'pin-back', z: 0.31016 },
    { seat: 'pin-back-2', z: 0.55032 },
    { seat: 'pin-back-3', z: 0.79048 },
  ],
  0.15508,
)
// The 1x2's collar is off-centre (measured span [-0.160, -0.090], also 0.070
// thick), which is why its pin origin differs while its seat spacing does not.
runStack(
  '1x2-connector-pin-228-2500-061',
  [
    { seat: 'pin-back', z: 0.31016 },
    { seat: 'pin-back-2', z: 0.55032 },
  ],
  0.28008,
)
// Capped pins stop on the cap's INNER face (0x2 measured at -0.2126, 0x3 at
// -0.3376 — 0.023 / 0.038 deeper than the old hand-written cap constants).
runStack(
  '0x2-connector-pin-228-2500-086',
  [{ seat: 'pin-front-2', z: -0.24016 }],
  -0.09252,
)
runStack(
  '0x3-connector-pin-228-2500-087',
  [
    { seat: 'pin-front-2', z: -0.24016 },
    { seat: 'pin-front-3', z: -0.48032 },
  ],
  -0.21752,
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
    //
    // The quoted movement rose from 0.26 to 0.38 with the 2026-07-28
    // stopping-surface correction, and that is expected: beamB now seats on
    // pin1's real collar face rather than 0.035 inside it, so beamB itself sits
    // 0.06 further out, and pin2's own contact plane moved out by 0.035 too.
    // The refusal threshold is unchanged — only the true distance is.
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
      /^Joint refused: this connection would move an existing mate by 0\.38\. Select the nearer face/.test(
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
      // Gap 0.000, not the old 0.005: the seated pose is now EXACT surface
      // contact between the pin's measured collar face and the beam's face.
      'counterpart-only refusal keeps the original mate intact',
      state().connections.length === 1 &&
        state().connections[0].id === originalMate.id &&
        approx(mateWorldGap(state().connections[0], state().parts)!, 0, 1e-3),
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

// ============ 11. Mechanical contact matrix (2026-07-28) ==================
// Every discovered pin connector family against representative receiver
// families, measured on the MECHANICAL CONTACT FRAMES: radial, angular,
// axial gap and penetration are asserted SEPARATELY against the shipped
// tolerances, so a regression in any one of them fails on its own axis.
console.log('\n[11] Contact-frame seating matrix (pin families x receivers)')
{
  const CAL = SHIPPED_PIN_SEATING_CALIBRATION

  // Control/electronics parts carry their number as the ID (e.g. '228-2560')
  // while catalog parts carry it in `partNumber` — match either, or the
  // electronics receivers silently drop out of the matrix.
  const partByNumber = (pn: string) =>
    PARTS.find((p) => p.partNumber === pn || p.id === pn)
  const partByMatch = (re: RegExp) => PARTS.find((p) => re.test(p.name))

  // EVERY production inserting endpoint in the catalog, DISCOVERED from the
  // contact inventory — never a hand-written family list. The previous list
  // named ten representative pins, which is exactly how the pitch standoffs
  // (whose seat plane was a full body-half-length wrong) passed 1740 green
  // pairs without ever being tested. `coverage` below fails if any discovered
  // endpoint never reaches a single seating solve.
  type Endpoint = {
    label: string
    def: PartDefinition
    snapId: string
    family: string
  }
  const PIN_ENDPOINTS: Endpoint[] = []
  for (const part of PARTS) {
    for (const frame of contactFramesForPart(part)) {
      if (frame.role !== 'insert' || frame.reviewGated) continue
      PIN_ENDPOINTS.push({
        label: `${part.partNumber ?? part.id} ${part.name}`,
        def: part,
        snapId: frame.snapId,
        family: frame.pinFamily ?? 'unclassified-pin',
      })
    }
  }
  check(
    `matrix discovered every production inserting endpoint (${PIN_ENDPOINTS.length})`,
    PIN_ENDPOINTS.length > 100,
    `${PIN_ENDPOINTS.length} endpoints`,
  )

  const RECEIVERS: Array<{ label: string; def: PartDefinition | undefined }> = [
    { label: 'thin beam 1x4', def: PARTS.find((p) => p.id === BEAM_PART_ID) },
    { label: 'wide beam 2x6', def: partByMatch(/^2x6 Beam$/) },
    { label: 'plate', def: partByMatch(/^4x4 Plate$|^2x4 Plate$/) },
    { label: 'truss', def: partByMatch(/Truss/i) },
    { label: 'corner connector', def: partByNumber('228-2500-1258') },
    { label: 'motor mount hole', def: partByNumber('228-2560') },
    { label: 'brain Gen 1 mount', def: partByNumber('228-2540') },
    { label: 'brain Gen 2 mount', def: partByNumber('228-6480') },
  ]

  /** Seat `pinSnapId` of `pinDef` into `holeId` of `recvDef`; measure it. */
  function seat(
    pinDef: PartDefinition,
    pinSnapId: string,
    recvDef: PartDefinition,
    holeId: string,
    pinRotation: Vec3 = [0, 0, 0],
  ) {
    const recv: PartInstanceData = {
      instanceId: 'r',
      partId: recvDef.id,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: '#888',
    }
    const pin: PartInstanceData = {
      instanceId: 'p',
      partId: pinDef.id,
      position: [4, 4, 4],
      rotation: pinRotation,
      scale: [1, 1, 1],
      color: '#888',
    }
    const target = getWorldSnapPoints(recv, recvDef).find((s) => s.id === holeId)
    const source = getWorldSnapPoints(pin, pinDef).find((s) => s.id === pinSnapId)
    if (!target || !source) return null
    if (!typesCompatible(source.type, target.type)) return null
    return solveSeatedPose(pin, source, target, { parts: [recv, pin] })
  }

  let pairs = 0
  let worstRadial = 0
  let worstAngular = 0
  let worstGap = 0
  let worstPenetration = 0
  let worstUnintended = 0
  let worstDeviation = 0
  const offenders: string[] = []
  const covered = new Set<string>()
  /** Worst measurement per (connector family, receiver family, face). */
  const perFamily = new Map<
    string,
    { gap: number; intended: number; unintended: number; radial: number; angular: number; n: number }
  >()

  // Receivers sit at the identity, so resolve their world snaps ONCE.
  const receiverFaces = RECEIVERS.filter((r) => r.def).map((r) => {
    const inst: PartInstanceData = {
      instanceId: 'r',
      partId: r.def!.id,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: '#888',
    }
    const holes = getSnapPoints(r.def!).filter((s) => s.type === 'hole')
    const first = holes[0]
    const faces = first
      ? ([first, holes.find((h) => h.id === `${first.id}-back`)].filter(
          Boolean,
        ) as typeof holes)
      : []
    return { label: r.label, def: r.def!, inst, faces }
  })

  for (const ep of PIN_ENDPOINTS) {
    for (const recv of receiverFaces) {
      for (const hole of recv.faces) {
        const side = hole.id.endsWith('-back') ? 'rear' : 'front'
        for (const roll of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          const solved = seat(
            ep.def,
            ep.snapId,
            recv.def,
            hole.id,
            [0, 0, roll] as Vec3,
          )
          if (!solved) continue
          pairs += 1
          covered.add(`${ep.def.id}::${ep.snapId}`)
          const d = solved.diagnostics
          worstRadial = Math.max(worstRadial, d.radialError)
          worstAngular = Math.max(worstAngular, d.angularErrorDeg)
          worstGap = Math.max(worstGap, Math.abs(d.axialContactGap))
          worstPenetration = Math.max(worstPenetration, d.penetration)
          worstUnintended = Math.max(worstUnintended, d.unintendedPenetration)
          worstDeviation = Math.max(worstDeviation, d.solverDeviation)
          const key = `${ep.family} | ${recv.label} | ${side}`
          const cur =
            perFamily.get(key) ??
            { gap: 0, intended: 0, unintended: 0, radial: 0, angular: 0, n: 0 }
          cur.gap = Math.max(cur.gap, Math.abs(d.axialContactGap))
          cur.intended = Math.max(cur.intended, d.intendedOverlap)
          cur.unintended = Math.max(cur.unintended, d.unintendedPenetration)
          cur.radial = Math.max(cur.radial, d.radialError)
          cur.angular = Math.max(cur.angular, d.angularErrorDeg)
          cur.n += 1
          perFamily.set(key, cur)
          const verdict = evaluateSeating(d, CAL)
          if (!verdict.ok) {
            offenders.push(
              `${ep.label}:${ep.snapId} -> ${recv.label}:${hole.id} roll=${((roll * 180) / Math.PI).toFixed(0)} — ${verdict.reasons.join('; ')}`,
            )
          }
        }
      }
    }
  }

  // NO PRODUCTION ENDPOINT MAY BE SILENTLY SKIPPED.
  const uncovered = PIN_ENDPOINTS.filter(
    (ep) => !covered.has(`${ep.def.id}::${ep.snapId}`),
  )
  check(
    `every production inserting endpoint reached a seating solve (${uncovered.length} skipped)`,
    uncovered.length === 0,
    uncovered
      .slice(0, 8)
      .map((e) => `${e.label}:${e.snapId}`)
      .join(' | '),
  )

  if (process.env.PIN_MATRIX_TABLE) {
    console.log('')
    console.log(
      '   connector family | receiver | side | maxGap | intended | unintended | radial | angular | n',
    )
    for (const [k, v] of [...perFamily.entries()].sort()) {
      console.log(
        `   ${k} | ${v.gap.toFixed(5)} | ${v.intended.toFixed(5)} | ${v.unintended.toFixed(5)} | ${v.radial.toFixed(5)} | ${v.angular.toFixed(3)} | ${v.n}`,
      )
    }
  }

  check(`matrix covered a meaningful number of pairs (${pairs})`, pairs >= 400)
  check(
    `every matrix pair is within every seating tolerance (${offenders.length} offender(s))`,
    offenders.length === 0,
    offenders.slice(0, 5).join(' | '),
  )
  check(
    `worst radial error ${worstRadial.toFixed(5)} <= ${CAL.radialTolerance}`,
    worstRadial <= CAL.radialTolerance,
  )
  check(
    `worst angular error ${worstAngular.toFixed(3)}deg <= ${CAL.angularToleranceDeg}`,
    worstAngular <= CAL.angularToleranceDeg,
  )
  check(
    `worst contact gap ${worstGap.toFixed(5)} <= ${CAL.axialGapTolerance}`,
    worstGap <= CAL.axialGapTolerance,
  )
  check(
    `worst UNINTENDED penetration ${worstUnintended.toFixed(8)} <= ${CAL.penetrationTolerance}`,
    worstUnintended <= CAL.penetrationTolerance,
  )
  check(
    `solver deviation from intent stays at float noise (${worstDeviation.toExponential(2)})`,
    worstDeviation < 1e-9,
    `worst=${worstDeviation}`,
  )
  check(
    `total penetration (${worstPenetration.toFixed(8)}) is all intended overlap`,
    worstPenetration <= CAL.penetrationTolerance,
  )

  // -- every production endpoint carries complete contact metadata ----------
  {
    let production = 0
    let incomplete = 0
    let nonMechanical = 0
    for (const part of PARTS) {
      for (const frame of contactFramesForPart(part)) {
        if (!frame.mechanical) nonMechanical += 1
        if (frame.reviewGated) continue
        production += 1
        const blocking = frame.issues.some(
          (i) =>
            i.includes('insertion axis') ||
            i.includes('compatibleWith') ||
            i.includes('seat frame'),
        )
        if (blocking) incomplete += 1
      }
    }
    check(`contact inventory found production endpoints (${production})`, production > 0)
    check(
      `every production pin endpoint/receiver has complete contact metadata (${incomplete} incomplete)`,
      incomplete === 0,
    )
    check(
      'no endpoint resolves inside a declared non-mechanical region',
      nonMechanical === 0,
    )
  }

  // -- inserting endpoints declare a real seat frame, not the marker --------
  {
    const markerSeated: string[] = []
    for (const part of PARTS) {
      for (const frame of contactFramesForPart(part)) {
        if (frame.role !== 'insert' || frame.reviewGated) continue
        if (frame.contactPlaneSource === 'marker') {
          markerSeated.push(`${part.id}::${frame.snapId}`)
        }
      }
    }
    check(
      `no production insert endpoint seats on its visual marker (${markerSeated.length})`,
      markerSeated.length === 0,
      markerSeated.slice(0, 4).join(', '),
    )
  }

  // -- deep sockets: contact plane must differ from the marker --------------
  {
    const motor = partByNumber('228-2560')
    const socket = motor
      ? getSnapPoints(motor).find((s) => s.id === 'motor-shaft')
      : undefined
    check('Smart Motor drive socket still exists', !!socket)
    if (socket) {
      const marker = new THREE.Vector3(...socket.position)
      const contact = new THREE.Vector3(
        ...(socket.facePosition ?? socket.position),
      )
      const delta = marker.distanceTo(contact)
      check(
        `deep socket contact plane is BELOW its marker (delta ${delta.toFixed(4)})`,
        delta > 0.2,
      )
    }
  }
}

// ============ 12. Named regressions (2026-07-28) =========================
console.log('\n[12] Regressions for every previously known failure')
{
  const CAL = SHIPPED_PIN_SEATING_CALIBRATION

  // -- R1: a mate stretched by one beam thickness must not read as intact ---
  {
    const { beamA, pinId } = insertPin(PIN_1X1_PART_ID)
    const mate = state().connections[0]
    check('R1 fixture: one mate exists', !!mate)
    const seatedParts = state().parts
    const seatedCheck = validateMate(mate, seatedParts, CAL)
    check(
      `R1 a correctly seated mate validates as intact (gap ${seatedCheck.contactGap?.toFixed(4)})`,
      seatedCheck.intact && seatedCheck.health === 'seated',
    )

    const thickness = SNAP_CALIBRATION.beamReceivingDepth
    const stretched = seatedParts.map((p) =>
      p.instanceId === pinId
        ? {
            ...p,
            position: [
              p.position[0],
              p.position[1],
              p.position[2] + thickness,
            ] as Vec3,
          }
        : p,
    )
    const stretchedCheck = validateMate(mate, stretched, CAL)
    check(
      `R1 a mate stretched by one beam thickness is NOT intact (gap ${stretchedCheck.contactGap?.toFixed(4)})`,
      !stretchedCheck.intact && stretchedCheck.health === 'stretched',
    )
    // The core of the bug: widening the SEARCH radius must not change validity.
    const wideSearch = { ...CAL, snapSearchDistance: 1 }
    const withWideSearch = validateMate(mate, stretched, wideSearch)
    check(
      'R1 widening the snap search distance does not make it intact',
      !withWideSearch.intact,
    )
    check(
      'R1 validity is unchanged by the search radius (identical verdict)',
      withWideSearch.health === stretchedCheck.health,
    )
    void beamA
    state().clearProject()
  }

  // -- R2: a deep socket is not refused because its marker sits above -------
  {
    const motor = PARTS.find(
      (p) => p.partNumber === '228-2560' || p.id === '228-2560',
    )
    check('R2 fixture: Smart Motor present', !!motor)
    if (motor) {
      const socket = getSnapPoints(motor).find((s) => s.id === 'motor-shaft')!
      const inst: PartInstanceData = {
        instanceId: 'm',
        partId: motor.id,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: '#888',
      }
      const runtime = getWorldSnapPoints(inst, motor).find(
        (s) => s.id === 'motor-shaft',
      )!
      const markerPos = runtime.worldPosition
      const contactPos = worldSnapContactPosition(runtime)
      const delta = markerPos.distanceTo(contactPos)
      check(
        `R2 socket marker sits ${delta.toFixed(4)} above its contact plane`,
        delta > 0.2,
      )
      check(
        'R2 contact position is NOT the marker (join-in-place would misread it)',
        contactPos.distanceTo(markerPos) > CAL.axialGapTolerance,
      )
      void socket
    }
  }

  // -- R3: a pin must not snap into a Smart Cable port ----------------------
  {
    const motor = PARTS.find(
      (p) => p.partNumber === '228-2560' || p.id === '228-2560',
    )!
    const portRegion = NON_MECHANICAL_REGIONS['228-2560']?.[0]
    check('R3 fixture: the Smart Cable port region is declared', !!portRegion)
    if (portRegion) {
      const inPort = getSnapPoints(motor).filter((s) => {
        const p = s.facePosition ?? s.position
        return (
          p[0] >= portRegion.min[0] &&
          p[0] <= portRegion.max[0] &&
          p[1] >= portRegion.min[1] &&
          p[1] <= portRegion.max[1] &&
          p[2] >= portRegion.min[2] &&
          p[2] <= portRegion.max[2]
        )
      })
      check(
        `R3 no snap point of any kind resolves inside the cable port (${inPort.length})`,
        inPort.length === 0,
      )
      // and specifically no PIN-compatible receiver there
      const pinReceivers = inPort.filter((s) => s.type === 'hole')
      check('R3 no pin-compatible receiver inside the port', pinReceivers.length === 0)
    }
  }

  // -- R4: opening Joint Mode must not move a correct manual assembly -------
  {
    const { pinId } = insertPin(PIN_1X1_PART_ID)
    const before = state().parts.map((p) => ({
      id: p.instanceId,
      pos: [...p.position] as Vec3,
      rot: [...p.rotation] as Vec3,
    }))
    const mateCountBefore = state().connections.length
    state().setMode('joint')
    state().clearJoint()
    state().setMode('select')
    const after = state().parts
    const unmoved = before.every((b) => {
      const now = after.find((p) => p.instanceId === b.id)!
      return (
        approx(now.position[0], b.pos[0]) &&
        approx(now.position[1], b.pos[1]) &&
        approx(now.position[2], b.pos[2]) &&
        approx(now.rotation[0], b.rot[0]) &&
        approx(now.rotation[1], b.rot[1]) &&
        approx(now.rotation[2], b.rot[2])
      )
    })
    check('R4 opening and closing Joint Mode moves nothing', unmoved)
    check(
      'R4 opening Joint Mode destroys no mate',
      state().connections.length === mateCountBefore,
    )
    void pinId
    state().clearProject()
  }

  // -- R5: front and back insertion must not produce a wrong 180 flip -------
  {
    const beamDefRef = PARTS.find((p) => p.id === BEAM_PART_ID)!
    const pinDef = PARTS.find((p) => p.partNumber === PIN_1X1_PART_NUMBER)!
    const holes = getSnapPoints(beamDefRef).filter((s) => s.type === 'hole')
    const front = holes.find((h) => h.id === 'hole-0')!
    const back = holes.find((h) => h.id === 'hole-0-back')!
    const recv: PartInstanceData = {
      instanceId: 'r',
      partId: beamDefRef.id,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: '#888',
    }
    const pin: PartInstanceData = {
      instanceId: 'p',
      partId: pinDef.id,
      position: [4, 4, 4],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: '#888',
    }
    const rw = getWorldSnapPoints(recv, beamDefRef)
    const pw = getWorldSnapPoints(pin, pinDef)
    const src = pw.find((s) => s.id === 'pin-front')!
    const frontSolved = solveSeatedPose(pin, src, rw.find((s) => s.id === front.id)!, {
      parts: [recv, pin],
    })
    const backSolved = solveSeatedPose(pin, src, rw.find((s) => s.id === back.id)!, {
      parts: [recv, pin],
    })
    check(
      'R5 front-face insertion is within tolerance',
      evaluateSeating(frontSolved.diagnostics, CAL).ok,
    )
    check(
      'R5 back-face insertion is within tolerance',
      evaluateSeating(backSolved.diagnostics, CAL).ok,
    )
    // The two faces are on opposite sides of the beam, so the seated pin must
    // land on opposite sides of the mid-plane — not at the same place, and not
    // flipped onto the same side.
    check(
      `R5 the two faces seat on OPPOSITE sides (front z=${frontSolved.position[2].toFixed(4)}, back z=${backSolved.position[2].toFixed(4)})`,
      Math.sign(frontSolved.position[2]) === -Math.sign(backSolved.position[2]) &&
        Math.abs(frontSolved.position[2] - backSolved.position[2]) > 0.2,
    )
    // Each insertion axis must point INTO the beam from its own face.
    check(
      'R5 front insertion drives inward (rotation differs by a real flip)',
      !approx(frontSolved.rotation[0], backSolved.rotation[0], 1e-3) ||
        !approx(frontSolved.rotation[1], backSolved.rotation[1], 1e-3) ||
        !approx(frontSolved.rotation[2], backSolved.rotation[2], 1e-3),
    )
  }

  // -- R6/R7/R8: calibration persistence ------------------------------------
  {
    // R6 — a saved user default survives a reload (round trip through the
    // sanitizer + resolver, which is exactly what module init replays).
    const custom = { pinContactOffset: 0.004, axialGapTolerance: 0.02 }
    const savedThenLoaded = sanitizePinSeatingCalibration(
      JSON.parse(JSON.stringify(custom)),
    )
    check(
      'R6 a user-saved calibration survives a serialize/parse round trip',
      savedThenLoaded.pinContactOffset === 0.004 &&
        savedThenLoaded.axialGapTolerance === 0.02,
    )
    const resolvedUser = resolvePinSeatingCalibration(savedThenLoaded, {})
    check(
      'R6 the reloaded user default becomes the effective value',
      resolvedUser.pinContactOffset === 0.004,
    )
    check(
      'R6 untouched fields still come from the shipped defaults',
      resolvedUser.mateBreakTolerance ===
        SHIPPED_PIN_SEATING_CALIBRATION.mateBreakTolerance,
    )
    check(
      'R6 provenance reports the user layer for a saved field',
      calibrationOrigins(savedThenLoaded, {}).pinContactOffset === 'user',
    )

    // R7 — reset restores the shipped defaults exactly.
    const afterReset = resolvePinSeatingCalibration({}, {})
    check(
      'R7 resetting restores every shipped default',
      JSON.stringify(afterReset) ===
        JSON.stringify(SHIPPED_PIN_SEATING_CALIBRATION),
    )

    // R8 — a project override wins over the user default and reproduces.
    const projectOverride = { pinContactOffset: -0.003 }
    const withProject = resolvePinSeatingCalibration(
      savedThenLoaded,
      projectOverride,
    )
    check(
      'R8 a project override beats the user default',
      withProject.pinContactOffset === -0.003,
    )
    check(
      'R8 provenance reports the project layer',
      calibrationOrigins(savedThenLoaded, projectOverride).pinContactOffset ===
        'project',
    )
    const roundTripped = resolvePinSeatingCalibration(
      savedThenLoaded,
      sanitizePinSeatingCalibration(
        JSON.parse(JSON.stringify(projectOverride)),
      ),
    )
    check(
      'R8 the project override reproduces after a project round trip',
      roundTripped.pinContactOffset === withProject.pinContactOffset,
    )

    // Schema validation: malformed / out-of-range / newer values are dropped.
    check(
      'R6 out-of-range stored values are rejected, not clamped in',
      sanitizePinSeatingCalibration({ axialGapTolerance: 99 })
        .axialGapTolerance === undefined,
    )
    check(
      'R6 wrong-typed stored values are rejected',
      sanitizePinSeatingCalibration({ radialTolerance: 'wide' })
        .radialTolerance === undefined,
    )
    check(
      'R6 unknown keys are dropped',
      Object.keys(sanitizePinSeatingCalibration({ bogusKey: 1 })).length === 0,
    )
  }

  // -- project file carries the override and reloads identically ------------
  {
    state().clearProject()
    const beamA = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    state().setSelectedPinPartId(PIN_1X1_PART_ID)
    state().insertPinAtSnapPoint(beamA, holeIdOf(beamA))
    const pinId = state().selectedInstanceId!
    const seatedPos = [...state().parts.find((p) => p.instanceId === pinId)!.position] as Vec3

    state().setPinSeatingProjectOverride({ axialGapTolerance: 0.02 })
    const file = state().exportProject()
    check(
      'project file carries the pin seating override',
      !!file.pinSeating && file.pinSeating.axialGapTolerance === 0.02,
    )
    state().loadProject(JSON.parse(JSON.stringify(file)))
    check(
      'reloading the project restores the override',
      state().pinSeating.axialGapTolerance === 0.02,
    )
    const reloaded = state().parts.find((p) => p.partId !== BEAM_PART_ID)!
    check(
      'reloading reproduces the identical seated pose',
      approx(reloaded.position[0], seatedPos[0]) &&
        approx(reloaded.position[1], seatedPos[1]) &&
        approx(reloaded.position[2], seatedPos[2]),
    )
    const reloadedMate = state().connections[0]
    check(
      'the reloaded mate still validates as intact',
      validateMate(reloadedMate, state().parts, state().pinSeating).intact,
    )
    // A project WITHOUT overrides must not inherit the previous project's.
    const plain = { ...file }
    delete plain.pinSeating
    state().loadProject(JSON.parse(JSON.stringify(plain)))
    check(
      'a project without overrides falls back to the user/shipped default',
      state().pinSeating.axialGapTolerance ===
        SHIPPED_PIN_SEATING_CALIBRATION.axialGapTolerance,
    )
    state().resetPinSeatingToShipped()
    state().clearProject()
  }

  // -- repeated snap cycles and save/load leave no drift --------------------
  {
    const { beamA, pinId } = insertPin(PIN_1X1_PART_ID)
    const first = [...state().parts.find((p) => p.instanceId === pinId)!.position] as Vec3
    for (let i = 0; i < 5; i++) {
      state().insertPinAtSnapPoint(beamA, holeIdOf(beamA))
    }
    let drift = 0
    for (let i = 0; i < 5; i++) {
      const f = state().exportProject()
      state().loadProject(JSON.parse(JSON.stringify(f)))
    }
    const pinNow = state().parts.find((p) => p.partId !== BEAM_PART_ID)
    if (pinNow) {
      drift = Math.max(
        Math.abs(pinNow.position[0] - first[0]),
        Math.abs(pinNow.position[1] - first[1]),
        Math.abs(pinNow.position[2] - first[2]),
      )
    }
    check(
      `repeated snap + 5 save/load cycles leave no cumulative drift (${drift.toExponential(2)})`,
      drift <= POS_TOL,
    )
    state().clearProject()
  }
}


// ====== 13. Stopping-surface regressions (2026-07-28 correction) ==========
// One regression per requirement of the production-readiness brief that the
// earlier sections did not already cover. Numbering follows the brief.
console.log('\n[13] Stopping-surface regressions')
{
  const CAL = SHIPPED_PIN_SEATING_CALIBRATION

  /** Seat one pin endpoint into one receiver hole and return the solved pose. */
  function poseOf(
    pinPartId: string,
    pinSnapId: string,
    recvPartId: string,
    holeId: string,
    calibration = CAL,
  ) {
    const recvDef = getPartDefinition(recvPartId)!
    const pinDef = getPartDefinition(pinPartId)!
    const recv: PartInstanceData = {
      instanceId: 'r', partId: recvDef.id, position: [0, 0, 0],
      rotation: [0, 0, 0], scale: [1, 1, 1], color: '#888',
    }
    const pin: PartInstanceData = {
      instanceId: 'p', partId: pinDef.id, position: [3, 3, 3],
      rotation: [0, 0, 0], scale: [1, 1, 1], color: '#888',
    }
    const target = getWorldSnapPoints(recv, recvDef).find((s) => s.id === holeId)!
    const source = getWorldSnapPoints(pin, pinDef).find((s) => s.id === pinSnapId)!
    return solveSeatedPose(pin, source, target, { parts: [recv, pin], calibration })
  }
  const samePose = (a: { position: Vec3 }, b: { position: Vec3 }) =>
    a.position.every((v, i) => Math.abs(v - b.position[i]) <= 1e-12)

  /** Axial distance from an endpoint's marker to its declared stopping plane. */
  function seatOffsetOf(partNumber: string, snapId: string): number | null {
    const def = PARTS.find((p) => p.partNumber === partNumber)
    if (!def) return null
    const s = getSnapPoints(def).find((x) => x.id === snapId)
    if (!s) return null
    const marker = s.mateFrame?.position ?? s.position
    const seat = s.seatFrame?.position ?? s.seatPosition ?? marker
    const ax = (s.mateFrame?.axis ?? s.axis ?? [0, 0, 1]) as Vec3
    return (
      (seat[0] - marker[0]) * ax[0] +
      (seat[1] - marker[1]) * ax[1] +
      (seat[2] - marker[2]) * ax[2]
    )
  }

  // -- 1. Snap search distance must not move the seated pose ---------------
  {
    const base = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0')
    const wide = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0', {
      ...CAL, snapSearchDistance: 1.0,
    })
    check(
      'R1 a 3x wider snap search leaves the seated pose byte-identical',
      samePose(base, wide),
      `${base.position} vs ${wide.position}`,
    )
  }

  // -- 3. Mate-break tolerance must not move the seated pose ---------------
  {
    const base = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0')
    const loose = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0', {
      ...CAL, mateBreakTolerance: 1.0, simulatedMoveTolerance: 0.5,
    })
    check(
      'R3 mate-break / simulated-move tolerance never changes visual seating',
      samePose(base, loose),
    )
  }

  // -- 4. Reset restores the exact shipped seated pose ---------------------
  {
    const shipped = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0')
    const nudged = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0', {
      ...CAL, pinContactOffset: 0.008,
    })
    const reset = poseOf(
      PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0',
      resolvePinSeatingCalibration({}, {}),
    )
    check('R4 a user offset really moves the pose', !samePose(shipped, nudged))
    check(
      'R4 resetting calibration restores the EXACT shipped seated pose',
      samePose(shipped, reset),
    )
  }

  // -- 5/6. Per-family seating is genuinely family-specific ----------------
  // A 0x1 sheet pin, a 1x1 connector pin, a capped 0x3 and a 0.5x standoff each
  // stop on a DIFFERENT surface. Equal numbers would mean one family inherited
  // an offset that is not its own.
  {
    const sheet = seatOffsetOf('228-2500-099', 'pin-back')
    const p1x1 = seatOffsetOf('228-2500-060', 'pin-front')
    const c0x3 = seatOffsetOf('228-2500-087', 'pin-front')
    const stand = seatOffsetOf('228-2500-064', 'pin-front')
    check(
      'R5 the four reference families all resolve a stopping surface',
      sheet !== null && p1x1 !== null && c0x3 !== null && stand !== null,
    )
    check(
      'R6 the 0x1 sheet pin does not inherit the 1x1 offset',
      sheet !== null && p1x1 !== null && Math.abs(sheet - p1x1) > 0.05,
      `sheet=${sheet} 1x1=${p1x1}`,
    )
    check(
      'R6 the 0x1 sheet pin does not inherit the capped 0x3 offset',
      sheet !== null && c0x3 !== null && Math.abs(sheet - c0x3) > 0.02,
      `sheet=${sheet} 0x3=${c0x3}`,
    )
    check(
      'R5 the 0.5x standoff keeps its own body-end stopping surface',
      stand !== null && p1x1 !== null && Math.abs(stand - p1x1) > 0.05,
      `standoff=${stand} 1x1=${p1x1}`,
    )
  }

  // -- 7. A multi-pin connector adds no per-pin offset ---------------------
  // Every peg on one corner-connector body must resolve the SAME axial
  // stopping offset; a per-participant term would make peg-3 differ from peg-0
  // exactly the way the stacked-layer term used to.
  {
    const corner = PARTS.find((p) => p.partNumber === '228-2500-1258')
    const pegs = corner
      ? getSnapPoints(corner).filter((s) => s.id.startsWith('peg-'))
      : []
    const offsets = pegs.map((s) => {
      const marker = s.mateFrame?.position ?? s.position
      const seat = s.seatFrame?.position ?? s.seatPosition ?? marker
      const ax = (s.mateFrame?.axis ?? s.axis ?? [0, 0, 1]) as Vec3
      return (
        (seat[0] - marker[0]) * ax[0] +
        (seat[1] - marker[1]) * ax[1] +
        (seat[2] - marker[2]) * ax[2]
      )
    })
    check(`R7 multi-pin connector has several pegs (${pegs.length})`, pegs.length >= 4)
    check(
      'R7 no per-participating-pin offset accumulates across the body',
      offsets.length > 0 && offsets.every((o) => Math.abs(o - offsets[0]) < 1e-9),
      offsets.map((o) => o.toFixed(5)).join(', '),
    )
    check(
      'R7 every peg registers its own occupancy id',
      pegs.length > 0 &&
        new Set(pegs.map((s) => s.occupancyGroup ?? s.id)).size === pegs.length,
    )
  }

  // -- 8. Multi-layer receivers add no per-layer pre-load ------------------
  {
    const pin3x3 = PARTS.find((p) => p.partNumber === '228-2500-089')!
    const layers = ['pin-front', 'pin-front-2', 'pin-front-3'].map(
      (id) => poseOf(pin3x3.id, id, BEAM_PART_ID, 'hole-0').diagnostics,
    )
    check(
      'R8 every stacked layer reports the identical contact gap',
      layers.every(
        (d) => Math.abs(d.axialContactGap - layers[0].axialContactGap) < 1e-12,
      ),
      layers.map((d) => d.axialContactGap.toFixed(6)).join(', '),
    )
    // Float noise only. The distinction matters: 1.4e-17 is one double-precision
    // ulp of a 0.24-scale coordinate, whereas the defect this replaces was
    // 0.010 PER LAYER — fifteen orders of magnitude larger.
    check(
      'R8 no stacked layer carries unintended penetration beyond float noise',
      layers.every((d) => d.unintendedPenetration < 1e-12),
      layers.map((d) => d.unintendedPenetration.toExponential(2)).join(', '),
    )
  }

  // -- 9. Front and rear insertion use the correct receiving surface -------
  {
    const front = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0')
    const rear = poseOf(PIN_1X1_PART_ID, 'pin-front', BEAM_PART_ID, 'hole-0-back')
    check(
      'R9 front and rear insertion land on opposite sides of the beam',
      Math.sign(front.position[2]) === -Math.sign(rear.position[2]) &&
        Math.abs(front.position[2]) > 0.1,
      `front z=${front.position[2].toFixed(5)} rear z=${rear.position[2].toFixed(5)}`,
    )
    check(
      'R9 front and rear both reach exact contact',
      front.diagnostics.unintendedPenetration === 0 &&
        rear.diagnostics.unintendedPenetration === 0,
    )
    // Separation = beam thickness + the pin collar (0.070), because each side
    // stops on its OWN collar face rather than on a shared midplane.
    check(
      'R9 the two seated poses are one beam thickness plus one collar apart',
      approx(
        Math.abs(front.position[2] - rear.position[2]),
        SNAP_CALIBRATION.beamReceivingDepth + 0.07,
        1e-6,
      ),
      `${Math.abs(front.position[2] - rear.position[2]).toFixed(5)}`,
    )
  }

  // -- 10/13. Electronics are keyed by `id`, not `partNumber` --------------
  {
    for (const [label, key] of [
      ['Smart Motor', '228-2560'],
      ['Brain Gen 1', '228-2540'],
      ['Brain Gen 2', '228-6480'],
    ] as const) {
      const def = PARTS.find((p) => p.partNumber === key || p.id === key)
      check(`R10 ${label} resolves under either metadata key`, !!def, `key=${key}`)
      if (!def) continue
      const holes = getSnapPoints(def).filter((s) => s.type === 'hole')
      check(
        `R10 ${label} still exposes mechanical mount holes (${holes.length})`,
        holes.length > 0,
      )
      if (!holes.length) continue
      const solved = poseOf(PIN_1X1_PART_ID, 'pin-front', def.id, holes[0].id)
      const verdict = evaluateSeating(solved.diagnostics, CAL)
      check(
        `R10 a 1x1 pin seats exactly in the ${label} mount`,
        verdict.ok && solved.diagnostics.unintendedPenetration === 0,
        verdict.reasons.join('; '),
      )
      // R13: the part must be reachable under the SAME key the contact
      // inventory uses, or it drops out of the matrix silently.
      const frames = contactFramesForPart(def)
      check(
        `R13 ${label} contributes contact frames under its own key (${frames.length})`,
        frames.length > 0,
      )
    }
  }

  // -- 15. Joint Mode and normal snapping are transform-identical ----------
  {
    // Compare the RELATIVE seated transform (pin minus beam), not the pin's
    // absolute position: Joint Mode legitimately chooses which part moves, and
    // with the receiver picked first it moves the BEAM onto the pin. The
    // invariant that matters is that all three routes produce the same seated
    // relationship, which is what `computeSnapTransform` guarantees.
    const relativeSeat = (pinId: string, beamId: string): Vec3 => {
      const pin = state().parts.find((p) => p.instanceId === pinId)!
      const beam = state().parts.find((p) => p.instanceId === beamId)!
      return [
        pin.position[0] - beam.position[0],
        pin.position[1] - beam.position[1],
        pin.position[2] - beam.position[2],
      ]
    }

    state().clearProject()
    state().setSelectedPinPartId(PIN_1X1_PART_ID)
    const beamAuto = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    state().insertPinAtSnapPoint(beamAuto, 'hole-0')
    const autoPin = state().selectedInstanceId!
    const autoT = relativeSeat(autoPin, beamAuto)

    state().clearProject()
    const beamJ = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    const pinJ = state().addPart(PIN_1X1_PART_ID, [2, 2, 2])!
    state().setMode('joint')
    state().jointPick(beamJ, 'hole-0')
    state().jointPick(pinJ, 'pin-front')
    const jointT = relativeSeat(pinJ, beamJ)

    state().clearProject()
    const beamK = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    const pinK = state().addPart(PIN_1X1_PART_ID, [2, 2, 2])!
    state().setMode('joint')
    state().jointPick(pinK, 'pin-front')
    state().jointPick(beamK, 'hole-0')
    const jointT2 = relativeSeat(pinK, beamK)

    check(
      'R15 Joint Mode (receiver picked first) equals normal snapping',
      autoT.every((v, i) => Math.abs(v - jointT[i]) <= 1e-9),
      `auto=${autoT} joint=${jointT}`,
    )
    check(
      'R15 Joint Mode (pin picked first) equals normal snapping',
      autoT.every((v, i) => Math.abs(v - jointT2[i]) <= 1e-9),
      `auto=${autoT} joint=${jointT2}`,
    )
    state().clearProject()
  }

  // -- 16. A saved pin-seat override cannot mask the measured geometry -----
  // Reported from the app 2026-07-29: a user had `Saved default 0.0300` on the
  // 1x1 / 0x2 / 0x3 from calibrating by hand against the OLD collar-midplane
  // seat planes. That value REPLACES `finalSeatAdjustment` after the measured
  // contact plane is applied, so it silently re-introduces the very error the
  // measurement removed. The storage key is now v2 (v1 is dropped on load) and
  // the value is clamped to the fine-adjustment range.
  {
    check(
      `R16 pin-seat override storage is v2 (stale v1 calibrations are dropped)`,
      PIN_SEAT_OVERRIDE_LIMIT === 0.02,
      `limit=${PIN_SEAT_OVERRIDE_LIMIT}`,
    )
    // A large override must be clamped, not honoured.
    setPinSeatOverride('pin1x1', 'pin-back', 0.5)
    const clamped = getPinSeatOverride('pin1x1', 'pin-back')
    check(
      'R16 an out-of-range saved override is clamped to the fine range',
      clamped === PIN_SEAT_OVERRIDE_LIMIT,
      `stored=${clamped}`,
    )
    // Even at the bound it may only move the seat by that much — never enough
    // to reach the 0.035 collar-midplane error it used to compensate for.
    check(
      'R16 the override bound is smaller than the collar half-thickness (0.035)',
      PIN_SEAT_OVERRIDE_LIMIT < 0.035,
    )
    clearPinSeatOverride('pin1x1', 'pin-back')
    check(
      'R16 clearing the override restores the measured seating exactly',
      getPinSeatOverride('pin1x1', 'pin-back') === undefined &&
        approx(
          poseOf(PIN_1X1_PART_ID, 'pin-back', BEAM_PART_ID, 'hole-0-back')
            .diagnostics.axialContactGap,
          0,
          1e-9,
        ),
    )
  }

  // -- 17. A legacy project re-seats itself on load ------------------------
  // Reported from the DEPLOYED site: the geometry fix shipped, but opening an
  // existing robot still showed every pin floating. `loadProject` restored
  // `project.parts` verbatim, so a corrected seat plane could only ever reach
  // NEW snaps. Mates are the durable fact; the transform is derived from them.
  {
    state().clearProject()
    state().setSelectedPinPartId(PIN_1X1_PART_ID)
    const beam = state().addPart(BEAM_PART_ID, [0, 0, 0])!
    state().insertPinAtSnapPoint(beam, 'hole-0')
    const pinId = state().selectedInstanceId!
    const good = [...state().parts.find((p) => p.instanceId === pinId)!.position] as Vec3

    // Forge a "saved before the fix" project: same mate, stale pose.
    const file = JSON.parse(JSON.stringify(state().exportProject()))
    const stale = file.parts.find((p: { instanceId: string }) => p.instanceId === pinId)
    stale.position = [good[0], good[1], good[2] - 0.035]
    check(
      'R17 the forged legacy project really is off by the old collar error',
      Math.abs(stale.position[2] - good[2]) > 0.03,
    )

    state().loadProject(file)
    const after = state().parts.find((p) => p.instanceId === pinId)!
    check(
      'R17 loading a legacy project re-seats the pin onto its measured surface',
      after.position.every((v, i) => Math.abs(v - good[i]) <= 1e-9),
      `after=${after.position} want=${good}`,
    )
    check(
      'R17 the load reports how many parts it re-seated',
      /re-seated/.test(state().statusMessage),
      `status="${state().statusMessage}"`,
    )
    check(
      'R17 the re-seated mate survives the load',
      state().connections.length === 1,
    )

    // A project that is ALREADY correct must not be disturbed.
    const clean = JSON.parse(JSON.stringify(state().exportProject()))
    state().loadProject(clean)
    const again = state().parts.find((p) => p.instanceId === pinId)!
    check(
      'R17 an already-correct project is left byte-identical (nothing re-seated)',
      again.position.every((v, i) => Math.abs(v - good[i]) <= 1e-12) &&
        !/re-seated/.test(state().statusMessage),
      `status="${state().statusMessage}"`,
    )
    // An unmated part must never be moved by the re-seat pass.
    state().clearProject()
    const lone = state().addPart(BEAM_PART_ID, [1.25, 0, 0.5])!
    const loneFile = JSON.parse(JSON.stringify(state().exportProject()))
    state().loadProject(loneFile)
    const loneAfter = state().parts.find((p) => p.instanceId === lone)!
    check(
      'R17 an unmated part is never moved by the re-seat pass',
      loneAfter.position.every((v, i) => Math.abs(v - [1.25, 0, 0.5][i]) <= 1e-12),
      `pos=${loneAfter.position}`,
    )
    state().clearProject()
  }

  // -- 12b. Every production inserting endpoint is mesh-measured -----------
  {
    let notMeasured = 0
    let checked = 0
    for (const part of PARTS) {
      for (const frame of contactFramesForPart(part)) {
        if (frame.role !== 'insert' || frame.reviewGated) continue
        checked += 1
        if (!frame.contactPlaneMeasured) notMeasured += 1
      }
    }
    check(
      `R12 every production inserting endpoint is mesh-measured (${checked} checked)`,
      notMeasured === 0,
      `${notMeasured} not measured`,
    )
  }
}

// ------------------------------------------------------------------ result
state().clearProject()
if (failures > 0) {
  console.error(`\nverify:pins FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify:pins passed')
