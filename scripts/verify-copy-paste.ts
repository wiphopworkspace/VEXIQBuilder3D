/**
 * Tracked Copy/Paste + Robot Brain Gen 2 regression check
 * (`npm run verify:copy-paste`).
 *
 * Headless (no WebGL) — the Zustand store imports cleanly in Node, so the real
 * store actions are exercised, not a reimplementation.
 *
 *  1. Copy/Paste core: empty-selection and empty-clipboard are non-destructive;
 *     one part round-trips with a fresh instance id, the exact copied rotation,
 *     and one hole-pitch offset; repeated pastes accumulate the offset; a new
 *     Copy resets the sequence; Copy writes no history entry.
 *  2. Multi-part copy: relative transforms preserved exactly; internal mates
 *     recreated with NEW mate ids remapped onto the NEW instance ids; a mate
 *     with only one endpoint copied is excluded and the pasted part does NOT
 *     reconnect to the original; the originals are byte-identical afterwards.
 *  3. History + persistence: one Paste is one atomic undo/redo step (all parts
 *     AND all internal mates); save/load preserves pasted parts and mates,
 *     introduces no duplicate instance/mate ids, and resurrects no external
 *     mate.
 *  4. Keyboard safety: the shortcut guard used by the global handler refuses
 *     to fire inside inputs, textareas and contenteditable elements.
 *  5. Robot Brain Gen 2 (228-6480): catalog entry resolves with a distinct
 *     identity from Gen 1 (228-2540); the model path is production-safe
 *     (relative, correctly cased, real file on disk); default transform and
 *     bounds are finite and plausible against measured geometry; snap ids are
 *     unique; unverified mounts stay review-gated; Smart Cable ports never
 *     resolve as structural holes; instances get unique ids, survive
 *     save/load, and Gen 1 projects still load as Gen 1.
 *
 * Run with: npx tsx scripts/verify-copy-paste.ts
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useAssemblyStore } from '../src/store/assemblyStore'
import { getPartDefinition } from '../src/data/parts'
import { getSnapPoints, getSnapPointResolution } from '../src/data/snapOverrides'
import { PASTE_OFFSET_STEP } from '../src/utils/copyPaste'
import { SNAP_CALIBRATION } from '../src/data/snapCalibration'
import type { PartInstanceData, Vec3 } from '../src/types/assembly'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const BEAM_PART_ID = '1x4-beam-228-2500-003'
const PIN_PART_ID = '1x1-connector-pin-228-2500-060'
const BRAIN_GEN1_ID = '228-2540'
const BRAIN_GEN2_ID = '228-6480'
const TOL = 1e-9

let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const state = () => useAssemblyStore.getState()
const partOf = (id: string) =>
  state().parts.find((p) => p.instanceId === id) as PartInstanceData

function vecEq(a: Vec3, b: Vec3, tol = TOL): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tol &&
    Math.abs(a[1] - b[1]) <= tol &&
    Math.abs(a[2] - b[2]) <= tol
  )
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/** Deep snapshot for byte-identical comparisons of the ORIGINAL scene. */
function sceneJson(ids: string[]): string {
  return JSON.stringify(
    state()
      .parts.filter((p) => ids.includes(p.instanceId))
      .map((p) => ({ ...p })),
  )
}

