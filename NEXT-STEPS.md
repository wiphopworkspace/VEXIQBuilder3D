# VEX IQ Builder — Next Steps (pin-by-pin / part-by-part)

Last updated: 2026-06-24. Read `HANDOFF.md` first, then this.

This is the working to-do for finishing the connector-pin snap system and the
remaining parts. It reflects the state after the snap/pin debugging sessions.

Recent implemented items:

- selection toolbar bug fixed: Select mode can click parts again
- Esc now resets the active tool and clears selection/highlight state
- beam/plate holes expose front and back receiving faces with grouped occupancy
- connected parts are position-locked by default but can rotate around their
  active joint pivot
- right-click or toolbar button toggles connected-part Lock/Unlock Position
- Electronics/control parts now have approximate curated front/back mounting
  holes for Joint Mode, Pin Mode, and Auto Snap
- Mate Connector persistence now supports connector refs/fallback frames for
  manual and surface-picked mates in project JSON
- Properties panel can list mates, set the active mate, and open Mate Editor
- active-mate rotation is available with `Q` / `E`; `Shift+Q` / `Shift+E` force
  object-center rotation
- Basic Mode hides the advanced Mate Editor/debug tools and avoids forcing
  low-confidence snaps

## CAD-lite Mate workflow (Phase 1 + Revolute) — 2026-06-24

New Advanced (Onshape/Fusion-lite) workflow. Basic Mode is the old "Easy Mode"
(renamed, default); Advanced Mode reveals the CAD-lite tools. Auto Snap / Joint
Mode / Pin Mode and `computeSnapTransform` are UNCHANGED — the Mate Editor is a
separate manual tool.

Flow: Advanced → **Mate Tool** (`mode: 'mate'`) → click a source connector →
target connector → **Mate Editor** opens → pick Fastened or Revolute → adjust
offset/roll(angle)/flip/gap → preview → **Apply**.

Important current UX status:

- This flow is still hard to use.
- The Mate Tool should be considered an advanced calibration/debug workflow, not
  the final classroom assembly workflow.
- The connector picker is visually noisy when many connectors are visible.
- Manual connector authoring works but is developer-oriented.
- Surface picks can be saved/loaded through fallback frames, but they should be
  marked and treated as `needsCalibration`.
- Do not add Slider/Cylindrical/Pin-slot mates until the source/target picker and
  Mate Editor are simplified.

New files:
- `src/types/mate.ts` — `MateConnector`, `FastenedMateParams`, `CalibrationRecord`.
- `src/utils/mateConnectors.ts` — `connectorsForInstance` (snap points → world
  frames), `surfaceConnector` (mesh-pick fallback), and
  `computeFastenedMateTransform` (self-contained align+offset+roll+flip+gap
  solver; deliberately NOT `computeSnapTransform`).
- `src/data/mateCalibration.ts` — localStorage CRUD + `findBestCalibration` +
  export/import, keyed by part number + connector id. Separate from project JSON.
- `src/components/MateConnectorPicker.tsx`, `MateConnectorTriad.tsx`,
  `MateEditorPanel.tsx`.

Store additions (`assemblyStore.ts`): `mateSource`/`mateTarget`/
`mateOriginalTransform`/`activeMateId`; actions `pickMateConnector`, `clearMate`,
`previewFastenedMate`, `restoreMatePreview`, `applyFastenedMate(params, mateType)`,
`cancelMate`, `setActiveMate`, `rotateAroundJointLive`.

Persistence / current files:

- `src/types/mate.ts` defines connector source/quality/ref/fallback types.
- `src/types/assembly.ts` stores connector refs and mate params on
  `ConnectionMate`.
- `src/utils/projectIO.ts` saves project schema version 3 and migrates old
  snap-only mates.
- `src/data/manualMateConnectors.ts` stores reusable local manual connector
  calibrations, but project JSON must not depend on localStorage alone.
