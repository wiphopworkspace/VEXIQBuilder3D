# VEX IQ Builder — Next Steps (pin-by-pin / part-by-part)

Last updated: 2026-07-04. Read `HANDOFF.md` first, then this.

This is the working to-do for finishing the connector-pin snap system and the
remaining parts. It reflects the state after the snap/pin debugging sessions.

## NEXT SESSION FOCUS — /scrutinize findings

### 2026-07-04 review (per-layer pin seats + Auto Snap overlap gate)

Outsider review of the 2026-07-04 session. Verdict: ship — no blockers; the
items below are recorded decisions and follow-ups, ordered by value:

1. **Commit the branch.** — DONE 2026-07-04 (follow-up session): committed as
   `816c581` and pushed.
2. **Silent overlap rejection (UX follow-up).** — DONE 2026-07-04 (follow-up
   session): `findNearestCompatibleSnap` takes an optional `info` out-param
   (`SnapSearchInfo.allRejectedByOverlap`); `trySnap` sets
   "Snap skipped — parts would overlap…" and both drag previews
   (`ScenePart`, `Viewport`) show "Snap blocked — parts would overlap here".
   Regression-locked in `verify:pins` section 6.
3. **Overlap gate covers rect-vs-rect only.** `rectHalfExtents` in
   `utils/snap.ts` resolves bounds only via `parseRectPart`, so Auto Snap can
   still bury a beam inside a corner beam, gear, or electronics part. Natural
   extension: carry measured GLB bboxes in the generated manifest and widen
   the collision set. Not urgent — specialty parts are rare snap targets.
4. **Recorded decision — Joint Mode bypasses the overlap gate.** `jointPick`
   places via `computeSnapTransform` directly (explicit two-click user intent),
   so an explicit same-plane pick can still create the overlap Auto Snap now
   refuses. This is deliberate — the shared-pipeline invariant covers placement
   MATH, not candidate selection. Do not re-file as a bug; optional later
   improvement is a non-blocking "parts overlap" warning status after an
   overlapping joint pick.
5. **Record only:** (a) stacked pin seats intentionally interpenetrate ≤0.020
   (the visually calibrated 1x2 convention) — renders cleanly, but any future
   export/collision feature will see overlapping solids; (b) the overlap gate
   adds sort + 1 transform + N OBB tests per pointer-move during drags — fine
   at classroom scale (~tens of parts), revisit only for very large assemblies;
   (c) plates are assumed one beam-thickness, consistent with the snap grid's
   own model.

### 2026-07-02 review (older; all items closed)

1. **Fix the Mate Tool step-1 dead-end.** — DONE 2026-07-04 (follow-up
   session): in step 1 the SELECTED part now renders its occupied dots faded
   and non-clickable (clicking one explains "Connector is occupied…"), and a
   `stepOneDeadEnd` effect in `MateConnectorPicker.tsx` sets a status when the
   selected part has zero connectors or all of them are occupied
   ("All connectors on this part are occupied (grey dots)…").
   Browser-verified with a fully-mated 1x1 pin.
2. **Add a tracked pin regression check.** — DONE 2026-07-04:
   `scripts/verify-pins.ts` + `npm run verify:pins` (50 checks): profile-match
   audit over PARTS, per-layer seat structure (counts / seat-plane spacing /
   calibrated 1x2 `pin-back-2` values pinned), 1x1/2x2/3x3 identical-seat
   equality via `insertPinAtSnapPoint`, functional stacked-seat placement at
   locked world offsets, and occupied-seat rejection.