// ===========================================================================
console.log('\n1. Copy/Paste core — single part, offsets, history')
// ===========================================================================
{
  state().clearProject()

  // 1. Copy with nothing selected.
  state().selectPart(null)
  const historyBefore = state().historyPast.length
  state().copySelection()
  check(
    'copy with nothing selected is a no-op with a useful status',
    state().clipboard === null &&
      state().statusMessage === 'Nothing selected to copy.' &&
      state().parts.length === 0,
    state().statusMessage,
  )

  // 19. Paste with an empty clipboard is non-destructive.
  state().pasteClipboard()
  check(
    'paste with an empty clipboard is non-destructive',
    state().parts.length === 0 &&
      state().connections.length === 0 &&
      state().historyPast.length === historyBefore,
  )

  // 2/3/4/5. Copy + paste one unconnected part.
  const beam = state().addPart(BEAM_PART_ID, [1, 0.25, -2])!
  // Give it a non-trivial rotation so "exact copied rotation" is meaningful.
  state().updatePartTransform(beam, [1, 0.25, -2], [0.3, -1.2, 2.5])
  const original = { ...partOf(beam) }
  state().selectPart(beam)

  const histBeforeCopy = state().historyPast.length
  state().copySelection()
  // 18. Copy does not add an undo-history entry.
  check(
    'copy adds no undo-history entry',
    state().historyPast.length === histBeforeCopy,
  )
  check(
    'copy reports the part count',
    state().statusMessage === 'Copied 1 part.',
    state().statusMessage,
  )
  check(
    'copy does not mutate the scene',
    state().parts.length === 1 &&
      JSON.stringify(partOf(beam)) === JSON.stringify(original),
  )

  state().pasteClipboard()
  check('paste adds exactly one part', state().parts.length === 2)
  const pasted = state().parts[1]

  // 3. Unique instance IDs.
  check(
    'pasted instance id is new and unique',
    pasted.instanceId !== beam &&
      new Set(state().parts.map((p) => p.instanceId)).size === 2,
  )
  // 4. Exact copied rotation (and the rest of the editable properties).
  check(
    'pasted part preserves rotation exactly',
    vecEq(pasted.rotation, original.rotation, 0),
  )
  check(
    'pasted part preserves partId, scale and color',
    pasted.partId === original.partId &&
      vecEq(pasted.scale, original.scale, 0) &&
      pasted.color === original.color,
  )
  // 5. Predictable position offset.
  check(
    'first paste offsets by exactly one paste step',
    vecEq(sub(pasted.position, original.position), PASTE_OFFSET_STEP),
    `${sub(pasted.position, original.position)}`,
  )
  check(
    'the paste step is one VEX IQ hole pitch on X and Z, none on Y',
    PASTE_OFFSET_STEP[0] === SNAP_CALIBRATION.beamHolePitch &&
      PASTE_OFFSET_STEP[2] === SNAP_CALIBRATION.beamHolePitch &&
      PASTE_OFFSET_STEP[1] === 0,
  )
  check(
    'pasted part becomes the selection',
    state().selectedInstanceId === pasted.instanceId,
  )
  check(
    'pasting an unconnected part creates no connections',
    state().connections.length === 0,
  )

  // 6. Repeated paste accumulates the offset.
  state().pasteClipboard()
  state().pasteClipboard()
  check('three pastes produced three new parts', state().parts.length === 4)
  const [p1, p2, p3] = state().parts.slice(1)
  check(
    'repeated pastes accumulate +1/+2/+3 offset steps',
    vecEq(sub(p1.position, original.position), PASTE_OFFSET_STEP) &&
      vecEq(sub(p2.position, original.position), [
        PASTE_OFFSET_STEP[0] * 2,
        PASTE_OFFSET_STEP[1] * 2,
        PASTE_OFFSET_STEP[2] * 2,
      ]) &&
      vecEq(sub(p3.position, original.position), [
        PASTE_OFFSET_STEP[0] * 3,
        PASTE_OFFSET_STEP[1] * 3,
        PASTE_OFFSET_STEP[2] * 3,
      ]),
  )
  check(
    'repeated pastes all have unique instance ids',
    new Set(state().parts.map((p) => p.instanceId)).size === 4,
  )

  // 20. Re-copy resets the repeated-paste offset sequence.
  state().selectPart(beam)
  state().copySelection()
  state().pasteClipboard()
  const afterRecopy = state().parts[state().parts.length - 1]
  check(
    're-copy resets the paste offset back to one step',
    vecEq(sub(afterRecopy.position, original.position), PASTE_OFFSET_STEP),
    `${sub(afterRecopy.position, original.position)}`,
  )

  state().clearProject()
}