- `src/components/ActiveMateHighlight.tsx` highlights active mate endpoints.

**Revolute joint:** `ConnectionMate.jointKind?: 'revolute'` (absent = fastened;
preserved through `projectIO`). Apply with mateType 'revolute' tags the mate;
the Properties panel shows an **Angle slider** that calls `rotateAroundJointLive`
(reuses `rotateInstanceAroundJoint`, keeps the joint pivot fixed — verified
headlessly). Q/E still do 90° joint steps. No constraint solver was added.

**Bug fixed this session — `raycast={undefined}` freeze.** Passing
`raycast={undefined}` to an R3F `<mesh>` shadows `Mesh.prototype.raycast` after a
function→undefined prop transition, throwing `object.raycast is not a function`
on every raytest and freezing ALL pointer input (the joint→select freeze). Both
`SnapPointMarkers.tsx` and the `ScenePart` hit-proxy now use a `DEFAULT_RAYCAST`
constant. **Never pass `raycast={undefined}` — always a function.**

## Status legend

- ✅ **verified** — headless-tested and (where relevant) regression-protected
- 🟢 **high-confidence** — measured + headless-verified, just needs a visual confirm
- 🟡 **needs-calibration** — usable but seat depth/orientation only approximate
- 🔴 **not modeled** — falls back to generated/inferred snap points

## How to calibrate one pin (the loop to repeat)

1. `node scripts/measure-pins.mjs` — add the pin's GLB filename to `TARGETS`.
   Read the cross-section: flange/cap = the `r≈0.125` bins; shaft = `r≈0.083`.
   Coords are **relative to the bbox center** (the frame snap overrides use).
2. Edit the profile in `src/data/pinProfiles.ts`:
   - central-flange pin → `twoEndedProfile` with `seatSpacing`/`frontSeatZ`/`backSeatZ`.
   - capped pin (0xN) → `cappedProfile` with `capInnerZ` = where the shaft meets the cap.
3. Verify headlessly: drive `useAssemblyStore` in a throwaway `tsx` script —
   insert the pin into a beam, print pin world position + snap Z vs the beam
   face (the store imports clean in Node; see prior repros). Delete the script.
4. Visually confirm at `npm run dev` using `http://127.0.0.1:5173`.
   Flip `metadataQuality`
   from `needs-calibration` → `measured` once it looks right.
5. `npm run typecheck && npm run build` must stay green.

Invariant: **never change the 1x1 profile** and keep `beamToBeamFaceClearance = 0.010`.
All placement goes through `computeSnapTransform` — do not add per-pin offset hacks.

## Pins — pin by pin

| Pin | Part # | Status | Model | What's left |
|---|---|---|---|---|
| 1x1 Connector | 228-2500-060 | ✅ | central flange z=0, layers 1/1 | nothing — calibrated, regression-locked |
| 1x1 Weak | 228-2500-2260 | 🟢 | shares pin1x1 | visual confirm |
| 1x1 Idler | 228-2500-073 | 🟡 | pin1x1 (down-ranked) | idlers spin free — not truly modeled |
| 2x2 Connector | 228-2500-062 | 🟢 | central flange z=0, layers 2/2, shafts ±0.47 | visual confirm (seats like 1x1) |
| 1x2 Connector | 228-2500-061 | 🟡 | flange off-centre z≈−0.12, layers 1/2 | confirm seated depth + 1-layer/2-layer faces |
| 1x2 Weak | 228-2500-2261 | 🟡 | shares pin1x2 | visual confirm |
| 1x2 Idler | 228-2500-098 | 🟡 | pin1x2 (down-ranked) | smooth idler, not modeled |
| 0x2 Connector | 228-2500-086 | 🟡 | **capped**, cap −Z, capInnerZ −0.19, 2 layers | confirm cap sits outside + shaft depth |
| 0x2 Spherical Cap | 228-2500-090 | 🟡 | **capped** spherical, capInnerZ −0.13 | spherical seat approximate |
| 0x2 Idler / Weak | 228-2500-084 / -2258 | 🟡 | pin0x2 (down-ranked / capped) | idler not modeled |
| 0x3 Connector | 228-2500-087 | 🟡 | **capped**, cap −Z, capInnerZ −0.30, 3 layers | confirm cap outside + shaft depth |
| 0x3 Idler / Weak | 228-2500-097 / -085 | 🟡 | pin0x3 (down-ranked) | idler not modeled |
| **3x3 Connector** | 228-2500-089 | 🔴 | generated fallback | **add profile** (central flange, layers 3/3, like 2x2 longer) |
| 2x3 Smooth Idler | 228-2500-093 | 🔴 | generated fallback | add profile or leave as idler fallback |
| 0x1 Sheet Pin | 228-2500-099 | 🟡 | center mate override (shaft along X, round) | not reviewed this round — verify |

