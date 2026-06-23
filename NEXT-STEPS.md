# VEX IQ Builder — Next Steps (pin-by-pin / part-by-part)

Last updated: 2026-06-23. Read `HANDOFF.md` first, then this.

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
4. Visually confirm at `npm run dev` (localhost:5173). Flip `metadataQuality`
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

## Deferred systems (from the big pin spec — not built, by design)

1. **Fusion-style Joint Editor (Part E)** — the tool to *finalize* every
   `needs-calibration` pin visually (offset/angle/flip/reorient + Apply). Build
   this before mass pin calibration; it replaces editing numbers by hand.
2. **Calibration persistence (Part D)** — localStorage overrides keyed by
   pin-profile + snap side + target; only worth it alongside the Joint Editor.
3. **Snap-debug seat/face plane arrows (Part J #12)** — viz to confirm gaps.
4. **Rigid connected-group movement** — moving a connected assembly as one
   group is still not implemented. Current behavior locks individual connected
   parts by default and allows explicit unlock.

Intentionally **not** doing: an iterative contact solver / extra
`maxContactIterations` constants — the single-pass correction is exact along the
fixed contact normal (measured beam-to-beam = 0.0100). Don't re-add it.

## Visual confirms still owed (can't be checked headlessly)

- Capped pins (0x2, 0x2 spherical, 0x3): cap outside the beam, shaft through.
- 1x2 and 2x2: flange lands on the beam face.
- Easy Mode (earlier work): small-pin hit proxy; markers only on selected part.
- Electronics/control mount holes: verify that Controller, Brain, Smart Motor,
  sensors, battery, radio, and motor support caps have correctly placed front
  and back hole markers.

## Next CLI AI starter checklist

1. Read `HANDOFF.md` first, then this file.
2. Run `npm run typecheck` before editing if the workspace has changed.
3. For Electronics snap tuning, inspect `src/data/snapOverrides.ts`:
   `ELECTRONICS_MOUNT_LAYOUTS`, `makeTwoSidedMountHoles()`, and
   `makeElectronicsMountSnaps()`.
4. Use Snap Debug / Show Snap Points in the browser and verify actual GLB visual
   hole positions before changing coordinates.
5. Keep all placement through `computeSnapTransform`; do not add mode-specific
   Auto Snap / Joint Mode / Pin Mode placement hacks.
6. After edits, run `npm run typecheck` and `npm run build`.

## Git

All snap/pin/Easy-Mode edits are **uncommitted** on
`docs/handoff-staggered-grid-invariant`. Suggested split into `fix/` branches off
`main`: (a) Easy-Mode + selection UX (hit proxy, marker gating, measured-gap
readout), (b) pin-profile rebuild, (c) scrutiny fixes (dangling-mate filter,
spherical profile, idler down-rank, capped labels). Keep `scripts/measure-pins.mjs`
as a tracked utility.