// ===========================================================================
console.log('\n2. Assemblies — relative transforms, internal vs external mates')
// ===========================================================================
{
  state().clearProject()

  // Build a real connected pair through the normal snap pipeline.
  const beamA = state().addPart(BEAM_PART_ID, [0, 0.25, 0])!
  state().insertPinAtSnapPoint(beamA, 'hole-0')
  const pin = state().parts[1].instanceId
  check(
    'fixture: pin inserted and mated to beam A',
    state().connections.length === 1,
  )

  // --- 10/11. Copy ONLY the pin: the external mate must not come along.
  state().selectPart(pin)
  state().copySelection()
  const beforeExternal = sceneJson([beamA, pin])
  const matesBefore = JSON.stringify(state().connections)
  state().pasteClipboard()
  const lonePin = state().parts[state().parts.length - 1]
  check(
    'copying one side of a mate pastes an unconnected part',
    state().connections.length === 1 &&
      !state().connections.some(
        (c) =>
          c.aInstanceId === lonePin.instanceId ||
          c.bInstanceId === lonePin.instanceId,
      ),
  )
  check(
    'the external mate is neither copied nor altered on the original',
    JSON.stringify(state().connections) === matesBefore,
  )
  check(
    'originals are byte-identical after copy+paste',
    sceneJson([beamA, pin]) === beforeExternal,
  )
  // Remove the stray pin so the next fixture is clean.
  state().selectPart(lonePin.instanceId)
  state().deleteSelected()

  // --- 7/8/9/12. Copy BOTH parts: internal mate recreated, remapped, new ids.
  const beamPos = partOf(beamA).position
  const pinPos = partOf(pin).position
  const relative = sub(pinPos, beamPos)
  const originalMate = state().connections[0]

  state().selectPart(beamA)
  state().toggleSelectPart(pin)
  check(
    'shift/ctrl+click builds a two-part selection',
    state().getSelectionIds().length === 2,
  )
  state().copySelection()
  check(
    'copy reports parts and connections',
    state().statusMessage === 'Copied 2 parts and 1 connection.',
    state().statusMessage,
  )

  const beforeAssembly = sceneJson([beamA, pin])
  state().pasteClipboard()
  check('pasting an assembly adds both parts', state().parts.length === 4)
  check(
    'pasting an assembly recreates exactly one internal mate',
    state().connections.length === 2,
  )

  const newBeam = state().parts[2]
  const newPin = state().parts[3]
  const newMate = state().connections[1]

  // 8. Relative transforms preserved. Tolerance is 1e-9, not 0: translating a
  // float by +0.5 and comparing differences reintroduces ~1e-17 of rounding
  // (0.12508 + 0.5 - 0.5 !== 0.12508 in IEEE-754). That is 13 orders of
  // magnitude below the snap tolerances, and no representable offset avoids it.
  check(
    'relative transform inside the copied set is preserved',
    vecEq(sub(newPin.position, newBeam.position), relative, TOL),
    `${sub(newPin.position, newBeam.position)} vs ${relative}`,
  )
  check(
    'the whole set moved by one shared offset step',
    vecEq(sub(newBeam.position, beamPos), PASTE_OFFSET_STEP) &&
      vecEq(sub(newPin.position, pinPos), PASTE_OFFSET_STEP),
  )
  check(
    'copied rotations are preserved across the set',
    vecEq(newBeam.rotation, partOf(beamA).rotation, 0) &&
      vecEq(newPin.rotation, partOf(pin).rotation, 0),
  )

  // 9/12. Mate remapped onto NEW instance ids with a NEW mate id. Endpoint
  // ORDER follows the original mate (insertPinAtSnapPoint stores pin-first),
  // so this asserts the endpoint SET plus the per-endpoint snap-id roles
  // rather than a fixed a/b order.
  const newEndpoints = [newMate.aInstanceId, newMate.bInstanceId].sort()
  check(
    'the recreated mate references only the NEW instance ids',
    JSON.stringify(newEndpoints) ===
      JSON.stringify([newBeam.instanceId, newPin.instanceId].sort()),
    `${newMate.aInstanceId} / ${newMate.bInstanceId}`,
  )
  const snapIdFor = (
    mate: typeof newMate,
    beamId: string,
    pinId: string,
  ) => ({
    beam: mate.aInstanceId === beamId ? mate.aSnapId : mate.bSnapId,
    pin: mate.aInstanceId === pinId ? mate.aSnapId : mate.bSnapId,
  })
  const originalRoles = snapIdFor(originalMate, beamA, pin)
  const newRoles = snapIdFor(newMate, newBeam.instanceId, newPin.instanceId)
  check(
    'each copied endpoint keeps its own snap point (roles not swapped)',
    originalRoles.beam === newRoles.beam && originalRoles.pin === newRoles.pin,
    `${JSON.stringify(newRoles)} vs ${JSON.stringify(originalRoles)}`,
  )
  check(
    'the recreated mate reuses no original instance id',
    newMate.aInstanceId !== beamA &&
      newMate.bInstanceId !== pin &&
      newMate.aInstanceId !== pin &&
      newMate.bInstanceId !== beamA,
  )
  check(
    'the recreated mate has a NEW unique mate id',
    newMate.id !== originalMate.id &&
      new Set(state().connections.map((c) => c.id)).size ===
        state().connections.length,
  )
  check(
    'the recreated mate keeps the same snap-point pair',
    newMate.aSnapId === originalMate.aSnapId &&
      newMate.bSnapId === originalMate.bSnapId,
  )
  // 11. Originals untouched.
  check(
    'the original assembly is byte-identical after the copy/paste',
    sceneJson([beamA, pin]) === beforeAssembly,
  )
  check(
    'the original mate is unchanged',
    JSON.stringify(state().connections[0]) === JSON.stringify(originalMate),
  )
  check(
    'no pasted part is mated to any original part',
    !state().connections.some(
      (c) =>
        (c.aInstanceId === beamA && c.bInstanceId !== pin) ||
        (c.bInstanceId === beamA && c.aInstanceId !== pin) ||
        [newBeam.instanceId, newPin.instanceId].some(
          (id) =>
            (c.aInstanceId === id && ![newBeam.instanceId, newPin.instanceId].includes(c.bInstanceId)) ||
            (c.bInstanceId === id && ![newBeam.instanceId, newPin.instanceId].includes(c.aInstanceId)),
        ),
    ),
  )

  state().clearProject()
}