Capped-pin note: orientation (cap stays **outside** the beam, shaft drives in) is
trace-verified deterministic; only the cap-face **depth** (`capInnerZ`, ±0.015
from the profiler bins) is approximate. That is why they are `needs-calibration`.

## Other parts — part by part

| Group | Status | Notes |
|---|---|---|
| Beams/Plates (rectangular NxM) | ✅ | staggered double-grid (Grid A ∪ Grid B + 1-wide-even centre). Do not flatten. |
| Electronics / Control parts | 🟡 | approximate curated front/back mount holes in `ELECTRONICS_MOUNT_LAYOUTS`; usable for joints/pins but needs visual review. |
| Specialty beams (corner, right-angle, truss, angle) | 🔴 | still need hand-authored overrides |
| Axles | 🔴 | center-axis mating via generated/inferred only |
| Gears / Wheels | 🔴 | center snaps generated/inferred — not curated |
| Standoff / corner connectors | 🔴 | not curated |

## Interaction / locking status

- Connected parts are position-locked by default. They should not drag away in
  Easy Mode or with the Move gizmo while locked.
- Locked connected parts can still rotate around the active joint point.
- Right-click a connected part or use the toolbar Lock/Unlock Position button to
  temporarily unlock/relock movement.
- When a part is snapped again, its position is relocked.
- This is not rigid-group movement: unlocking and moving one connected part can
  still break stale mates.

## Next steps for the Mate / Joint system (highest value first)

1. **Simplify the Mate Tool UX before adding features.**
   The current source connector -> target connector -> editor flow is too hard
   for beginners. First redesign the interaction so users can clearly see:
   selected source, compatible targets only, active mate, connector quality, and
   whether the action is safe. Consider a wizard-like panel or one-click "mate
   selected part to hovered connector" flow.
2. **Reduce connector picker visual noise.**
   Show connectors only for the selected part and likely compatible targets, or
   fade distant/incompatible connectors. Keep the full debug view behind an
   Advanced Debug toggle.
3. **Make manual connector authoring a clear calibration workflow.**
   Rename/copy should make it obvious that manual/surface connectors are
   calibration records, not verified VEX IQ metadata. Add an export/copy path
   aimed at `mateConnectorOverrides.ts` or `snapOverrides.ts`.
4. **Improve active mate controls.**
   The active mate selector works, but users need clearer viewport labels and
   a simpler way to choose which pin/mate `Q` / `E` / `F` will use.
5. **Drag-in-viewport for revolute** — currently you rotate via the Properties
   Angle slider / Q-E. A direct drag-ring on the joint axis in the viewport
   would feel more Fusion-like (reuse `rotateAroundJointLive`).
6. **Angle limits / persisted joint angle** — store an absolute joint angle on
   the mate (instead of a relative jog) and optional min/max limits.
7. **Use the Mate Editor to calibrate pins** — wire saved mate calibrations
   back into pin seat depth so 1x2/0x2/0x3 can be finalized visually (this is
   the Part D/E goal below, now partly delivered).