3. **Record only — no action needed (corrections from the review):**
   - The store ALREADY rejects same-part mate targets
     (`assemblyStore.ts` `pickMateConnector`, "Pick the target connector on a
     different part") — the picker scoping there is cosmetic, not protective.
   - Camera Focus measures the whole part group, which includes the invisible
     hit proxy (min half-extent 0.2) and snap markers — `Box3.expandByObject`
     ignores `visible`, so tiny parts frame slightly loose. Cosmetic; fix only
     if framing ever looks off (would need `modelRef` plumbed into
     `groupRefs`).
   - Focus distance uses vertical FOV only — can overflow horizontally only if
     the canvas is taller than wide (unreachable in the desktop layout).
   - The 0.35 s camera tween overrides user orbit input until it finishes.
   - Simpler-alternative note: drei (already a dep) has `<Bounds>`/`useBounds`
     and `GizmoViewport` that could replace most of `CameraCommander` — switch
     rather than extend if that code grows.

## 2026-07-04 follow-up session (committed + pushed)

- **Overlap rejection is no longer silent** — scrutinize item 2 above, DONE.
  New `SnapSearchInfo` out-param on `findNearestCompatibleSnap`; release
  (`trySnap`) and both drag previews report why no snap happened.
  `verify:pins` section 6 locks the trySnap status (now 6 sections).
- **Mate Tool step-1 dead-end fixed** — 2026-07-02 item 1 above, DONE.
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs
  `npm ci` + typecheck + build + verify:pins on pushes to `main` and all PRs.
- **Dev-only store handle** — `window.__vexStore` (set in `main.tsx`, DEV
  builds only) exposes `useAssemblyStore` so browser-driven verification can
  script scenarios (add parts, insert pins, joint-pick, switch modes) instead
  of fighting 3D pointer events. Used to browser-verify the step-1 fix.
- **Preview note** — `.claude/launch.json` has a second config `vexapp2` on
  port 5191 for when another session holds 5190. HMR gotcha hit during
  verification: on the first load of a hidden preview tab the GLB Suspense can
  delay canvas-subtree commits; reload once models are cached before judging
  a UI effect "not firing".
- Verified: typecheck + build + verify:pins green; browser-verified the
  step-1 dead-end status + free-connector no-op path at the local dev server.

## 2026-07-04 session (committed as 816c581 with the two sessions below)

- **Per-layer seats on ALL pin profiles** — `sideEnds()` in `pinProfiles.ts`
  now generates one seat per plastic layer per side: 2x2 pin = 2 front + 2 back
  (`pin-front`, `pin-front-2`, `pin-back`, `pin-back-2`), 3x3 = 3+3, 2x3 idler
  = 2+3, capped 0x2/0x3 = 2/3 insert seats (a 0xN pin can finally join N
  stacked beams). Seat planes step by `beamReceivingDepth`; adjustments step by
  `PIN_CLEARANCE.stackedLayerSeatAdjustmentStep` (-0.010), which exactly
  reproduces the visually calibrated 1x2 `pin-back-2` (-0.012). The 1x1
  profile and all calibrated 1x2 values are byte-identical to before.
- **Joint-Mode pin anchor generalized** — `hasMateOnAnotherPinSeat` replaces
  the front/back-only `hasMateOnOppositePinSide`, so a pin mated at any seat
  stays anchored and the new beam moves onto it.
- **Tracked regression script** — `npm run verify:pins` (see /scrutinize item
  2 above, now DONE). 1x1/2x2/3x3 seat equality is now regression-locked.
- **Auto Snap overlap protection** — user-reported: Auto Snap could seat a
  beam in the SAME plane as a beam on a neighboring pin (hole faces are one
  beam thickness apart — the same spacing as pin layer seats — so a near-tied
  candidate pair always exists and float noise picked the winner; measured
  0.2402 deep interpenetration). `findNearestCompatibleSnap` now walks
  candidates best-first and OBB-SAT-rejects placements that would bury a rect
  part >0.05 into another rect part, rerouting to the next candidate
  (typically the stack seat). Preview + release share the gate. Locked in
  `verify:pins` section 5 (55 checks total after the follow-up session's
  section 6).
- Verified: typecheck + build + verify:pins green; browser-verified at the
  local dev server with zero console errors (4 seat markers on a lone 2x2 pin,
  full 4-beam stack on one 2x2 pin, 3-beam stack on a 0x3 capped pin,
  Properties panel lists every seat free/occupied, project save/load keeps
  layer-seat mates).
- Still owed: a visual calibration pass on stacked-seat depth for the non-1x2
  pins (they follow the 1x2 convention but only the 1x2 layer-2 seat was
  visually calibrated).

## 2026-07-02 session (committed as 816c581)

- **Camera view buttons + Focus** — `3D / Front / Top / Right / ⌖ Focus`
  buttons top-right of the viewport (`CameraCommander` in `Viewport.tsx`,
  imperative ref API like `DropPlacer`). Presets keep the orbit target +
  distance; Focus frames the selected part (or the whole assembly when nothing
  is selected) keeping the view direction; `Z` is the Focus shortcut (F = flip).
  Smooth ~0.35 s tween via `useFrame`.
- **Mate Tool guided 3-step flow** — viewport hint now shows
  `Step 1 of 3: click a part, then one of its connector dots` →
  `Step 2 of 3: click a green connector on the part to attach "<name>" to` →
  `Step 3 of 3: adjust in the Mate Editor`. Hint names the picked source part.
- **Connector picker scoped (noise fix)** — when Snap Debug is OFF,
  `MateConnectorPicker` hides occupied dots; before a source pick it shows only
  the SELECTED part's connectors (or all free ones if nothing is selected);
  after a source pick it shows only the source dot + compatible FREE targets on
  other parts, colored green (Joint-Mode convention). Snap Debug ON restores
  the full dot set (all dots, faded blocked ones — compatible free targets now
  read green there too, a deliberate color change from the old debug view).
- **Surface-pick gated behind Snap Debug** — clicking bare part geometry in
  Mate mode now just SELECTS the part (scoping the picker). It only creates an
  uncalibrated `surfaceConnector` pick when Snap Debug is on (calibration
  workflow, NEXT-STEPS item 3). Beginners can no longer silently mate through
  a surface point.
- **pin3x3 profile added (228-2500-089)** — measured: central flange z=0,
  shafts ±0.742, 3 layers/side; same seat model as the calibrated 1x1/2x2.
  Headless-verified: 1x1 / 2x2 / 3x3 seat at the IDENTICAL world transform in
  the same beam hole; browser-verified visually (flange on the beam face).
- **pin2x3 profile added (2x3 Smooth Idler, 228-2500-093)** — measured flange
  off-centre z≈−0.115, layers 2/3; auto-downranked to needs-calibration by
  `withIdlerQuality`. Inserts cleanly (offset vs 1x1 = flange −0.115 + 0.005
  adjustment delta = 0.110, matches).
- **Profile-match audit** — all 8 profiles matched only parts with "pin" in
  the name (no angle-beam/panel false positives from the `3x3`/`2x3` terms).
- `scripts/measure-pins.mjs` TARGETS now includes the 3x3 pin + 2x3 idler.
- `Z` added to the Help overlay key list.
- Verified: typecheck + build green; dev-server session with zero console
  errors (camera presets, Focus, Pin Mode 3x3 insertion, guided mate flow).

## 2026-06-28 session (committed as 816c581)

- **Electronics mount holes measured from GLBs** — `ELECTRONICS_MOUNT_LAYOUTS`
  rewritten from headless raycasting. `makeMountHoles` generalized with
  `faceAxis` + single-sided `positive`/`negative` sockets + `socketDepth`. Smart
  Motor (+Y grid, −X shaft), Brain, Bumper Switch, Touch/Distance/Color/Gyro
  sensors, Cable Anchor, Single/Dual Motor Caps now sit on real holes.
- **All pin sizes Auto Snap in Basic Mode** — pin snaps no longer flagged
  `approximate`; Basic-Mode gate now keys on POSITIONAL confidence
  (`approximate`/`boundsInferred`/`generatedFallback`), not `curatedNeedsReview`.
- **1x2 Connector Pin calibrated** — front −0.008, back −0.002, plus a new
  `pin-back-2` seat at the 2-layer back boundary (−0.012).
- **Persistent pin seat overrides** — Properties → "Save as pin default" stores
  per-end overrides in `src/data/pinSeatOverrides.ts` (localStorage), applied at
  resolution time in `getSnapPointResolution`. Defaults to the Suggested override.
- **Parts Library family cards** — plain `NxM` beams/plates collapse into a
  width family ("1×_ Beam") with a length picker (`src/data/partFamilies.ts`,
  `parseRectPart` shared with the snap grid).
- **Real VEX IQ part colors** — `vexPartColor` in `parts.ts` recolors beams,
  plates, pins, standoffs, connectors at PARTS-assembly time (survives regen).
- **Snap ghost preview** — `SnapGhost.tsx` shows a translucent pin at its
  would-be seat during an Auto Snap drag (`snapPreview.previewPosition/Rotation`).
- **Marker/joint-cue cleanup** — snap markers smaller (0.028/0.04); new
  "Show snap markers on selected part" toggle; ActiveMateHighlight dots smaller
  + uniform size + triad hidden in Basic Mode.
- **Lock/Unlock label fix** — Toolbar/Viewport now subscribe to
  `jointPositionUnlocked`, so the label/gizmo/hint follow a right-click toggle.
- **GLB load retry** — `ScenePart` now retries a transient GLB load failure
  (`useGLTF.clear` + remount, 2× backoff) before falling back to procedural, so a
  valid model isn't stuck on the placeholder box forever after one fetch/GL race.
  (Diagnosed: the axle Motor-Shaft GLBs are all valid + served 200; the fallback
  was a permanent-on-first-error bug, not a bad file.)
- **Thumbnail framing for long parts** — `thumbnailRenderer` lays an elongated
  part's long axis horizontal + frames tighter, so axle shafts read as a clear
  bar instead of a faint diagonal line that looked unloaded.

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

All pins now expose per-layer seats (2026-07-04): one seat per plastic layer
per side (`pin-front-N` / `pin-back-N`), regression-locked by
`npm run verify:pins`.

| Pin | Part # | Status | Model | What's left |
|---|---|---|---|---|
| 1x1 Connector | 228-2500-060 | ✅ | central flange z=0, layers 1/1 (2 seats) | nothing — calibrated, regression-locked |
| 1x1 Weak | 228-2500-2260 | 🟢 | shares pin1x1 | visual confirm |
| 1x1 Idler | 228-2500-073 | 🟡 | pin1x1 (down-ranked) | idlers spin free — not truly modeled |
| 2x2 Connector | 228-2500-062 | 🟢 | central flange z=0, layers 2/2, shafts ±0.47 (**4 seats**: 2 front + 2 back) | seats like 1x1 (regression-locked); stacked-seat depth follows the 1x2 convention — visual pass owed |
| 1x2 Connector | 228-2500-061 | ✅ | flange z≈−0.12, layers 1/2; seats front −0.008, back −0.002, **pin-back-2** −0.012 (3 seats) | calibrated 2026-06-28; values pinned in verify:pins |
| 1x2 Weak | 228-2500-2261 | 🟡 | shares pin1x2 | visual confirm |
| 1x2 Idler | 228-2500-098 | 🟡 | pin1x2 (down-ranked) | smooth idler, not modeled |
| 0x2 Connector | 228-2500-086 | 🟡 | **capped**, cap −Z, capInnerZ −0.19, 2 layers (**2 seats** — joins 2 stacked beams) | confirm cap sits outside + shaft depth |
| 0x2 Spherical Cap | 228-2500-090 | 🟡 | **capped** spherical, capInnerZ −0.13 (2 seats) | spherical seat approximate |
| 0x2 Idler / Weak | 228-2500-084 / -2258 | 🟡 | pin0x2 (down-ranked / capped) | idler not modeled |
| 0x3 Connector | 228-2500-087 | 🟡 | **capped**, cap −Z, capInnerZ −0.30, 3 layers (**3 seats** — joins 3 stacked beams) | confirm cap outside + shaft depth |
| 0x3 Idler / Weak | 228-2500-097 / -085 | 🟡 | pin0x3 (down-ranked) | idler not modeled |
| **3x3 Connector** | 228-2500-089 | 🟢 | central flange z=0, layers 3/3, shafts ±0.742 (**6 seats**: 3 front + 3 back) | seats identically to 1x1 (regression-locked); stacked-seat visual pass owed |
| 2x3 Smooth Idler | 228-2500-093 | 🟡 | pin2x3: flange z≈−0.115, layers 2/3 (idler, down-ranked; **5 seats**) | smooth idler — seat depth not visually reviewed |
| 0x1 Sheet Pin | 228-2500-099 | 🟡 | center mate override (shaft along X, round) | not reviewed this round — verify |

Capped-pin note: orientation (cap stays **outside** the beam, shaft drives in) is
trace-verified deterministic; only the cap-face **depth** (`capInnerZ`, ±0.015
from the profiler bins) is approximate. That is why they are `needs-calibration`.

## Other parts — part by part

| Group | Status | Notes |
|---|---|---|
| Beams/Plates (rectangular NxM) | ✅ | staggered double-grid (Grid A ∪ Grid B + 1-wide-even centre). Do not flatten. |
| Electronics / Control parts | 🟢 | mount holes now MEASURED from the GLBs (raycast) per `faceAxis`; Smart Motor/Brain/Bumper/Touch/Distance/Color/Gyro/Cable Anchor/Motor Caps on real holes. Controller/Battery/Radio/Cable have no mount grid (kept approximate). Needs a visual confirm pass; single-`faceAxis` so multi-face parts (Dual Cap) expose one face. |
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

1. **Simplify the Mate Tool UX before adding features.** — PARTLY DONE
   2026-07-02: guided 3-step hints (source part named in the hint), scoped
   picker, green compatible targets, surface picks gated behind Snap Debug.
   Still open: an on-canvas step panel, connector labels on hover, and a
   one-click "mate selected part to hovered connector" fast path.
2. **Reduce connector picker visual noise.** — DONE 2026-07-02 (see session
   notes above). Full debug view stays behind the Snap Debug toggle.
3. **Make manual connector authoring a clear calibration workflow.** — PARTLY
   DONE 2026-07-02: surface picks now require Snap Debug, so they read as a
   calibration tool. Still open: rename/copy UX for manual connectors and an
   export/copy path aimed at `mateConnectorOverrides.ts` or `snapOverrides.ts`.
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
  (0x3 stack browser-checked 2026-07-04: cap outside, 3 beams seated tight.)
- 1x2 and 2x2: flange lands on the beam face. (2x2 4-beam stack
  browser-checked 2026-07-04 — looks tight; a close-up depth pass is still
  owed for stacked seats on 2x2/3x3/2x3/0xN, which follow the 1x2 convention.)
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

Active branch: `fix/mate-connector-discovery-system` (off `main`, pushed).
No PR opened yet
(`https://github.com/wiphopworkspace/VEXIQBuilder3D/pull/new/fix/mate-connector-discovery-system`).

Pushed commits on this branch (not yet in `main`):

- `816c581` per-layer pin seats, Auto Snap overlap gate, guided Mate Tool,
  pin regression suite (the 2026-06-28 + 2026-07-02 + 2026-07-04 sessions)
- `7d3059b` revolute joint + expanded CAD-lite mate connector system
- `497b0ae` calibrate Smart Motor + Electronics mount holes from measured GLBs
- `95687e8` collapse rectangular beams/plates into family cards + length picker
- `267002d` apply real VEX IQ part colors from the kit inventory

plus the 2026-07-04 follow-up session commit (overlap-rejection feedback,
Mate Tool step-1 dead-end fix, verify:pins section 6, GitHub Actions CI,
dev-only `window.__vexStore`). The working tree should be clean; `verify:pins`
must stay green (55 checks). `corner-connectors.json` at the repo root is an
untracked local test scene — leave it untracked.

Keep `scripts/measure-pins.mjs` as a tracked utility; delete throwaway measure
scripts after use.