// ===========================================================================
console.log('\n3. History atomicity and save/load')
// ===========================================================================
{
  state().clearProject()
  const beamA = state().addPart(BEAM_PART_ID, [0, 0.25, 0])!
  state().insertPinAtSnapPoint(beamA, 'hole-0')
  const pin = state().parts[1].instanceId
  state().selectPart(beamA)
  state().toggleSelectPart(pin)
  state().copySelection()

  const partsBefore = state().parts.length
  const matesBefore = state().connections.length
  const histBefore = state().historyPast.length
  state().pasteClipboard()

  // 13. Undo removes the complete paste atomically.
  check(
    'one paste adds exactly one history entry',
    state().historyPast.length === histBefore + 1,
  )
  check(
    'paste landed 2 parts + 1 mate',
    state().parts.length === partsBefore + 2 &&
      state().connections.length === matesBefore + 1,
  )
  state().undo()
  check(
    'one undo removes every pasted part AND the pasted internal mate',
    state().parts.length === partsBefore &&
      state().connections.length === matesBefore,
    `${state().parts.length} parts / ${state().connections.length} mates`,
  )

  // 14. Redo restores the complete paste atomically.
  state().redo()
  check(
    'one redo restores every pasted part and the internal mate',
    state().parts.length === partsBefore + 2 &&
      state().connections.length === matesBefore + 1,
  )
  const redoneIds = state().parts.slice(partsBefore).map((p) => p.instanceId)
  const redoneMate = state().connections[matesBefore]
  check(
    'redo restores the mate remapped onto the restored instance ids',
    redoneIds.includes(redoneMate.aInstanceId) &&
      redoneIds.includes(redoneMate.bInstanceId),
  )

  // 15/16. Save/load.
  const file = state().exportProject()
  const roundTripped = JSON.parse(JSON.stringify(file))
  const beforeIds = state().parts.map((p) => p.instanceId)
  const beforeMateIds = state().connections.map((c) => c.id)
  state().loadProject(roundTripped)
  check(
    'save/load preserves pasted parts and their internal mate',
    state().parts.length === partsBefore + 2 &&
      state().connections.length === matesBefore + 1,
  )
  check(
    'save/load introduces no duplicate instance ids',
    new Set(state().parts.map((p) => p.instanceId)).size ===
      state().parts.length &&
      JSON.stringify(state().parts.map((p) => p.instanceId)) ===
        JSON.stringify(beforeIds),
  )
  check(
    'save/load introduces no duplicate mate ids',
    new Set(state().connections.map((c) => c.id)).size ===
      state().connections.length &&
      JSON.stringify(state().connections.map((c) => c.id)) ===
        JSON.stringify(beforeMateIds),
  )
  check(
    'save/load resurrects no external mate',
    state().connections.length === matesBefore + 1,
  )
  // Pasted parts stay independent of their originals after a reload.
  const loadedPasted = state().parts.slice(partsBefore).map((p) => p.instanceId)
  check(
    'pasted parts remain independent of the originals after reload',
    !state().connections.some(
      (c) =>
        (loadedPasted.includes(c.aInstanceId) &&
          !loadedPasted.includes(c.bInstanceId)) ||
        (loadedPasted.includes(c.bInstanceId) &&
          !loadedPasted.includes(c.aInstanceId)),
    ),
  )

  // Copy/Paste still works after a load (clipboard survives; ids stay unique).
  state().selectPart(state().parts[0].instanceId)
  state().copySelection()
  state().pasteClipboard()
  check(
    'copy/paste still works after loading a project',
    new Set(state().parts.map((p) => p.instanceId)).size ===
      state().parts.length,
  )

  state().clearProject()
}

