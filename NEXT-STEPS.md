# VEX IQ Builder — Next Steps (pin-by-pin / part-by-part)

Last updated: 2026-07-21. Read `HANDOFF.md` first, then this.

## 2026-07-21 session (internal Copy/Paste + Robot Brain Gen 2)

Branch `claude/copy-paste-brain-gen2-3dc068` off `main` at `5bedff9`
(**post-PR #16**, confirmed merged 2026-07-20 12:48 UTC before this branch
started). Full session record — clipboard structure, id-remapping rules,
measured Gen 2 geometry, scrutiny findings: HANDOFF "2026-07-21 session
record". PR — **merging requires user authorization**.

- **Internal Copy/Paste** (`src/utils/copyPaste.ts` + store actions,
  `Ctrl/Cmd+C` / `Ctrl/Cmd+V`, toolbar Copy/Paste buttons). Clipboard mates
  are addressed by ARRAY INDEX into the clipboard's own parts, never by
  instance id — so "a paste never reconnects to the original" holds by
  construction, and the clipboard is a true snapshot (deleting the originals
  then pasting still works). Only mates with BOTH endpoints copied are
  captured; externals are neither copied nor pruned. Fresh instance AND mate
  ids, connector refs remapped. Offset = one hole pitch on X+Z, accumulating
  +1/+2/+3, reset on Copy and on project reset. **Paste deliberately does
  not auto-snap** (it would re-grab the originals). One paste = one undo.
- **Minimal multi-select** (the app had single selection only, so multi-part
  copy was unreachable): `multiSelectIds` + a `multiSelectAnchor` that makes
  the secondary set **self-invalidating**, so all 18 existing
  `selectedInstanceId` assignment sites collapse it automatically and needed
  no edits. Gizmo/Properties/Joint/Pin/rotate/nudge still act on the primary.
- **Robot Brain Gen 2 (228-6480)** converted from the supplied STEP through
  the existing occt pipeline (588 KB GLB, no textures). The export stands the
  brain on its edge, so `convert-step-to-glb.mjs` gained a documented
  per-part `ORIENTATION_CORRECTIONS` table applied BEFORE centering and
  grounding (−90° about X) — that is what lets the corrected pose be the one
  grounded to the grid. Footprint measures **exactly 8.008 × 6.008 pitches**
  (101.7 × 76.3 mm), 34.2 mm tall, identity rotation, resting on the grid.
- **Gen 2 snap metadata is measured, not inherited**: 8 mount sockets per
  ±Z wall at an exact 0.5 pitch, y = −0.430, 0.251 deep, 0.17² — all
  different from Gen 1's y = −0.372 / 0.298 / 0.14². Independent per-wall
  occupancy; **review-gated** (`approximate` + `curatedNeedsReview`) because
  the mesh cannot prove the cavities are load-bearing and the 0.17 opening is
  narrower than a pin's 0.228 shaft. The 12 Smart Cable ports (0.5657
  spacing, NOT the structural pitch) are `NON_MECHANICAL_REGIONS`.
- **Gen 1 is untouched**: distinct id/name/model, saved Gen 1 projects load
  as Gen 1, no silent migration (regression-locked with a legacy fixture).
