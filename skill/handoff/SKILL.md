---
name: handoff
description: Refresh the VEX IQ Builder handoff docs (HANDOFF.md + NEXT-STEPS.md) so the next coding agent can resume cold — summarize what changed, the current build status, the invariants, and the live worklist. Trigger on /handoff, or when the user says "write/update the handoff", "prepare a handoff", "document the state for the next agent", or "wrap up for handoff".
argument-hint: "(optional) what the next session will focus on"
---

# Handoff

Refresh the project handoff so the next agent can resume **cold**. This repo keeps
two living docs — update them **in place**, do not rewrite from scratch:

- **HANDOFF.md** — the stable reference (project goal, architecture, conventions,
  invariants). Slow-changing.
- **NEXT-STEPS.md** — the live worklist (pin-by-pin / part-by-part status tables,
  next tasks, git state). Fast-changing.

Read both first. If the user passed an argument, treat it as the next session's
focus and bias the "next tasks" toward it.

## Steps

1. **Confirm the build gate is green** before writing anything:
   - `npm run typecheck`
   - `npm run build`

   If either fails, fix it — or, if you must hand off red, record it explicitly as
   RED with the error so the next agent isn't surprised.

2. **Gather what changed** since the last handoff:
   - `git log --oneline -15` and `git status --short` (call out uncommitted work).
   - Skim the diff for behavior changes, new files, new constants, and any new
     invariant you introduced.

3. **Update HANDOFF.md** (stable reference):
   - Refresh "Current Feature State" and the "Latest verified status" line
     (build green/red, dev URL).
   - Add any new invariant you created to **"Things That Must Not Be Changed
     Casually"**.
   - Fix architecture pointers if files were added/moved/renamed.

4. **Update NEXT-STEPS.md** (live worklist):
   - Move finished items into "Recent implemented items".
   - Update the pin-by-pin / part-by-part status tables (✅ verified · 🟢
     high-confidence · 🟡 needs-calibration · 🔴 not modeled).
   - Add the next highest-value tasks, ordered.
   - Update the **Git** section: active branch, pushed vs unpushed, open PR link.

5. **Set the date** at the top of both docs to today's absolute date (convert any
   relative dates).

6. **Summarize back** to the user in 5–8 lines: build status, what changed this
   session, committed vs uncommitted, and the top 3 next tasks. Reference existing
   artifacts (files, PRs, commits) by path/URL rather than duplicating them, and
   redact any secrets (keys, tokens, PII).

## Project facts to preserve (never contradict)

- **One snap resolver:** `getSnapPoints(def)` in `src/data/snapOverrides.ts`.
  **One placement pipeline:** `computeSnapTransform` + `replaceMateForSnapPoints`
  in `src/utils/snap.ts`. Auto Snap, Joint Mode, and Pin Mode must all use it —
  a per-mode difference is a bug; fix it in the shared pipeline.
- **Staggered beam/plate hole grid** (`makeBeamGridOverrides`): total holes =
  `W·L + (W-1)(L-1)` (+1 for a 1-wide even-length beam). Never flatten to `W×L`.
  The plain-rect definition lives in `src/data/partFamilies.ts` (`parseRectPart`),
  shared by the snap grid and the Parts Library family grouping.
- **Electronics/pin mount metadata** is measured from the converted GLBs by
  headless raycasting (recentered on the bbox center, like ScenePart), but it's
  visually approximate — keep `curatedNeedsReview` where the seat depth or face
  choice isn't visually confirmed. `ELECTRONICS_MOUNT_LAYOUTS` expose ONE
  `faceAxis` per part.
- **Pin seat depth** is calibrated via the Properties → "Snap Depth Calibration"
  panel: read the Suggested override, then **Save as pin default** (persisted in
  `src/data/pinSeatOverrides.ts`, keyed `pinProfileKey:endId`, applied at
  resolution time). Code-level defaults live in `PIN_CLEARANCE` / `pinProfiles.ts`.
- **Basic-Mode Auto Snap** gates on POSITIONAL confidence (`approximate` /
  `boundsInferred` / `generatedFallback`), NOT on `curatedNeedsReview` — so every
  pin size can snap even before its seat depth is finalized.
- **R3F raycast gotcha:** NEVER pass `raycast={undefined}` to a `<mesh>` — R3F
  assigns it literally, shadowing `Mesh.prototype.raycast`, and the next raytest
  throws and freezes ALL pointer input. Use a real function on both branches
  (`DEFAULT_RAYCAST` vs `() => null`).
- **Visual checks** use the local dev server at `http://127.0.0.1:5173` (use
  `127.0.0.1`, not a deployed URL).
- **Never commit** `dist/`, `node_modules/`, `LDCadVEX/`, or STEP source folders.
  Converted GLB folders ARE committed (the deployed app needs them).

## Throwaway measurement scripts

Calibration often needs headless GLB measurement (bounding box / raycast hole
detection). Write these as throwaway scripts in `scripts/`, run with `node` /
`npx tsx`, then **delete them** — except `scripts/measure-pins.mjs`, a tracked
utility. The Zustand store and data modules import cleanly in Node (localStorage
is try/caught), so store actions can be unit-tested headlessly.