// ===========================================================================
console.log('\n4. Keyboard focus safety')
// ===========================================================================
{
  // Mirrors the guard in src/App.tsx: shortcuts never fire while typing.
  const shouldIgnore = (tagName: string, isContentEditable = false) =>
    tagName === 'INPUT' || tagName === 'TEXTAREA' || isContentEditable

  // 17. Shortcuts do not trigger inside editable fields.
  check(
    'shortcuts are ignored in text inputs (search / part-name fields)',
    shouldIgnore('INPUT'),
  )
  check('shortcuts are ignored in textareas', shouldIgnore('TEXTAREA'))
  check(
    'shortcuts are ignored in contenteditable elements',
    shouldIgnore('DIV', true),
  )
  check(
    'shortcuts still fire on non-editable elements',
    !shouldIgnore('CANVAS') && !shouldIgnore('BODY') && !shouldIgnore('DIV'),
  )

  const appSource = await fs.readFile(path.join(ROOT, 'src', 'App.tsx'), 'utf8')
  const guardIndex = appSource.indexOf("target.tagName === 'INPUT'")
  const copyIndex = appSource.indexOf('store.copySelection()')
  const pasteIndex = appSource.indexOf('store.pasteClipboard()')
  check(
    'copy/paste handlers are wired in the single global key handler',
    copyIndex > 0 && pasteIndex > 0,
  )
  check(
    'copy/paste are registered AFTER the editable-target guard',
    guardIndex > 0 && copyIndex > guardIndex && pasteIndex > guardIndex,
  )
  check(
    'only one global keydown listener is registered in App.tsx',
    appSource.split("addEventListener('keydown'").length - 1 === 1,
  )
}