8. **More joint types later** — Slider, Cylindrical, and Pin-slot should wait
   until the Mate Tool is easier to use. Do not build a full multi-joint solver.
9. **Rigid connected-group movement** — moving a connected assembly as one body
   is still not implemented (parts lock individually; unlock can break stale
   mates).

## Deferred systems (from the big pin spec)

1. **Fusion-style Joint Editor (Part E)** — PARTLY DONE. The `MateEditorPanel`
   now does Fastened + Revolute with offset/angle/flip/gap + preview + Apply.
   Still missing: writing the adjustment back into pin seat metadata, and other
   joint types. Use it to finalize `needs-calibration` pins.
2. **Calibration persistence (Part D)** — DONE for mates (`mateCalibration.ts`,
   localStorage, separate from project JSON). NOT yet applied automatically to
   pin seat depth.
3. **Snap-debug seat/face plane arrows (Part J #12)** — viz to confirm gaps.

Intentionally **not** doing: an iterative contact solver / extra
`maxContactIterations` constants — the single-pass correction is exact along the
fixed contact normal (measured beam-to-beam = 0.0100). Don't re-add it.

## Visual confirms still owed (can't be checked headlessly)

Run all visual/browser checks on the local dev server:

```text
http://127.0.0.1:5173
```

Use this local URL for pointer events, snapping, Mate Tool testing,
screenshots, save/load, and localStorage/autosave checks.

- Capped pins (0x2, 0x2 spherical, 0x3): cap outside the beam, shaft through.
- 1x2 and 2x2: flange lands on the beam face.
- Easy Mode (earlier work): small-pin hit proxy; markers only on selected part.
- Electronics/control mount holes: verify that Controller, Brain, Smart Motor,
  sensors, battery, radio, and motor support caps have correctly placed front
  and back hole markers.

## Next CLI AI starter checklist

1. Read `HANDOFF.md` first, then this file.
2. Run `npm run typecheck` before editing if the workspace has changed.
3. If working on the Mate Tool, first inspect:
   `src/utils/mateConnectors.ts`, `src/types/mate.ts`,
   `src/types/assembly.ts`, `src/store/assemblyStore.ts`,
   `src/components/MateConnectorPicker.tsx`,
   `src/components/MateEditorPanel.tsx`,
   `src/components/ManualConnectorEditor.tsx`,
   `src/components/ActiveMateHighlight.tsx`, and `src/utils/projectIO.ts`.
4. Treat the Mate Tool as unfinished UX. Improve clarity and workflow before
   adding more joint types.
5. For Electronics snap tuning, inspect `src/data/snapOverrides.ts`:
   `ELECTRONICS_MOUNT_LAYOUTS`, `makeTwoSidedMountHoles()`, and
   `makeElectronicsMountSnaps()`.
6. Use Snap Debug / Show Snap Points in the browser and verify actual GLB visual
   hole positions before changing coordinates.
7. Keep all placement through `computeSnapTransform`; do not add mode-specific
   Auto Snap / Joint Mode / Pin Mode placement hacks.
8. Browser/manual tests must use `npm run dev` at
   `http://127.0.0.1:5173`.
9. After edits, run `npm run typecheck` and `npm run build`.

## Git

Active branch: `fix/cad-lite-basic-advanced-mate-editor` (off `main`, pushed; a
PR to `main` is open).

- Commit `0758b28` = CAD-lite Phase 1 (Basic/Advanced + Mate Editor) + the
  `raycast={undefined}` freeze fix.
- **Uncommitted on the same branch:** the Revolute joint (jointKind, Angle
  slider, `rotateAroundJointLive`) and these handoff doc updates. Commit them
  onto the same branch so they land in the open PR.

Earlier pin/Easy-Mode/scrutiny edits already merged via the staggered-grid PR
(`60cc3e7`). Keep `scripts/measure-pins.mjs` as a tracked utility.
