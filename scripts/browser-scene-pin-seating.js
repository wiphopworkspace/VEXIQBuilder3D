/**
 * Repeatable BROWSER test scene + measurement harness for pin seating.
 *
 * This is a FIXTURE, not part of the build: paste the whole file into the dev
 * server's browser console (http://127.0.0.1:5173 or the worktree port) and
 * call the helpers. It relies on the DEV-only globals set in `src/main.tsx`
 * (`__vexStore`, `__vexMeasure`), so it does nothing in a production build.
 *
 *   await vexScene.build()      // several beam thicknesses, multiple pin
 *                               // types, a deep socket, motor + brain mounts
 *   vexScene.measure()          // per-mate contact gap / penetration / radial
 *   vexScene.rejections()       // Smart Cable port must yield NO candidate
 *   vexScene.rotations()        // four axial rotations -> identical pose
 *   vexScene.jointVsNormal()    // Joint Mode must equal normal snapping
 *   vexScene.cycle()            // move -> undo -> redo -> save/reload
 *
 * Every helper returns plain numbers so a session can quote MEASURED values
 * instead of eyeballing the render. Measured 2026-07-28 on this scene:
 * radial 0.00000 on every mate, axial gap -0.005 (0.000 for the capped 0x3),
 * penetration <= 0.005, marker gap 0.030-0.035 (proving marker != contact).
 */