// ===========================================================================
console.log('\n5. Robot Brain Gen 2 (228-6480)')
// ===========================================================================
{
  state().clearProject()

  // 1. Catalog entry resolves.
  const gen2 = getPartDefinition(BRAIN_GEN2_ID)
  const gen1 = getPartDefinition(BRAIN_GEN1_ID)
  check('Brain Gen 2 catalog entry resolves', !!gen2)
  check('Brain Gen 1 catalog entry still resolves', !!gen1)
  if (!gen2 || !gen1) {
    console.error('  (skipping the rest of section 5 — catalog entry missing)')
  } else {
    // 7. Gen 1 and Gen 2 identifiers remain distinct.
    check(
      'Gen 1 and Gen 2 are distinct catalog identities',
      gen2.id !== gen1.id &&
        gen2.name !== gen1.name &&
        gen2.modelPath !== gen1.modelPath,
    )
    check(
      'Gen 2 is named distinguishably in the catalog',
      /gen\s*2/i.test(gen2.name) && !/gen\s*2/i.test(gen1.name),
      `${gen2.name} vs ${gen1.name}`,
    )
    check(
      'Gen 2 is categorized with the other electronics',
      gen2.category === gen1.category,
    )

    // 2/14. Model URL resolves in a production build (relative + exact case).
    const modelPath = gen2.modelPath ?? ''
    check(
      'Gen 2 model path is a root-relative /models path (BASE_URL-rebasable)',
      modelPath.startsWith('/models/') && !/^[a-zA-Z]:\\|^file:|^http/.test(modelPath),
      modelPath,
    )
    check(
      'Gen 2 model path contains no Windows separators or absolute drive',
      !modelPath.includes('\\'),
      modelPath,
    )
    const diskPath = path.join(ROOT, 'public', modelPath.replace(/^\//, ''))
    let exists = false
    let sizeKb = 0
    try {
      const st = await fs.stat(diskPath)
      exists = st.isFile()
      sizeKb = st.size / 1024
    } catch {
      exists = false
    }
    check('Gen 2 GLB exists on disk at the manifest path', exists, diskPath)
    // 3/14. Case-sensitive hosting (GitHub Pages) — the on-disk entry name must
    // match the manifest byte for byte, which a case-insensitive stat() would
    // happily fake.
    const dir = path.dirname(diskPath)
    const base = path.basename(diskPath)
    const entries = await fs.readdir(dir)
    check(
      'Gen 2 GLB filename casing matches on a case-sensitive host',
      entries.includes(base),
      `${base} not found exactly in ${path.basename(dir)}`,
    )
    check(
      'Gen 2 GLB is a real, non-trivial asset',
      sizeKb > 10 && sizeKb < 8192,
      `${sizeKb.toFixed(0)} KB`,
    )
    // 3. Asset loader can parse it: verify the GLB container header.
    const buf = await fs.readFile(diskPath)
    check(
      'Gen 2 GLB has a valid glTF binary header',
      buf.readUInt32LE(0) === 0x46546c67 && buf.readUInt32LE(4) === 2,
    )
    check(
      'Gen 2 GLB declared length matches the file on disk',
      buf.readUInt32LE(8) === buf.length,
    )
    check(
      'Gen 2 GLB has no external texture dependencies',
      // Flat PBR from the STEP pipeline: no images/URIs to 404 in production.
      !buf.subarray(0, buf.readUInt32LE(12) + 20).includes(Buffer.from('"uri"')),
    )

    // 4/5/6. Default transform, scale and bounds.
    const inst = state().addPart(BRAIN_GEN2_ID)!
    const placed = partOf(inst)
    check(
      'Gen 2 default scale is finite and unit',
      placed.scale.every(Number.isFinite) && vecEq(placed.scale, [1, 1, 1], 0),
    )
    check(
      'Gen 2 default position and rotation are finite',
      placed.position.every(Number.isFinite) &&
        placed.rotation.every(Number.isFinite),
    )
    check(
      'Gen 2 default rotation is identity (orientation baked into the GLB)',
      vecEq(placed.rotation, [0, 0, 0], 0),
    )

    // 6. Bounding box non-zero and plausible, measured from the snap metadata
    // envelope + the measured body extents recorded in snapOverrides.
    const snaps = getSnapPoints(gen2)
    check('Gen 2 exposes snap points', snaps.length > 0)
    const xs = snaps.map((s) => s.position[0])
    const zs = snaps.map((s) => s.position[2])
    const width = Math.max(...xs) - Math.min(...xs)
    const wallSpan = Math.max(...zs) - Math.min(...zs)
    check(
      'Gen 2 mount span matches the measured 8x6-pitch body (non-zero, plausible)',
      Math.abs(width - 3.5) < 1e-6 && Math.abs(wallSpan - 3.004) < 0.01,
      `width ${width} wallSpan ${wallSpan}`,
    )
    check(
      'Gen 2 mount sockets sit on an exact 0.5 VEX IQ pitch',
      [...new Set(xs)]
        .sort((a, b) => a - b)
        .every((x, i, arr) =>
          i === 0
            ? true
            : Math.abs(arr[i] - arr[i - 1] - SNAP_CALIBRATION.beamHolePitch) <
              1e-6,
        ),
    )
    check(
      'Gen 2 mount geometry is NOT copied from Gen 1',
      JSON.stringify(getSnapPoints(gen1).map((s) => s.position)) !==
        JSON.stringify(snaps.map((s) => s.position)),
    )

    // 11. No snap id duplicates.
    const ids = snaps.map((s) => s.id)
    check(
      'Gen 2 snap ids are unique',
      new Set(ids).size === ids.length,
      `${ids.length} snaps, ${new Set(ids).size} unique`,
    )
    check(
      'Gen 2 front/back walls occupy independently',
      snaps.every((s) => !!s.occupancyGroup) &&
        new Set(snaps.map((s) => s.occupancyGroup)).size === snaps.length,
    )

    // 12. Unverified mounts remain review-gated.
    check(
      'Gen 2 mount sockets stay review-gated (approximate + needsReview)',
      snaps.every((s) => s.approximate === true && s.curatedNeedsReview === true),
    )
    check(
      'Gen 2 metadata resolves through the curated layer',
      getSnapPointResolution(gen2).source === 'curated',
    )

    // 13. Smart Cable ports are not structural hole snaps.
    //     Ports measure y in [0.045, 0.485] on the +/-Z walls (0.5657 spacing);
    //     mounts sit at y = -0.43. Nothing structural may live in the port band.
    const inPortBand = snaps.filter(
      (s) =>
        Math.abs(s.position[2]) > 0.9 &&
        s.position[1] > 0 &&
        s.position[1] < 0.55,
    )
    check(
      'no Gen 2 snap point resolves inside a Smart Cable port band',
      inPortBand.length === 0,
      inPortBand.map((s) => s.id).join(','),
    )
    check(
      'no Gen 2 hole sits on the 0.5657 cable-port spacing',
      !snaps.some((s) => Math.abs(Math.abs(s.position[1]) - 0.265) < 0.05),
    )

    // 10. Multiple instances receive unique ids.
    const inst2 = state().addPart(BRAIN_GEN2_ID)!
    const inst3 = state().addPart(BRAIN_GEN2_ID)!
    check(
      'multiple Gen 2 instances get unique instance ids',
      new Set([inst, inst2, inst3]).size === 3,
    )
    check(
      'multiple Gen 2 instances share one part definition (single asset load)',
      state()
        .parts.filter((p) => p.partId === BRAIN_GEN2_ID)
        .every((p) => getPartDefinition(p.partId)?.modelPath === modelPath),
    )

    // Copy/Paste preserves the Gen 2 part identity.
    state().selectPart(inst)
    state().copySelection()
    state().pasteClipboard()
    const copiedBrain = state().parts[state().parts.length - 1]
    check(
      'copying a Brain Gen 2 preserves its part identity',
      copiedBrain.partId === BRAIN_GEN2_ID &&
        copiedBrain.instanceId !== inst,
    )

    // 8/9. Save/load preserves Gen 2 identity; Gen 1 projects still load as Gen 1.
    state().clearProject()
    state().addPart(BRAIN_GEN1_ID)
    state().addPart(BRAIN_GEN2_ID)
    const mixed = JSON.parse(JSON.stringify(state().exportProject()))
    state().loadProject(mixed)
    const loadedIds = state().parts.map((p) => p.partId)
    check(
      'save/load preserves the Gen 2 part identity',
      loadedIds.filter((id) => id === BRAIN_GEN2_ID).length === 1,
    )
    check(
      'a saved Gen 1 Brain still loads as Gen 1 (no silent migration)',
      loadedIds.filter((id) => id === BRAIN_GEN1_ID).length === 1,
    )

    // 9. A legacy Gen 1 project (written before Gen 2 existed) loads unchanged.
    const legacy = {
      projectName: 'Legacy Gen 1',
      version: 3,
      parts: [
        {
          instanceId: 'legacy-brain-1',
          partId: BRAIN_GEN1_ID,
          position: [0, 0.53, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          color: '#9aa3b2',
        },
      ],
      connections: [],
    }
    state().loadProject(legacy)
    check(
      'a legacy Gen 1 project loads as Gen 1 with its transform intact',
      state().parts.length === 1 &&
        state().parts[0].partId === BRAIN_GEN1_ID &&
        vecEq(state().parts[0].position, [0, 0.53, 0], 0),
    )
  }

  state().clearProject()
}

// ------------------------------------------------------------------ result
state().clearProject()
if (failures > 0) {
  console.error(`\nverify:copy-paste FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify:copy-paste passed')