- **Verified**: typecheck, build, verify:pins **149** and verify:shafts
  **147** both UNCHANGED (PR #16 invariants intact), NEW verify:copy-paste
  **96** (6 sections, added to CI). Browser-verified at localhost:5190 with
  zero console errors and zero failed asset requests.
- **Found and fixed during scrutiny**: delete acted only on the primary while
  every selected part was outlined; the paste offset carried across a project
  reset.
- **Top follow-up**: clearing the Gen 2 mount-socket review gate needs
  trusted CAD or a physical part — see focus item 1b below.

## 2026-07-20 session (Joint Mode preservation hardening)

Branch `claude/vex-iq-joint-mode-hardening-804001` off `main` at `ddeb4d8`
(post-PR #15). Full session record (root causes with measured numbers,
decisions, scrutiny findings): HANDOFF "2026-07-20 session record".
Closes the four Joint Mode findings from the 2026-07-19 BaseBot
`/scrutinize` report. PR #16 — **merging requires user authorization**.

- **Root cause 1 — loose inherited tolerance + wrong question.** The
  simulated-move safety check reused the 0.35 stale-mate prune threshold
  and only asked whether the connection OBJECT survived. Repro: the
  far-face pick `pin2 pin-back → beamB hole-1` moved pin2 **0.2502**,
  flipped it to `[π, 0, π]`, and left its beam mate stored while the gap
  grew **0.0050 → 0.2552**.
- **Fix**: new `JOINT_EXISTING_MATE_MAX_ERROR = 0.12` +
  `maxPreservedMateError()` measuring the ACTUAL simulated geometry
  (`mateWorldGap`) of every mate a candidate must preserve. Deliberately
  independent from the snap-distance slider — the slider answers "has this
  mate broken?" (stays loose; drag-away is still the break gesture), the new
  constant answers "may Joint Mode bend an assembly?" (strict). The global
  slider was NOT changed.
- **Root cause 2 — marker distance on deep sockets.** The
  join-in-place/refusal gap used the visual marker. The Smart Motor socket
  marker is the MOUTH, so a correctly seated shaft measured **0.2320** and
  would be falsely refused. **Fix**: the shared helper
  `worldSnapContactPosition` (exported from `utils/snap.ts`, the promoted
  `worldTargetContactPosition`) — same seated pair now measures **0.0000**.
  No duplicate contact math in the store.
- **Root cause 3 — anchored-loop bypass** (found by this session's scrutiny
  pass, NOT in the original report): `anchoredElsewhere` ignores
  counterpart mates and the strict logic lived only in the both-anchored
  branch, so two parts mated only to each other skipped every check — a pin
  re-picked `pin-back→hole-2` teleported **1.00** and silently pruned its
  mate. **Fix**: the gate now applies to whichever part MOVES;
  `anchoredElsewhere` only ORDERS the candidates.
- **Far-face UX decision: explicit refusal, no silent remapping.** The near
  face is NOT auto-selected — the "explicit picks are trusted" invariant
  stands. Status carries the measured value.
- **Documentation corrected**: the simulated non-destructive move is the
  NORMAL WORKHORSE for aligned pattern joints; `join-in-place` is a NARROW
  SAFETY FALLBACK (both candidate moves unsafe AND contact frames already
  aligned). Section 10 asserts the plain "Joint created." status on the
  ordinary aligned case so a silent fallback fails CI.
- **Verified**: typecheck, build, verify:pins **149** (new section 10, was
  116), verify:shafts **147** (new section 10, was 133); browser-verified at
  localhost:5190 with zero console errors (all five required scenarios plus
  the Auto Snap / Pin Mode / staged roll / staged flip / occupied rejection
  / drag-away break / save-load regression sweep).
- **`verify:shafts` added to CI** (`.github/workflows/ci.yml`) — it now
  guards motor-socket placement, staged direction, and deep sockets.
- **Brain mount sockets: verification only, no metadata change.** Checked
  `mount-0`…`mount-7` (+Z wall) and `mount-0-back`…`mount-7-back` (−Z wall)
  visually against the mesh: markers sit on the base-row square cavities at
  exact 0.5 pitch, independent wall occupancy confirmed functionally (pin
  in `mount-0` at `[-1.65, 0.158, 1.501]`, re-insert rejected,
  `mount-0-back` independently accepted). Mechanical-vs-cosmetic function
  could NOT be proven from the converted mesh → `approximate` /
  `curatedNeedsReview` stay ON. No holes fabricated; cable-port exclusion
  semantics untouched.

## 2026-07-19 session (BaseBot end-to-end report fixes)

Branch `claude/vex-iq-basebot-assembly-faeefd` off `main` at `6f115ff`
(post-PR #14). Full session record (root causes, measurements, decisions):
HANDOFF "2026-07-19 session record". The user built the whole 2nd-gen
BaseBot in-app and filed a 9-area report; this session fixed the
correctness core:

- **Peg mates keep the staged roll** (`rollStepDeg: 90` on corner-connector
  pegs — was: forced exact-up, 90° off physical, pre-rotation ignored).
- **Joint Mode teardown protection**: generalized anchor rule + simulated
  candidate moves + join-in-place (tolerance 0.12) + explicit refusal —
  multi-pin patterns (motor × 4 pins, hub × 4 pins) now over-constrain
  safely instead of teleporting the part and silently pruning mates.
  [HARDENED 2026-07-20 — the safety check inherited the loose 0.35 prune
  threshold and only tested prune SURVIVAL (so a far-face pick still
  stretched a stored mate), and it was skipped entirely for two parts
  mated only to each other. See the 2026-07-20 session above.]
- **`alignMode: 'nearest'`** on symmetric shaft mates — a staged 180° flip
  (capped shaft cap-outboard) survives; the motor socket stays fixed.
- **Robot Brain re-measured**: the old 6 "mount holes" were the Smart Cable
  PORT band (0.55 spacing — why two pins never aligned); real mounts are
  8 × 0.5-pitch square sockets per ±Z wall at y=−0.372 with INDEPENDENT
  wall occupancy (`mount-N`, new `sides: 'walls'`); port bands are now
  NON_MECHANICAL_REGIONS.
- **Washer**: pin-hole pair + shaft support bore (Ø0.16 × 0.030 measured);
  **2x2 Center Offset Round Lock Beam**: center square drive bore authored
  (0.12² × 0.465 along Y) — old focus item 5's lock-beam sub-item is DONE.
- **Verified**: typecheck, build, verify:pins 116 (new section 9),
  verify:shafts 133 (new section 9), browser at localhost:5191 zero
  console errors (staging, refusal, join-in-place, flip, brain walls,
  washer, lock beam all live-checked).
- **Not fixed, by evidence or scope** (see focus list): triple-connector
  leg holes (meshes have peg-only walls — do NOT fabricate), 2nd-gen parts
  pack, rigid group move, station-vs-flush quantization, tire↔hub, cable
  ports, collision feedback (recorded decision).

## 2026-07-15 session (IQ Smart Motor square-output-socket fix)

Branch `claude/iq-motor-shaft-placement-ec425e` off `main` at `6913caa`
(post-PR #13). Full session record (root cause, calibration values,
verification detail): HANDOFF "2026-07-15 session record".

- **Bug**: shafts snapped into the Smart Motor's SIDE Smart Cable port. The
  2026-07-14 socket calibration had raycast-probed the -X end (inheriting
  the legacy "−X shaft" assumption) and measured the CABLE PORT cavity
  (0.44 × 0.38 — an electrical connector) as the drive socket.
- **Fix (root cause, not thresholds)**: `SHAFT_CALIBRATION.motorSocket`
  re-authored from the mesh — the real square output socket is on the TOP
  (+Y) face at [-0.375, 0.9936, 0] (0.148² axis-aligned opening, floor
  y 0.7574, depth 0.236, seated 0.232, axis (0,-1,0), up (1,0,0)). Snap id
  `motor-shaft` unchanged.
- **Cable port excluded semantically**: new exported
  `NON_MECHANICAL_REGIONS` in `snapOverrides.ts` + a `resolveSnapPoints`
  filter drop ANY snap inside the port volume for every non-authored layer
  (curated/measured/supplemental/fallback) — regeneration can't bring it
  back.
- **Second false affordance fixed**: mount-grid point `hole-1` sat ON the
  square socket (pins could snap into the drive). Removed; surviving mount
  holes keep their original ids via per-point pinned ids (`hole-0`,
  `hole-2`…`hole-11`).
- **Tests**: verify:shafts updated (new socket/insertion expectations) +
  NEW section 8 — exactly one powered socket, port-region coverage, no
  candidate in the port, seating in 5 motor orientations (THREE-computed
  expected transforms), rotated save/load.
- **Verified this session**: typecheck PASS, build PASS, verify:pins PASS
  (97), verify:shafts PASS (8 sections); browser-verified at localhost:5190
  with zero console errors (straight + flanged motor-shaft seating exact,
  occupied-socket + cable-port + mount-hole + pin-vs-socket rejections,
  90°-rotated motor re-seat exact, save/load drift-free).

## 2026-07-14 session (VEX IQ shaft-placement calibration pass)

Branch `claude/vex-iq-shaft-calibration-bb351b` off `main` at `fb4a674`
(post-PR #12). Full design + calibration values: HANDOFF "Shaft System".

- **Dedicated shaft semantics** (no reuse of the `hole`/pin profiles): new
  types `shaftEnd` + `shaftSupportBore`; `motorShaft` re-semanticized as the
  drive SOCKET (accepts shaft ends only — pins/idlers/centers rejected);
  `axleHole` now used for square driven bores; `axle` = body stations.
  New module `src/data/shaftProfiles.ts` (calibration + factories + the
  reviewable `SHAFT_SPECS_BY_PART_NUMBER` table covering all 44 shaft parts).
- **Smart Motor socket calibrated from the mesh** (raycast probe, not bbox):
  mouth x=-1.110, center (y,z)=(-0.4725,0), floor x=-0.621, socketDepth
  0.489, seated depth 0.485. [SUPERSEDED 2026-07-15: that -X opening is the
  SMART CABLE PORT, not the socket — see the 2026-07-15 session above for
  the corrected TOP-face calibration.] Seating solves via the socket's
  `facePosition` = SEATED plane, so shafts never float at the mouth and the
  math is direction-independent (pin seat-frame pattern) — that mechanism is
  unchanged and still current.
- **Stops**: capped shafts emit no end snap on the cap side; Motor Shaft
  flanges stop exactly at the socket mouth (insertion 0.18) via per-end
  `stopOffset` seat planes; stations are clamped clear of caps/flanges/ends
  so a standard 0.25-thick component can't overlap them.
- **Quarter-turn indexing**: `rollStepDeg: 90` quantizes the mate roll to the
  NEAREST 90° (residual ≤45°, preview-stable, no 180° flips) for square-drive
  pairs; support bores have no up → roll never locked, mates tagged
  `jointKind: 'revolute'` (Angle slider spins them).
- **Support bores**: every beam/plate grid hole emits `hole-N-shaft` at the
  hole center sharing the pin faces' occupancy group (pin XOR shaft per
  physical hole). Bushing 125 = support bore + barrel connector (was WRONGLY
  a connector pin); collars 143/168 = Y-axis bores (were fake axle rows);
  snap shafts 091/092 = shaft ends (were pins).
- **Bore false affordances fixed** (2026-07-13 item 2, partially): pulleys
  10/20/30/40mm, lock beams (141/1141, 140/1140, 161/1159, 1548), drop cams
  1305/1306 now have authored square `shaft-bore` snaps composed with their
  real measured pin holes (original mhole indices preserved); supplemental
  holes are guarded at resolution time against shaft-family bores + a
  reviewed skip list (091, 2220).
- **UX**: status messages say motor-driven / rotation-locked / free-spinning;
  SnapGhost draws a color-coded dashed axis line through the receiving
  socket/bore; shaft candidates outrank generic holes in scoring.
- **Verified this session**: typecheck PASS, build PASS, verify:pins PASS
  (97, unchanged), NEW verify:shafts PASS (~80 checks); browser-verified at
  127.0.0.1:5190 with zero console errors (motor insertion exact for
  straight/capped/motor shafts, driven placement on stations with
  quarter-turn indexing, revolute beam supports, Basic-Mode drag auto-snap
  into the socket, pin rejection, save/load round trip with 0 drift).
  audit:holes NOT re-run (measured tables untouched by design).

## 2026-07-13 session (fix-then-ship pass on the measured-hole layer)

Branch `claude/suspicious-franklin-77db98` (worktree
`robostem-cad-continuation-54c5a1`). The 2026-07-12 mesh-audit work was
transferred here from the `claude/part-hole-joint-check-60f770` worktree
(same base commit `be4cdda`; that worktree's uncommitted copy is now
SUPERSEDED — do not commit it separately). This session landed the two
/scrutinize merge blockers and made the Basic-Mode decision:

- **Outdated-connection load reporting** (/scrutinize item 1, DONE):
  `parseProject` (`src/utils/projectIO.ts`) takes an optional
  `ProjectParseInfo` out-param (the `SnapSearchInfo` pattern) counting
  connections dropped because a saved endpoint no longer resolves;
  `loadProject` (`assemblyStore.ts`) appends
  `— N outdated connection(s) removed` to the existing
  `Loaded "<name>" (history cleared)` status. Loading is never interrupted;
  valid mates load unchanged. Browser-verified via a real
  save → doctor-one-snap-id → load round trip.
- **Measured-layer regression checks** (/scrutinize item 4, DONE):
  `verify:pins` grew from 55 to 97 checks (sections 7 + 8). Section 7 pins,
  resolver-only (no GLB parsing): 1x8 Ballista Arm (3 physical Y-axis holes
  — also locks the removed fabricated 8-hole row), 2x2 45° Beam (Z-axis),
  7x9x11 Triangle Truss Plate (24 holes), 60 Tooth Gear (gearCenter
  survives + 14 supplemental holes + no mhole within 0.12 of the axle bore).
  Asserted per part: mhole id form, `hole` type, pin compatibility,
  `approximate`/`curatedNeedsReview` flags, front/back pairs sharing one
  occupancy group offset only along the hole axis, inward-axis /
  outward-normal signs, receiving depth, and one pinned sample position
  (0.02 drift tolerance). Section 8 locks the load-reporting behavior
  (counts, kept-mate integrity, singular/plural status wording).
- **Basic-Mode decision (/scrutinize item 2, DECIDED): measured holes KEEP
  `approximate: true`.** Browser evidence (127.0.0.1:5190 dev server, zero
  console errors, screenshots taken): pins seat EXACTLY on measured holes of
  the truss plate (incl. the diagonal member), 45° beam (front + 180°-flipped
  back face; occupancy group rejects the opposite face), 60T gear
  (supplemental, z=0.13/0.095 on thick/thin webs), and the 3-way
  perpendicular plate (X-axis hole pin rotated (90°,90°,0°)) — positions are
  trustworthy. BUT with the flag flipped (local experiment, reverted), a
  Basic-Mode drag snapped a pin INTO the 10mm Pulley's axle bore and INTO
  the 30mm Pulley's (0,0) center bore over its 4 real face holes. False
  snapping would be common on rotating parts, so the flag stays until the
  bore-classification pass (below). Decision + rationale recorded next to
  the flag in `makeMeasuredHoleSnaps` and in HANDOFF.
- Verified this session: typecheck PASS, build PASS, verify:pins PASS
  (97 checks). audit:holes NOT re-run (no measured-table change).

## 2026-07-12 session (full mesh hole audit + measured hole layer)

Branch `claude/part-hole-joint-check-60f770`. User request: check every
part's hole/joint positions and add every hole in every part.

- **New tracked tool `npm run audit:holes`** (`scripts/audit-part-holes.ts`):
  headless GLB raycast audit (parity + flood fill, 3 axes, 0.025 grid) of
  detected pin-sized through-holes vs `getSnapPoints(def)`; `--emit`
  regenerates `src/data/measuredPartHoles.ts`; a filter arg prints per-part
  hole detail. Writes `scripts/hole-audit-report.json` (git-ignored).
- **Audit verdicts (478 meshes)**: staggered beam/plate grid, electronics
  layouts, and corner-connector tables all EXACT (0 position errors > 0.05).
  The loose "1xN in the name" beam-row inference fabricated holes on ~12
  specialty beams (Ballista Arm, Linear Motion Beam, crank arms, corner
  beams…) — branch now restricted to the part-number table; those parts get
  measured sets instead.
- **Measured hole layer**: `MEASURED_PART_HOLES` (1,744 holes / 191 parts,
  full sets for previously fallback-only parts: specialty beams, trusses,
  panels, plastic sheets, turntable housings, game elements, misc) +
  `MEASURED_SUPPLEMENTAL_HOLES` (332 holes / 47 parts appended to curated
  parts: gear/wheel face holes, standoff cross-holes, Dual Motor Cap's extra
  faces). Two-sided `mhole-N`/`mhole-N-back` pairs, `approximate` +
  `curatedNeedsReview` (Pin/Joint/Advanced snap live; Basic drag-snap gated
  pending visual pass). Supplemental emission keeps 0.12 clearance from
  existing same-axis snap features so axle bores never become pin holes.
- **Post state**: 444/478 parts fully consistent (was 223). Residuals are
  by-design: ~22 suppressed gear/wheel center bores, blind-socket marker
  sets, occluded corner-connector holes, 2 curved nose panels (angled holes
  invisible to axis-aligned rays).
- Verified: typecheck + build + verify:pins (55) green; browser-verified at
  127.0.0.1:5190 with zero console errors — 1x1 pin inserted into the 2x2
  45° Beam's `mhole-0` seated at exactly beam+(−0.075,−0.175)+z 0.125 and
  into the 60 Tooth Gear's supplemental `mhole-4` at (−0.25,−0.25)+z 0.13,
  mates created through `computeSnapTransform`, markers on real holes,
  save/load round-trip keeps `mhole-*` mates.
- Follow-ups: visual calibration pass over high-value measured parts (flip
  needs-review off via the Snap Authoring Tool as they're confirmed); angled
  holes on sloped panels need hand authoring.

This is the working to-do for finishing the connector-pin snap system and the
remaining parts. It reflects the state after the snap/pin debugging sessions.

## NEXT SESSION FOCUS — recommended next steps (2026-07-21)

PRs #14, #15 and #16 are all MERGED (`main` is at `5bedff9`). The 2026-07-21
Copy/Paste + Brain Gen 2 work is on `claude/copy-paste-brain-gen2-3dc068`
(see the session entry above). Remaining work, grouped:

### Merge blockers

1. **Merge the Copy/Paste + Brain Gen 2 PR** (USER AUTHORIZATION required):
   branch `claude/copy-paste-brain-gen2-3dc068`, based on `main` at
   `5bedff9`. CI gates are now typecheck + build + verify:pins +
   verify:shafts + **verify:copy-paste** (added this session). All three
   verify suites green (149 / 147 / 96), browser-verified at localhost:5190
   with zero console errors. See the 2026-07-21 session entry above.

1a. ~~**Merge the Joint Mode hardening PR #16**~~ — DONE, merged
   2026-07-20 12:48 UTC as `5bedff9`.

1b. **Clear (or confirm) the Brain Gen 2 mount-socket review gate.** The 8
   sockets per ±Z wall sit on an exact 0.5 pitch at y = −0.430 (0.251 deep,
   0.17 square), but the converted mesh cannot prove they are load-bearing
   rather than cosmetic, and the 0.17 opening is NARROWER than a 1x1 pin's
   0.228 shaft — so a pin visually embeds rather than seating in a bore.
   Needs trusted CAD or a physical 2nd-gen brain. Same standing question as
   the Gen 1 brain (2026-07-20); resolve both together. Until then
   `approximate` + `curatedNeedsReview` stay ON and Basic-Mode drag-snap
   stays gated.

### BaseBot report backlog (from the 2026-07-19 user report, prioritized)

1b. **Rigid connected-group movement** (report #4, user's top-3): the
   manual's build-module-then-attach flow needs moving a connected
   subassembly as one body. Suggested shape: compute the connected
   component over `connections`, apply one world-space delta to every
   member (drag + Q/E), release seats the grabbed part via trySnap and
   applies the same delta to the rest. RoboStem parity: Ctrl+G grouping.
1c. **2nd-gen BaseBot parts pack** (report #1) — PARTIALLY RESOLVED
   2026-07-21: the **2nd-gen Robot Brain (228-6480) is now in the library**
   (see the session entry above). Still missing: the 200mm Travel Omni
   Wheel, the 2nd-gen Battery, and 200mm Smart Cables. Each needs a source
   STEP dropped in and run through `npm run convert:glb` — a content task,
   not a code task, and the Brain Gen 2 pass is the worked example
   (including the `ORIENTATION_CORRECTIONS` hook for exports that are not
   authored resting-side-down). Substitutes that work today: 200mm tire +
   Large Wheel Hub (64mm).
1d. **Station quantization vs flush mounting** (report #7): shaft stations
   are 0.5-pitch quantized, but a wall-flush motor puts the shaft ~0.08
   off-station (flanged stop adds 0.05) — seat the shaft and the motor
   hangs by 0.13, or pin the motor and the socket mate goes stale by 0.12.
   Needs either continuous axial seating on the shaft body (clamped to the
   usable span) or station phase derived from the mated socket. Touches
   the station occupancy model — design first.
1e. **Tire ↔ hub mating** (report #5): tires are unmated props —
   `wheelCenter` only accepts `axle` and the hub occupies the station.
   Suggested: a `hubRim` snap on wheel hubs that the tire's center accepts
   (new compat pair), occupancy separate from the hub's axle bore.
1f. **Corner-connector layout lattice pass** (report #8): triple-connector
   hole tables are ~0.01 off the 0.25 lattice (e.g. 1254: 0.242 between
   holes) — small, but it compounds across joints. Regularize spacing to
   exact lattice steps while keeping each part's measured phase.
1g. **Cable-port semantics** (report #5, step 19): Simulated Cable has one
   generic hole snap; Brain/Motor ports are now NON_MECHANICAL_REGIONS.
   If cable routing should ever be buildable, it needs a dedicated
   port/plug snap-type pair (electrical, not mechanical). Low priority —
   decorative today.
1h. **Joint Mode collision feedback** (report #9): RECORDED DECISION
   2026-07-04 stands (explicit picks bypass the overlap gate); the
   optional improvement remains a non-blocking "parts overlap here"
   warning status after an overlapping joint pick.
1i. **Triple corner connector leg holes** (report #5, step 20): the
   converted meshes (1250/1251/1253) have PEG-ONLY walls — no through-
   holes to author (probe-verified 2026-07-19). Do NOT fabricate. If the
   real 2nd-gen part differs, it arrives with the parts pack (1c).

### Bore classification follow-ups (false-positive protection)

2. **Remaining axle-bore false affordances** (2026-07-13 item, PARTIALLY
   resolved — pulleys/lock beams/cams are FIXED with authored bores):
   still-open suspects: `small/large-turntable-center-bushing` ((0,0) axis-1
   mholes), `1-5x-pitch-screw-segment-cw` ((0,0)), `xl-turntable-*-bushing`
   center bores, and the Differential Gear's axis-0 cross-bore (a REAL
   through-bore its output shafts pass through — should become a
   `shaftSupportBore`, not a pin hole). Same fix pattern as this pass:
   authored bore in `SHAFT_BORE_OVERRIDES` + composed measured holes.
3. **Flip `approximate: false` on measured holes AFTER #2** — one line in
   `makeMeasuredHoleSnaps` (+ the verify:pins section 7 flag assertion,
   changed together). Keep `curatedNeedsReview` regardless.

### Shaft catalog expansion / calibration follow-ups

4. **Visual pass on the needs-review shaft bores**: drop cams 1305/1306
   (pivot positions from ±0.01 raycast clusters), rubber collars 143/168
   (bore axis assumed Y, mesh bore closed), Shaft Bushing barrel seat depth.
   Flip `curatedNeedsReview` off as confirmed.
4b. **Motor Snap Shaft seating vs the shallow mesh socket** (found
   2026-07-15, non-blocking): the snap shafts' finger stop (0.4595 from the
   tip on 328) exceeds the measured socket depth (0.236), so they now seat
   floor-limited with the flange above the motor face. The GLB floor is
   dead-flat at y=0.7574 (likely a converted-STEP simplification of the real
   deeper latch cavity). If the visual ever matters, verify against trusted
   CAD and consider a per-kind deeper stop. Also: the procedural
   `motor-placeholder`'s approximate socket still uses the old 0.489/0.485
   depths (`makeZAxisMotorShaftSnap`) — fine for a fake part, but tidy it if
   touched.
5. **Shaft support/driven bores on specialty parts**: `1x4 Bearing Surface
   Block (228-2500-314)` (bores not detectable along Z — probe other axes),
   ~~`2x2 Center Offset Round Lock Beam (228-2500-1925)`~~ DONE 2026-07-19
   (center square drive bore authored from a depth-map probe — see the
   session entry), worm gear, differential housings, turntables. Also:
   support bores are currently emitted ONLY on the beam/plate grid — the
   measured-hole layer (`mhole-*`) does not emit them yet; extending it
   would let shafts pass through trusses/panels too.
6. **Thick-hub stop realism**: station clamps assume 0.25-thick components;
   a wheel hub (0.755 thick) seated at an end station can still clip a cap.
   Model per-component hub half-thickness if it ever matters visually.
7. **Multi-station occupancy**: a wide hub occupies one station; neighboring
   stations stay claimable, so two thick parts can overlap. Overlap gate
   only covers rect-vs-rect today.

### UX improvements

8. **Axial-slide drag polish**: dragging a gear along a shaft steps between
   0.5-pitch stations (station-granular sliding). Optional: half-pitch
   stations or continuous slide-with-quantize for a smoother feel; also a
   dedicated highlight for the receiving socket mouth (the ghost + axis line
   exist; the socket marker itself doesn't glow).
9. Previous UX backlog unchanged: RoboStem group/submodel (Ctrl+G), LDraw
   export/import, Snap Authoring polish (gizmo drag, mated-instance warns).

### Motion follow-ups

10. **Drive animation**: free-spinning support mates are now tagged
    `revolute` and motor mates are identified (`shaftMateKind`) — a future
    motion pass can spin the motor-driven shaft + everything
    rotation-locked to it, while supports stay still. The semantics are in
    place; no solver exists.

### Older backlog (still valid, from 2026-07-13)

11. **Visual calibration pass over high-value measured parts** (45° beams,
    corner beams, trusses, gear face holes, standoffs) — flip needs-review
    off via the Snap Authoring Tool as parts are confirmed.
12. **`2x7 Landing Gear Panel` metadata fix (targeted)** — miscategorized as
    a gear, carries a fabricated `gearCenter`; fix category, rerun
    `npm run audit:holes -- --emit`, diff. Do NOT expand into a full
    category cleanup.
13. **Obsolete snap-id migration (optional, low priority)** — load reporting
    may be enough.
14. Optional cleanup: capped 0x2/0x3 `metadataQuality` flip after a real
    zoom; `@types/node` type-scope containment; `PartsPanel`
    baked-thumbnail `assetUrl` routing.

Audit coverage note: `npm run audit:holes` remains the DEEP verification
tool (full GLB raycast, ~minutes) — slower than the normal suite and not a
CI gate. Fast measured-hole invariants are now covered by `verify:pins`
section 7 on every CI run; reach for audit:holes only when measured tables
or hole-detection logic change.

## 2026-07-12 /scrutinize findings (mesh-audit review)

Outsider review of the measured-hole-layer session. Verdict was
fix-then-ship; the 2026-07-13 session closed it out:

1. **Silent mate pruning at scale** — DONE 2026-07-13 (load status reports
   removals; verify:pins section 8 locks it).
2. **Basic-Mode drag Auto Snap ignores measured holes** — DECIDED
   2026-07-13: stays gated (`approximate: true`) until the bore
   classification pass; see the session notes and focus items 2–3.
3. **False-affordance center bores** — CONFIRMED in-browser 2026-07-13
   (10mm/30mm pulley); now focus item 2 with concrete part ids.
4. **No CI regression on the measured layer** — DONE 2026-07-13
   (verify:pins section 7, 97 checks total).
5. **Recorded, no action:** the supplemental 0.12 clearance guard trusts
   bogus primary snaps (the miscategorized "2x7 Landing Gear Panel" carries
   a fabricated `gearCenter` that can suppress one real near-center hole);
   traced-and-confirmed correct: measured-hole frame conventions match
   makeMountHoles/beam-grid, authored sets bypass the supplemental append,
   the generator classifies with `includeMeasured: false` so regeneration
   never feeds on its own output, and per-call set construction matches the
   existing `parsePlainRectGrid` cost profile.

## 2026-07-11 session (VEX IQ-native hole-lattice grid movement)

Branch `claude/vex-iq-grid-snapping-069d48` off `main` (post-PR #10), with
`feat/grid-snapping` (PR #9) merged in (NEXT-STEPS docs conflict resolved).
User request: optimize the CAD-style grid movement for intuitive drag/drop/
snap with native VEX IQ pin-and-hole alignment.

- **Hole-lattice quantization** (`src/utils/gridSnap.ts`): Basic-Mode drags
  (`ScenePart.moveEasyDrag`, reference cached per drag) and drag-to-place
  drops (`Viewport.handleDrop`) now quantize `position + rotate(refHole)`
  instead of the raw origin, so the part's HOLES land on the world lattice.
  Reference = snap point nearest the origin, averaged across its
  `occupancyGroup` (cancels the ±0.12008 through-hole face offset).
  Rationale: bbox-center origins are not on the hole grid for even-length
  beams or electronics (Bumper Switch holes at ±0.75/±0.25), so origin
  quantization stranded holes off-lattice and pins had no exact hole pair.
  See the HANDOFF invariant "Grid quantization is HOLE-registered".
- **Preset keys**: `0`–`4` = move grid Free/Fine/½ hole/1 hole/2 holes,
  `Shift+0`–`4` = rotation step Free/15/30/45/90° (`e.code`-based; Shift
  replaces RoboStem's Ctrl because browsers reserve Ctrl+digit). Shared
  `MOVE_STEP_PRESETS`/`ROTATION_STEP_PRESETS` arrays (index = digit) feed
  both the keys and the SnapSettings buttons (now with shortcut tooltips).
- **Grid-linked arrow nudge**: arrows move one ACTIVE grid step (0.25 when
  free); Ctrl fine 0.05 unchanged; no auto-snap, lock refusal unchanged.
- **Ground grid mirrors the step**: `Viewport` Grid cell = moveStep (≥0.25)
  else 0.5 hole pitch; sections stay whole multiples. StatusBar gained a
  persistent `Grid <label>` chip; HelpModal lists the new keys.
- Verified: typecheck + build + verify:pins (55) green; browser-verified
  with zero console errors — in-page unit tests of the lattice math (odd/
  even beams ref (0,0,0); Bumper ref (−0.75, −0.25) hole-exact at
  0/90/180/270°; pin shoulder −0.035 compensated), synthetic Basic-Mode pin
  drag stepping x ≡ 0 / z ≡ 0.035 (mod 0.25) with live preview and the
  calibrated mate seated on release (pin z = 0.12508), preset keys, nudge,
  and the StatusBar/panel UI.
- Advanced move gizmo stays origin-quantized (three.js `translationSnap`
  has no phase hook); its releases still seat through `trySnap`. Recorded
  in HANDOFF.

## 2026-07-06 session-2 /scrutinize findings (deploy-config review)

Outsider review of PR #5 (deploy workflow + `assetUrl`). Verdict: ship — the
only blocker is outside the code (the pending Pages enablement). Traced: all
four GLB loader call sites route through `assetUrl` (ScenePart `useGLTF` +
`useGLTF.clear`, SnapGhost, thumbnailRenderer) with consistent cache keys;
dev behavior byte-identical (BASE_URL `/`). Open follow-ups, ordered:

1. **Verify the first real deploy end-to-end.** The failed run died at
   `configure-pages`, BEFORE `upload-pages-artifact` and `deploy-pages` — so
   those two steps have never executed. After the Pages toggle + re-run,
   confirm the run goes green AND the live URL loads GLB parts.
2. **Latent: baked-thumbnail path bypasses `assetUrl`**
   (`src/components/PartsPanel.tsx` line ~45, `encodeURI(def.thumbnailPath)`).
   Currently inert: all 478 manifest entries set `thumbnailPath`, but
   `public/models/thumbnails/` holds only a README, so the `<img>` 404s even
   in dev and falls back gracefully (onError → SVG → runtime thumbnail). If
   thumbnails ever get baked, they would work in dev and 404 ONLY on Pages.
   Fix at that time: route through `assetUrl`.
3. **Latent: `@types/node` is global to the src program.** Root
   `tsconfig.json` has no `"types"` field, so Node globals now typecheck in
   browser code (a stray `process.env.X` would compile and be `undefined` at
   runtime; Vite does not polyfill `process`). Typecheck is currently green.
   Minimal fix options: `"types": []` in the root tsconfig (vite/client
   still arrives via `src/vite-env.d.ts`), or drop the dep and use a local
   `declare const process` in `vite.config.ts`.
4. **Nit: hardcoded base path.** `deploy.yml` sets
   `VITE_BASE_PATH: /VEXIQBuilder3D/`; a repo rename silently breaks asset
   URLs. Optional: derive it from `${{ github.event.repository.name }}`.
5. **Recorded decisions (no action):** Vercel would avoid the subpath
   entirely but requires account setup the agent cannot do; a relative Vite
   base (`./`) would NOT remove the need for `assetUrl` (the manifest paths
   are absolute `/models/...`); GitHub Pages + BASE_URL rebase is
   right-sized. CI and deploy both build on pushes to `main` (~40 s
   duplicated) — accepted.

## Research reference — RoboStem CAD (researched 2026-07-08)

`https://cad.rbscad.org` — "RoboStem Cad", a free browser-based CAD app
specifically for VEX IQ. RESEARCH DONE 2026-07-08 (the /learn/ guides are
thin marketing pages; the real findings came from mining the app's public JS
bundle for UI strings — no code was copied). Key findings, for future UX
rounds:

- **Guidance = one transient tip line per mode**, always short and
  `·`-separated with an explicit Esc affordance: "Click a hole to add pins ·
  Esc to stop", "Click viewport to place · Esc to cancel", "Selected · move ·
  rotate · nudge · delete". No wizards, no multi-line panels. (Adopted for
  our Mate step panel + hints, 2026-07-08.)
- **Snapping**: pin/hole `snapClass` feature pairing detected from LDraw
  primitives (`vexpinhole.dat` etc.), axis-alignment constraints, and
  transient `snapIndicators` (highlight dots) during drags. Snap is a
  TOGGLE (`S`); part-snap and grid-snap are separate toggles.
- **Grid/rotation snap presets**: grid 32/8/4/1 LDU on keys `1–4`, rotation
  1/5/15/30° on `Ctrl+1–4`.
- **Keys**: `P` pin-placement mode ("Click a hole to add pins" — continuous
  until Esc, like our Pin Mode), `H` Connector Dots toggle ("Highlight
  connection points on parts"), `B` BOM, `V` 2D ortho view, `C` center
  camera, Tab toggles move/rotate, arrow keys nudge, Shift+arrows roll.
  Keybinds are user-configurable with presets ("Classic", "LDCad Mouse").
- **BOM**: grouped by category, per-row count + "N placed", Export CSV.
  (CSV export + part numbers adopted into our BOM panel 2026-07-08.)
- **Structure**: Group/Ungroup (Ctrl+G), "Convert selection to subfile",
  submodel editing; LDraw MPD/LDR/DAT import/export; path-traced render
  export; auto-save to browser; view cube; rotate-angle badge during
  rotation drags.

Treat it as a reference for feature/UX research only — do not copy code or
assets.

## Closed review findings (history)

### 2026-07-04 review (per-layer pin seats + Auto Snap overlap gate)

Outsider review of the 2026-07-04 session. Verdict: ship — no blockers; the
items below are recorded decisions and follow-ups, ordered by value:

1. **Commit the branch.** — DONE 2026-07-06: committed as `816c581` and
   pushed.
2. **Silent overlap rejection (UX follow-up).** — DONE 2026-07-06:
   `findNearestCompatibleSnap` takes an optional `info` out-param
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

1. **Fix the Mate Tool step-1 dead-end.** — DONE 2026-07-06: in step 1 the
   SELECTED part now renders its occupied dots faded
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

## 2026-07-09 session (Pages live; Visual Snap Authoring Tool; H + nudge keys)

Branch `feat/snap-authoring-tool` off `main` (post-PR #8). PR #9 was NOT
merged (user's call) and this branch does not include it.

- **GitHub Pages is LIVE.** The user enabled Pages (Source: GitHub Actions)
  and the deploy run triggered by the PR #8 merge succeeded (2026-07-08
  16:24 UTC). Verified end-to-end 2026-07-09: index 200 with subpath asset
  URLs, GLB fetch 200 `model/gltf-binary`. NEXT SESSION FOCUS item 1 from
  2026-07-08 is closed; no agent action was needed beyond verification.
- **Visual Snap Authoring Tool** (HANDOFF Recommended Task #1) — DONE, see
  the new HANDOFF "Visual Snap Authoring Tool" section for the full design:
  - `src/data/authoredSnapOverrides.ts`: localStorage per-part snap sets +
    pure helpers (derived frames, mirror, unique ids, export snippet)
  - authored sets resolve FIRST in `getSnapPointResolution` as
    source 'curated' + `authored` flag (recorded decision: no new
    `SnapMetadataSource` member — the union ripples through connector
    quality, Basic-mode gating, and projectIO validation)
  - `SnapAuthoringPanel.tsx` (Toolbar → Snap Author, Advanced only):
    edit-a-copy, per-point field editing with auto-derived mate frames,
    add-at-origin, surface pick (hit proxy non-raycastable while armed),
    duplicate, mirror-face with shared occupancy group, 0.25 grid snap,
    Copy JSON (paste-ready SNAP_OVERRIDES entry) / Download JSON, revert
  - markers on the selected part are click-to-select while authoring
    (orange highlight); `snapAuthoringVersion` re-renders all consumers
  - pin-profile parts are blocked (pins calibrate via profiles/seat
    overrides — 1x1 invariants preserved)
  - browser-verified: seeded a 14-point copy of `beam-2x6`, edited hole-0
    X to −1.3, and a real Pin Mode insertion seated the pin at exactly
    −1.3 through `computeSnapTransform`; occupied-hole rejection works on
    authored points; mirror produced the flipped face with shared group;
    surface pick placed a top-face point with correct local frame; revert
    restored built-ins; zero console errors
- **H connector-dots toggle + arrow-key nudge** (RoboStem parity):
  - `H` toggles snap markers on all parts, Basic Mode included
  - arrows nudge 0.25 on the ground plane, Shift+↑/↓ vertical, Ctrl 0.05
    fine; one undo step per keypress via `nudgeSelected`; stale mates break
    per breakOnMove; joint-locked parts refuse with the unlock hint;
    deliberately NO auto-snap after a nudge
  - browser-verified including undo and the locked-pin refusal
- Verified: typecheck + build + verify:pins (55) green on both commits.

## 2026-07-09 session (CAD-style grid move / rotation snapping)

Branch `feat/grid-snapping` (stacked on `feat/mate-ux-step-panel`, PR #8).
User-requested RBSCAD/SnapCAD-style incremental movement. Snap-to-part,
the drag ghost preview, and the settings panel already existed — the new
work is the grid layer:

- **Store**: `moveStep` (world units, 0 = free, default **0.25** = half a
  hole pitch — RoboStem's "Normal 8 LDU" equivalent, and the y=0.25 resting
  height stays on-grid) and `rotationStepDeg` (0 = free, default **15°**),
  with `setMoveStep` / `setRotationStepDeg`.
- **Basic-Mode plane drag** (`ScenePart.moveEasyDrag`): quantizes the
  dragged x/z to the absolute world grid (3-decimal float cleanup). Release
  still seats exactly through `trySnap`/`computeSnapTransform` — the grid
  only paces the drag; part-snap overrides it.
- **Advanced gizmo** (`Viewport`): passes `translationSnap` / `rotationSnap`
  (three.js-native) to `TransformControls`.
- **Drag-to-place drop** (`Viewport.handleDrop`): drops on the same grid.
- **Settings panel** (`SnapSettings`): "Move step" presets
  Free / Fine 0.05 / ½ hole 0.25 / 1 hole 0.5 / 2 holes 1.0 and
  "Rotation step" presets Free / 15° / 30° / 45° / 90° (`.step-btns` CSS).
- **Robustness fix found during verification**: `setPointerCapture` /
  `releasePointerCapture` in the Easy-drag handlers now guard against the
  spec'd NotFoundError for inactive pointers (real case: `pointercancel`
  mid-drag — the throw skipped `trySnap` AND leaked the open history
  transaction; also unblocks synthetic-pointer testing).
- Verified (instrumented synthetic drags at the dev server, zero console
  errors): mid-drag positions step on exact 0.25 multiples; clicking Free
  in the panel restores continuous movement (knob is causal); with the grid
  on, a pin drag previews live ("Release to snap…") and releases into the
  exact calibrated seat (0.25, 0.25, −0.1251) with the mate created —
  "Parts snapped together". typecheck + build + verify:pins (55) green.
- Q/E/F stay 90° by design (documented in Help); the rotation step applies
  to the Advanced rotate gizmo.

## 2026-07-08 session (Mate Tool UX increment + RoboStem research)

Branch `feat/mate-ux-step-panel` off `main`. The recorded worklist item
("on-canvas step panel + connector hover labels + one-click fast path") is
DONE, shaped by the RoboStem CAD research (see the research section above):

- **On-canvas Mate step panel** — new `src/components/MateStepPanel.tsx`
  (mounted by `Viewport` while `mode === 'mate'`, replacing the plain
  text hint): a 1-2-3 chip row (Source → Target → Apply; done steps get a
  green ✓, current is highlighted) + one short RoboStem-style instruction
  line + a clickable ✕ Cancel that calls `resetTool` (same as Esc).
- **Connector hover labels** — `MateConnectorPicker` now renders a drei
  `<Html>` tooltip on the hovered dot: connector label (+ ⚠ when
  needs-calibration) and ONE state line ("Occupied", "Not compatible with
  source", "Click to attach “<part>” here", "Click to pick — this part
  moves"). The status bar gets the same classroom-readable line; the old
  developer dump (source kind, snap id, score) now shows only with Snap
  Debug on.
- **One-click quick-mate fast path** — in step 1 with a part selected, free
  compatible connectors on OTHER parts render green and clickable; clicking
  one auto-picks the best free compatible connector on the selected part
  (`mateConnectorScore` + distance) and jumps straight to the Mate Editor.
  Both picks run through `pickMateConnector`, so the guided flow and the
  fast path stay one code path. Compatibility-scoped: two bare beams show
  NO green dots (hole↛hole); a selected pin turns every free beam hole
  green.
- **BOM depth (RoboStem parity)** — `BillOfMaterials.tsx` now shows the VEX
  part number per row and has an **Export CSV** button
  (`Part,Part Number,Count`, filename `<project>-parts.csv`) so a digital
  build maps back to a real kit.
- **Pin Mode hint** gained "· Esc to stop"; `StatusBar` mate help updated.
- Verified: typecheck + build + verify:pins (55) green; browser-verified at
  the local dev server with zero console errors — step panel states 1→3,
  hover tooltip + status text, quick-mate click (synthetic pointer event on
  a green dot → pin-back ↔ hole-0 pair in the Mate Editor → Apply created
  the connection), ✕ Cancel resets the tool, CSV content + filename
  intercepted and checked.
- Pages deploy: re-checked, STILL blocked on the one-time UI enablement
  (Pages API 404; deploy runs fail at `configure-pages`).

## 2026-07-06 session 2 (PR #4 merged; deploy config on PR #5)

- **PR #4 merged to `main`** — the whole
  `fix/mate-connector-discovery-system` branch (7 commits) is in `main`;
  CI ran green on the PR (typecheck + build + verify:pins).
- **GitHub Pages deploy config** — branch `feat/github-pages-deploy`,
  PR #5 (merged by the user 2026-07-06; first deploy run failed on Pages
  enablement — see NEXT SESSION FOCUS item 1):
  - `.github/workflows/deploy.yml` builds with
    `VITE_BASE_PATH=/VEXIQBuilder3D/` and deploys `dist/` to Pages on every
    push to `main` (`configure-pages` `enablement: true` creates the site on
    first run — the local OAuth token cannot, it 404s on the Pages API).
  - `vite.config.ts` takes `base` from `VITE_BASE_PATH` (dev unchanged);
    `@types/node` added for the `process.env` typing.
  - new `src/utils/assetUrl.ts` rebases the manifest's absolute
    `/models/...` paths onto `import.meta.env.BASE_URL`. ALL GLB loader call
    sites (ScenePart `useGLTF` + `useGLTF.clear`, SnapGhost,
    thumbnailRenderer) must keep going through it — mixed keys break the
    useGLTF cache and the retry path.
- **GLB asset-size review** — 480 committed GLBs, 116.3 MB total
  (111.4 MB parts + 4.9 MB control); median ~149 KB, 13 files >1 MB, largest
  3.6 MB (12x12 Plate). Loaded on demand per placed part / lazy thumbnails,
  so a classroom page load never pulls the full library. Serve as-is from
  Pages; Draco/meshopt or asset packs remain optional. The ~600 MB STEP
  sources under `public/models` are git-ignored, so CI's clean checkout
  never ships them (a LOCAL `vite build` does copy them into `dist/` —
  deploy only from CI).
- **Visual calibration pass — all "visual confirms still owed" items closed**
  (scripted via `window.__vexStore`, verified numerically + top-view
  screenshots at 127.0.0.1:5190; NO code changes needed):
  - 2x2 + 3x3 full stacks (4 and 6 beams): flange pair gap exactly
    0.25016 (= 0.24016 + the 0.010 clearance); stacked-layer gaps
    0.22016/0.23016 (0.020 / 0.010 pre-loads, within the recorded ≤0.020
    convention). Visually flush solid blocks, no floats, no burials.
  - 2x3 smooth idler: all 5 seats mate, same gap convention, off-center
    flange lands on the beam face (pin z = 0.23508). Stays 🟡 (idler).
  - Capped 0x2 / 0x2 spherical / 0x3: insertion flips the pin
    (rot 180,0,180) so the cap-inner plane lands EXACTLY on the beam outer
    face (+0.12008) — cap outside, shaft through N beams, tip flush; layer
    seats at 0.23016 steps. Confirmed in close-up for 0x2; Properties panel
    occupancy correct (N insert layers + "Cap side: fixed").
  - Electronics: Brain (2 rows of 6 markers on the mounting flanges) and
    Smart Motor (markers centered on the visible top-face holes) confirmed
    on-screen. Bumper Switch re-raycast headlessly: exactly 4 through-holes
    at (±0.75, ±0.25), matching `ELECTRONICS_MOUNT_LAYOUTS['228-2677']` to
    3 decimals — the 4 inset top-face circles are switch-mechanism bosses,
    not holes; the markers near the edges are correct.

## 2026-07-06 session (committed as bc2c4da, pushed)

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
  `verify:pins` section 5 (55 checks total after the 2026-07-06 section 6).
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
| 2x2 Connector | 228-2500-062 | ✅ | central flange z=0, layers 2/2, shafts ±0.47 (**4 seats**: 2 front + 2 back) | seats like 1x1 (regression-locked); stacked-seat visual pass DONE 2026-07-06 (gaps 0.25016/0.22016, flush) |
| 1x2 Connector | 228-2500-061 | ✅ | flange z≈−0.12, layers 1/2; seats front −0.008, back −0.002, **pin-back-2** −0.012 (3 seats) | calibrated 2026-06-28; values pinned in verify:pins |
| 1x2 Weak | 228-2500-2261 | 🟡 | shares pin1x2 | visual confirm |
| 1x2 Idler | 228-2500-098 | 🟡 | pin1x2 (down-ranked) | smooth idler, not modeled |
| 0x2 Connector | 228-2500-086 | 🟡 | **capped**, cap −Z, capInnerZ −0.19, 2 layers (**2 seats** — joins 2 stacked beams) | confirm cap sits outside + shaft depth |
| 0x2 Spherical Cap | 228-2500-090 | 🟡 | **capped** spherical, capInnerZ −0.13 (2 seats) | spherical seat approximate |
| 0x2 Idler / Weak | 228-2500-084 / -2258 | 🟡 | pin0x2 (down-ranked / capped) | idler not modeled |
| 0x3 Connector | 228-2500-087 | 🟡 | **capped**, cap −Z, capInnerZ −0.30, 3 layers (**3 seats** — joins 3 stacked beams) | confirm cap outside + shaft depth |
| 0x3 Idler / Weak | 228-2500-097 / -085 | 🟡 | pin0x3 (down-ranked) | idler not modeled |
| **3x3 Connector** | 228-2500-089 | ✅ | central flange z=0, layers 3/3, shafts ±0.742 (**6 seats**: 3 front + 3 back) | seats identically to 1x1 (regression-locked); stacked-seat visual pass DONE 2026-07-06 (6-beam stack flush) |
| 2x3 Smooth Idler | 228-2500-093 | 🟡 | pin2x3: flange z≈−0.115, layers 2/3 (idler, down-ranked; **5 seats**) | smooth idler — seat depth not visually reviewed |
| 0x1 Sheet Pin | 228-2500-099 | 🟡 | center mate override (shaft along X, round) | not reviewed this round — verify |

Capped-pin note: orientation (cap stays **outside** the beam, shaft drives in) is
trace-verified deterministic; only the cap-face **depth** (`capInnerZ`, ±0.015
from the profiler bins) is approximate. That is why they are `needs-calibration`.

## Other parts — part by part

| Group | Status | Notes |
|---|---|---|
| Beams/Plates (rectangular NxM) | ✅ | staggered double-grid (Grid A ∪ Grid B + 1-wide-even centre). Do not flatten. MESH-AUDIT-CONFIRMED 2026-07-12 (0 position errors). |
| Electronics / Control parts | 🟢 | mount holes MEASURED (raycast) per `faceAxis`; audit-confirmed 2026-07-12. Dual Motor Cap's other-face holes now covered by supplemental measured holes. Controller/Battery/Radio/Cable have no mount grid (kept approximate). |
| Specialty beams (corner, right-angle, truss, angle, lock, crank…) | 🟡 | measured hole sets from the 2026-07-12 mesh audit (`measuredPartHoles.ts`) — real raycast positions, needs-review until a visual pass; the old fabricated 1xN rows are gone |
| Panels / plastic sheets / trusses / game elements / misc | 🟡 | measured hole sets (same audit); angled holes on sloped panels not detectable — hand-author those |
| Shafts (straight/capped/motor/snap, 44 parts) | ✅ | full shaft semantics 2026-07-14: measured lengths, usable `shaftEnd`s (capped/flanged sides excluded), clamped stations, motor-socket seating — regression-locked by `verify:shafts` |
| Smart Motor drive socket | ✅ | RE-calibrated 2026-07-15: TOP-face square socket at (−0.375, 0.9936, 0), depth 0.236; accepts shaft ends only; the −X Smart Cable port is a non-mechanical exclusion region |
| Pulleys / lock beams / drop cams / bushing / collars | 🟢 | authored square `shaft-bore` / support-bore snaps (cams + collars + bushing barrel flagged needs-review for a visual pass) |
| Gears / Wheels | 🟢 | curated center snaps now quarter-turn driven bores (`rollStepDeg: 90`, axle-only compat) + supplemental measured FACE holes; center bores excluded from pin holes |
| Standoff / corner connectors | 🟡 | corner connectors measured (tables+pegs, audit-confirmed); standoffs keep pin-seat model + measured cross-holes where they exist; blind end sockets still unmodeled |

## Interaction / locking status

- Connected parts are position-locked by default. They should not drag away in
  Easy Mode or with the Move gizmo while locked.
- Locked connected parts can still rotate around the active joint point.
- Right-click a connected part or use the toolbar Lock/Unlock Position button to
  temporarily unlock/relock movement.
- When a part is snapped again, its position is relocked.
- This is not rigid-group movement: unlocking and moving one connected part can
  still break stale mates.
- **CAD-style grid snapping (2026-07-09, PR #9):** free dragging is now
  quantized. `moveStep` (default 0.25 world units = half a hole pitch; 0 =
  free) paces the Basic-Mode plane drag, the Advanced move gizmo
  (`translationSnap`), and drag-to-place; `rotationStepDeg` (default 15°;
  0 = free) drives the Advanced rotate gizmo (`rotationSnap`). Q/E/F stay
  90°. The grid only PACES the drag — release still seats exactly through
  `trySnap`/`computeSnapTransform`, so part-snap overrides the grid.
  Presets live in the Snap Settings panel (`SnapSettings.tsx`).

## Next steps for the Mate / Joint system (highest value first)

1. **Simplify the Mate Tool UX before adding features.** — DONE through the
   recorded increment: 2026-07-02 guided 3-step hints, scoped picker, green
   compatible targets, surface picks gated behind Snap Debug; 2026-07-08
   on-canvas step panel (`MateStepPanel.tsx`), connector hover labels, and
   the one-click "mate selected part to clicked green connector" fast path.
   Next candidates live in NEXT SESSION FOCUS item 3 (RoboStem-inspired).
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

ALL items below were confirmed in the 2026-07-06 session-2 pass (see that
session's notes for the measured numbers). Remaining visual debt:

- ~~Capped pins (0x2, 0x2 spherical, 0x3): cap outside, shaft through~~
  DONE 2026-07-06 (cap-inner plane exactly on the beam face; only the
  GLB-vs-`capInnerZ` ±0.015 residual is unverified — needs a real zoom).
- ~~Stacked-seat depth close-up on 2x2/3x3/2x3/0xN~~ DONE 2026-07-06.
- ~~Electronics mount holes (Brain, Smart Motor, Bumper measured set)~~
  DONE 2026-07-06. Controller/Battery/Radio/Cable keep a single approximate
  center marker by design (no mount grid on the real part).
- Easy Mode (earlier work): small-pin hit proxy; markers only on selected
  part — still unreviewed.
- Motor support caps (Single/Dual) were not individually re-checked; they
  share the measured `faceAxis` pipeline (Dual Cap exposes one face only).

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

- `main` contains PR #4, PR #5, PR #6/#7 (docs), PR #8
  (`feat/mate-ux-step-panel`, merged 2026-07-08), PR #10
  (`feat/snap-authoring-tool`, merged 2026-07-10), PR #11
  (`claude/vex-iq-grid-snapping-069d48`, hole-lattice grid movement, merged
  2026-07-12), PR #12 (`claude/suspicious-franklin-77db98`, measured-hole
  layer + fix-then-ship, merged before 2026-07-14), and PR #13
  (`claude/vex-iq-shaft-calibration-bb351b`, shaft calibration pass, merged
  as `6913caa`) — all with green CI.
- PR #14 (`claude/iq-motor-shaft-placement-ec425e`, the 2026-07-15 Smart
  Motor socket fix) was MERGED as `6f115ff`.
- PR #15 (`claude/vex-iq-basebot-assembly-faeefd`, the 2026-07-19
  BaseBot-report fixes) was MERGED as `ddeb4d8`.
- The 2026-07-20 Joint Mode preservation hardening is COMMITTED on
  `claude/vex-iq-joint-mode-hardening-804001` (worktree
  `vex-iq-joint-mode-hardening-804001`, off `main` at `ddeb4d8`), 5
  commits: `9a6f5d3` fix(joints) strict preservation + contact frames,
  `e4d471e` test(joints) refusal/join-in-place/loop bypass, `6b07e02`
  test(shafts) seated socket re-pick, `00338e6` ci verify:shafts, plus the
  docs commit. Modified `src/utils/snap.ts`, `src/store/assemblyStore.ts`,
  `scripts/verify-pins.ts`, `scripts/verify-shafts.ts`,
  `.github/workflows/ci.yml`, `HANDOFF.md`, `NEXT-STEPS.md`. Typecheck +
  build + verify:pins (149) + verify:shafts (147) green on the committed
  state; browser-verified at localhost:5190 with zero console errors.
  Pushed; open as PR #16
  (https://github.com/wiphopworkspace/VEXIQBuilder3D/pull/16). Merging
  requires user authorization.
- GitHub Pages is LIVE at
  `https://wiphopworkspace.github.io/VEXIQBuilder3D/` (enabled by the user;
  deploys run on every push to `main`; verified 2026-07-09).
- `gh` CLI is installed (winget) and authenticates via the Git Credential
  Manager token (`git credential fill` → `GH_TOKEN`). That token can create
  PRs and merge USER-authorized PRs, but cannot enable GitHub Pages (404 on
  every Pages API call), and the workflow GITHUB_TOKEN can't either
  ("Resource not accessible by integration" on create) — only the web UI
  toggle works for first-time enablement.

`verify:pins` (149 checks) AND `verify:shafts` (147 checks) must both stay
green — both are CI gates as of 2026-07-20.
`scripts/hole-audit-report.json` is regenerable audit output and is
git-ignored.

Keep `scripts/measure-pins.mjs` and `scripts/audit-part-holes.ts` as tracked
utilities; delete throwaway measure scripts after use.