/* eslint-disable no-undef */
;(() => {
  const S = () => window.__vexStore.getState()
  let M = null
  const ids = {}

  const inst = (id) => S().parts.find((p) => p.instanceId === id)
  const wsnaps = (id) =>
    M.getWorldSnapPoints(inst(id), M.getPartDefinition(inst(id).partId))
  const holeIds = (id) => wsnaps(id).filter((s) => s.type === 'hole').map((s) => s.id)
  const byKey = (k) => M.PARTS.find((p) => p.partNumber === k || p.id === k)

  async function build() {
    M = await window.__vexMeasure()
    S().clearProject()
    const beam1x4 = M.PARTS.find((p) => p.name === '1x4 Beam')
    const beam2x6 = M.PARTS.find((p) => p.name === '2x6 Beam')
    const plate = M.PARTS.find((p) => /^4x4 Plate$/.test(p.name))
    ids.beamThin = S().addPart(beam1x4.id, [0, 0, 0])
    ids.beamThick = S().addPart(beam2x6.id, [0, 0, 3])
    ids.plate = S().addPart(plate.id, [4, 0, 0])
    ids.motor = S().addPart(byKey('228-2560').id, [-4, 0, 0])
    ids.brain = S().addPart(byKey('228-6480').id, [0, 0, -5])

    const put = (pinKey, target, hole) => {
      S().setSelectedPinPartId(byKey(pinKey).id)
      S().insertPinAtSnapPoint(target, hole)
      return S().selectedInstanceId
    }
    const thin = holeIds(ids.beamThin)
    put('228-2500-060', ids.beamThin, 'hole-0') // front face
    put('228-2500-060', ids.beamThin, thin.find((h) => /-back$/.test(h))) // back face
    put('228-2500-062', ids.beamThick, holeIds(ids.beamThick)[0]) // thick beam
    put('228-2500-087', ids.plate, holeIds(ids.plate)[0]) // capped pin -> plate
    put('228-2500-060', ids.motor, holeIds(ids.motor)[0]) // motor mount
    put('228-2500-060', ids.brain, holeIds(ids.brain)[0]) // brain mount
    return { parts: S().parts.length, mates: S().connections.length, ids }
  }

  function measure() {
    const parts = S().parts
    const cal = S().pinSeating
    return S().connections.map((c) => {
      const v = M.validateMate(c, parts, cal)
      const res = (i, s) =>
        M.getWorldSnapPoints(
          parts.find((p) => p.instanceId === i),
          M.getPartDefinition(parts.find((p) => p.instanceId === i).partId),
        ).find((x) => x.id === s)
      const a = res(c.aInstanceId, c.aSnapId)
      const b = res(c.bInstanceId, c.bSnapId)
      const pa = M.worldSnapContactPosition(a)
      const pb = M.worldSnapContactPosition(b)
      const axis = (b.worldMateAxis || b.worldAxis).clone().normalize()
      const d = pa.clone().sub(pb)
      const axial = d.dot(axis)
      return {
        pair: `${c.aSnapId} <-> ${c.bSnapId}`,
        axialGap: +axial.toFixed(5),
        penetration: +Math.max(0, -axial).toFixed(5),
        radial: +d.clone().sub(axis.clone().multiplyScalar(axial)).length().toFixed(5),
        markerGap: +a.worldPosition.distanceTo(b.worldPosition).toFixed(5),
        health: v.health,
        intact: v.intact,
      }
    })
  }

  /** A pin dropped at the Smart Cable port must find NO candidate. */
  function rejections() {
    const pin = byKey('228-2500-060')
    const probe = S().addPart(pin.id, [-4.875, -0.49, 0])
    const info = { allRejectedByOverlap: false }
    const near = M.findNearestCompatibleSnap(probe, M.buildAllWorldSnapPoints(S().parts), {
      maxDistance: S().pinSeating.snapSearchDistance,
      occupied: M.buildOccupiedSnapSet(S().connections, S().parts),
      parts: S().parts,
      connections: S().connections,
      info,
    })
    S().selectPart(probe)
    S().deleteSelected()
    return { candidateFound: !!near, mustBe: false }
  }

  /** Four axial rotations must resolve to one deterministic seated pose. */
  function rotations() {
    const pin = byKey('228-2500-060')
    const target = wsnaps(ids.beamThin).find((s) => s.id === 'hole-3')
    return [0, 90, 180, 270].map((deg) => {
      const roll = (deg * Math.PI) / 180
      const staged = {
        instanceId: 't',
        partId: pin.id,
        position: [9, 9, 9],
        rotation: [0, 0, roll],
        scale: [1, 1, 1],
        color: '#888',
      }
      const src = M.getWorldSnapPoints(staged, pin).find((s) => s.id === 'pin-front')
      const r = M.solveSeatedPose(staged, src, target, { parts: S().parts })
      return {
        deg,
        pos: r.position.map((n) => +n.toFixed(5)),
        radial: +r.diagnostics.radialError.toFixed(5),
        gap: +r.diagnostics.axialContactGap.toFixed(5),
      }
    })
  }

  /** Joint Mode and Pin Mode must land on the same transform. */
  function jointVsNormal() {
    const pin = byKey('228-2500-060')
    S().setSelectedPinPartId(pin.id)
    S().insertPinAtSnapPoint(ids.beamThin, 'hole-1')
    const nid = S().selectedInstanceId
    const pose = (i) => {
      const p = inst(i)
      return { pos: p.position.map((n) => +n.toFixed(6)), rot: p.rotation.map((n) => +n.toFixed(6)) }
    }
    const normal = pose(nid)
    S().selectPart(nid)
    S().deleteSelected()

    const jid = S().addPart(pin.id, [7, 7, 7])
    S().setMode('joint')
    S().jointPick(jid, 'pin-front')
    S().jointPick(ids.beamThin, 'hole-1')
    const joint = pose(jid)
    S().setMode('select')
    return { normal, joint, identical: JSON.stringify(normal) === JSON.stringify(joint) }
  }

  /** move -> undo -> redo -> save/reload must be pose-exact. */
  function cycle() {
    const snap = () =>
      S()
        .parts.map((p) => ({
          id: p.instanceId,
          pos: p.position.map((n) => +n.toFixed(6)),
          rot: p.rotation.map((n) => +n.toFixed(6)),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const before = snap()
    S().selectPart(ids.beamThin)
    // the beam is joint-locked by design; unlock is the documented gesture
    if (S().toggleJointPositionLock) S().toggleJointPositionLock(ids.beamThin)
    S().nudgeSelected([1, 0, 0])
    const moved = snap()
    S().undo()
    const undoOk = same(snap(), before)
    S().redo()
    const redoOk = same(snap(), moved)
    S().undo()
    const f = S().exportProject()
    S().loadProject(JSON.parse(JSON.stringify(f)))
    const reloadOk = same(snap(), before)
    let driftOk = true
    for (let i = 0; i < 5; i++) {
      const g = S().exportProject()
      S().loadProject(JSON.parse(JSON.stringify(g)))
    }
    driftOk = same(snap(), before)
    return { undoOk, redoOk, reloadOk, noDriftAfter5Cycles: driftOk }
  }

  window.vexScene = { build, measure, rejections, rotations, jointVsNormal, cycle }
  console.log('vexScene ready — call: await vexScene.build() then vexScene.measure()')
})()
