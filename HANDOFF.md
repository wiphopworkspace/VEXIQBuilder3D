# VEX IQ 3D Assembly Builder — Handoff

_Last updated: 2026-06-22_

A local, browser-based VEX IQ assembly simulator. Place robotics parts,
move/rotate them, snap parts together (pins into beam holes, wheels/gears onto
axles) via three workflows, save/load projects as JSON, read a bill of
materials. **No backend, no login, no CAD kernel.**

---

## Stack & run

Vite · React 18 · TypeScript · Three.js via @react-three/fiber + @react-three/drei
· Zustand. Build-time only: `occt-import-js` (OpenCASCADE WASM) + `tsx` for Node
scripts. Nothing CAD-related ships in the app bundle.

```bash
npm install
npm run analyze:ldcadvex  # scan LDCadVEX Parts.lst/.dat -> src/data/ldcadVexReference.ts
npm run generate:parts     # scan STEP folders -> src/data/generatedStepParts.ts
npm run dev                # http://localhost:5173
npm run build              # tsc -b && vite build  (MUST stay green before handing back)
npm run typecheck          # tsc --noEmit
npm run convert:glb [control|all] [--force]   # STEP -> GLB (build-time, occt)
```

There is **no test runner wired up**. Verification this session was done with
throwaway `tsx` scripts in `scripts/` (write, run with `npx tsx`, delete). The
store imports cleanly in Node (its `localStorage` calls are all try/caught), so
you can unit-test store actions headlessly. Re-use that pattern.

---

## Current state — what works

- **Parts library:** built-in sample parts + **478 generated parts** (11 control
  + 467 catalog) from two STEP folders, grouped by category, searchable. All 478
  STEP are converted to GLB and render as real models; procedural placeholder is
  the fallback when a GLB is missing/fails.
- **Editing:** add / select / move / rotate (drei `TransformControls`) / delete /
  duplicate; per-part color; live Bill of Materials; JSON save/load (v2); PNG
  screenshot; localStorage autosave.
- **Selection box** measured from the real mesh each frame (`SelectionBounds.tsx`,
  `Box3.setFromObject`) — wraps round parts and GLBs correctly, excludes markers.
- **Three assembly workflows, all using one snap pipeline (`computeSnapTransform`):**
  - **Auto Snap** (toolbar toggle) — drag a selected part in Move mode; nearest
    compatible snap within the threshold previews (green target, yellow line,
    "Release to snap"); release snaps + records the mate.
  - **Joint Mode** (`J`) — click a source snap point (yellow) → compatible targets
    highlight green, incompatible dim → click a green target → parts mate.
  - **Pin Mode** (`P`) — click a beam hole → inserts the default pin seated in it.
- **1x1 pin** snaps correctly (centered + oriented) across all three — see below.
- **Snap Debug** (toolbar) — origin axes + snap-id labels on the selected part.

Toolbar: `Select · Move · Rotate · Joint Mode · Pin Mode | Auto Snap:On/Off ·
Show Snap Points · Snap Debug | Delete · Duplicate`.
Keys: `V/G/R/J/P`, `Esc` (cancel joint pick), `Delete`, `Ctrl/Cmd+D`.
Right panel top has **Snap Settings**: Auto Snap, threshold slider (0.1–1.0,
default 0.35), show snap points, break-connection-on-manual-move (default on).

---

## Architecture / where things live

```
scripts/
  analyze-ldcadvex.ts        Scan local LDCadVEX readable catalog/.dat files
                              -> src/data/ldcadVexReference.ts. Reference
                              metadata only; no geometry/code is copied.
  generate-parts-manifest.ts   Scan both STEP folders -> generatedStepParts.ts.
                               Fuzzy GLB match, category/hole-count/snap inference.
                               RE-RUN after adding STEP/GLB files.
  convert-step-to-glb.mjs      STEP -> GLB via occt. Bakes mm->world scale
                               (0.5 units/hole), centers X/Z, grounds minY->0.
src/
  data/
    parts.ts             BUILT_IN_PARTS + generatedStepParts -> PARTS.
                         getPartDefinition(), getDefaultPinPartId(), CATEGORIES.
    generatedStepParts.ts  AUTO-GENERATED (478 parts). Do not hand-edit.
    ldcadVexReference.ts  AUTO-GENERATED LDCadVEX taxonomy/convention metadata.
                         Do not hand-edit; run npm run analyze:ldcadvex.
    snapCalibration.ts    VEX/LDraw-inspired constants mapped to app world scale.
    snapOverrides.ts     ***Curated snap-point overrides, keyed by partId.***
                         getSnapPoints(def) is the single resolver used everywhere.
    snapFactories.ts     Back-compat re-exports + proceduralForCategory.
  utils/
    snapPointGenerator.ts  Generated fallback snap points (makeBeamHoles, makePinSnaps…).
    snap.ts                Snap math + mate algebra (see "Snap system" below).
    projectIO.ts           serialize/parse project JSON (v2, connections[]).
    geometry.ts, screenshot.ts, holeDetection.ts (unused stub)
  store/assemblyStore.ts   Zustand: parts, connections, mode, snap state, all actions.
  components/
    Layout, TopBar, Toolbar, PartsPanel, Viewport, ScenePart, ProceduralModel,
    SelectionBounds, SnapPointMarkers, SnapSettings, SnapDebug, PropertiesPanel,
    StatusBar, BillOfMaterials
  types/assembly.ts        All domain types (EditorMode incl. 'joint', JointSource…).
public/models/
  VEX-IQ-All-Control-STEP/ + VEX-IQ-All-Control-GLB/      (11 control parts)
  VEX-IQ-All-Parts-2024-11-08/ + VEX-IQ-All-Parts-GLB/    (467 catalog parts)
  thumbnails/
```

Data flow: STEP → `generate:parts` → `generatedStepParts.ts` → `PARTS` → store
instances → `ScenePart` renders GLB (if `hasConvertedModel`) or procedural
placeholder.

---

## The snap system (read this before touching snapping)

**Snap points** (`SnapPointDefinition`): `{ id, type, position: Vec3 (local),
normal?: Vec3 (local), compatibleWith, radius? }`. Types: `hole, pin, axle,
axleHole, connector, motorShaft, wheelCenter, gearCenter`.

**Resolver & priority — `data/snapOverrides.ts` `getSnapPoints(def)`:**
1. curated `SNAP_OVERRIDES[def.id]`  ← author accurate parts here
2. fuzzy curated match by generated part id/name/VEX part number for common
   beams, pins, axles, wheels, and gears
3. `def.snapPoints` (built-in hand-authored, or generated fallback)
4. (future) bounds-inferred from the GLB — not built yet
Every consumer (snap math, markers, properties, pin insertion, debug overlay)
goes through `getSnapPoints`, so an override applies everywhere at once.
Snap points carry `snapSource: curated | partDefinition | generatedFallback |
boundsInferred`; Properties and Snap Debug show the source.

**Compatibility — `snap.ts` `SNAP_COMPATIBILITY` + `typesCompatible(a,b)`** (the
single source of truth, bidirectional):
`hole↔pin, hole↔connector, axle↔{axleHole,wheelCenter,gearCenter,motorShaft},
wheelCenter↔motorShaft, gearCenter↔motorShaft`. Note: **hole does NOT accept
axle** (by spec).

**Placement — `snap.ts` `computeSnapTransform(movingInstance, sourceSnap,
targetSnap, {alignNormals=true})`:**
- Seats the *source snap point itself* exactly onto the target (origin is offset
  by the rotated local snap position — never places the object origin at target).
- If **both** snaps have a `normal`, rotates the moving part so its source normal
  points **opposite** the target normal (pins face *into* holes). If either
  normal is missing, current rotation is preserved (position-only).

**The three pipelines all call `computeSnapTransform`:**
- `trySnap(instanceId)` — Auto Snap, on drag-end. Live preview computed in
  `Viewport.tsx` `onObjectChange` (uses `snapThreshold`, sets "Release to snap").
- `jointPick(instanceId, snapId)` — Joint Mode 2-click (`jointSource` state).
- `insertPinAtSnapPoint(instanceId, snapId)` — Pin Mode; builds the pin's world
  snaps, prefers `pin-center`, then runs the same transform.

**Mate invariants (DO NOT regress — `snap.ts` + store):**
- `replaceMateForSnapPoints(connections, mate)` — ≤1 mate per snap point; drops
  any existing mate reusing either endpoint before appending. Used by all 3 sites.
- `occupiedSet(connections)` — both endpoints; occupied targets are skipped in
  `findNearestCompatibleSnap` and blocked in `jointPick`/Pin Mode.
- `pruneBrokenMatesForInstance(...)` — break-on-move (gated by `breakOnMove`):
  dragging a connected part past threshold frees the stale mate.
- Delete removes related mates; duplicate drops mates; save/load (`projectIO`,
  version 2) serializes `connections[]` and filters danglers on load. v1 JSON
  (no connections) loads as `connections: []`.

**GLB rendering convention:** snap points are authored **center-origin** (like the
procedural placeholders), but `convert:glb` grounds GLBs (minY=0). So
`ScenePart.tsx` `GLBModel` re-centers each clone on its bounding-box center.
Consequence: tall parts (e.g. Robot Brain) straddle the grid plane — consistent
with procedural parts, and required for markers to land at the visible midline.

---

## The 1x1 pin fix (this session) — and the recipe to extend it

**Symptom:** the 1x1 pin sat offset (~0.25), not centered in the hole.
**Root cause:** I measured the GLB — the **1x1 Connector Pin's shaft runs along
local Z** (size ≈ `[0.23, 0.25, 0.48]`), but the generated fallback put
`pin-front` at local `[0.25,0,0]` with an **X** normal — a point *outside* the
pin body. Also `getDefaultPinPartId()` returned the first Pins entry (`0x1 Sheet
Pin`), not the 1x1.

**Fixed by:**
- Curated overrides in `snapOverrides.ts` for `1x1-connector-pin-228-2500-060`
  (`pin-center` at origin + `pin-front`/`pin-back` tips at ±0.2417 along Z,
  normals along Z) and `0x1-sheet-pin-228-2500-099` (center mate).
- `getDefaultPinPartId()` now prefers `1x1-connector-pin-228-2500-060`.
- `insertPinAtSnapPoint` rewritten to use the shared `computeSnapTransform`
  pipeline (prefers `pin-center`) — Pin Mode == Auto Snap == Joint Mode.
- `SnapDebug.tsx` overlay added to verify origin/axes/snap labels visually.
Verified headlessly: pin centers exactly (gap `0`), shaft ⟂ beam face
(`dot=-1.0`), all three pipelines produce identical placement.

## LDCadVEX Reference Usage

The local `LDCadVEX` folder was inspected as a readable reference only:
`Library/Parts.lst`, top-level `Library/parts/*.dat`, and selected text
subparts in `Library/parts/s/*.dat`. It provides VEX IQ taxonomy, part IDs,
LDraw-style naming, and useful conventions:

- beam holes repeat on a 16-LDraw-unit pitch;
- pin holes pass through part thickness;
- the 1x1 pin is two-ended/mirrored and needs cap/shoulder seating;
- axles, wheels, and gears mate along center axes.

The app does **not** copy LDCadVEX geometry, subparts, or implementation code.
Subpart names such as `vexpinhole.dat`, `vexpincap.dat`, and
`vexaxlehole.dat` are used as reference labels/constants only. Run:

```bash
npm run analyze:ldcadvex
npm run generate:parts
npm run dev
```

Generated STEP parts now carry `partNumber` and `ldcadVexFileName` when a
reference match exists. This improves category mapping and lets snap overrides
match common parts by VEX part number.

**Recipe to curate more parts (the important part for you):** the generated snap
points are unreliable for any part whose real geometry isn't an X-axis bar. To
fix a part, **measure its GLB then add an override**. glTF stores per-accessor
`POSITION` `min`/`max`; read them (parse the `.glb`: 12-byte header, then chunks
— first JSON chunk type `0x4E4F534A`) to get size / center / long axis, then
write a `SNAP_OVERRIDES['<partId>']` entry in the model's center-origin frame.
(I used a throwaway `scripts/measure-glb.mjs` for this — recreate as needed.)

---

## Known limitations / what still needs curated metadata

- Common 1-wide beams, common generated pins, generated axles, wheels, and gears
  now resolve through curated/fuzzy snap metadata. Complex beams, angled
  connectors, panels, and irregular mechanisms still need hand-authored metadata.
- Snapping is single rigid placement — **no rigid groups** (moving a connected
  part doesn't drag its neighbors; it breaks the mate if break-on-move is on).
- ~126 generated parts land in "Misc" (weak `guessCategory`).
- `holeDetection.ts` is an unused experimental stub.

---

## Recommended next steps (priority)

1. **Batch-measure & curate** the common pins and the most-used beams into
   `snapOverrides.ts` (use the recipe above). This is the highest-leverage work
   for "immediately usable assembly".
2. **In-app snap-point editor**: toggle a part into edit mode, drag a marker, read
   back local coords, write a `SNAP_OVERRIDES` entry — so non-coders can curate.
3. **Bounds-inferred GLB snap fallback** (priority-4 resolver layer): place hole
   rows from the measured bbox (mid-height, long horizontal axis) when no override.
4. Optional **rigid mates / groups** (move connected parts together).
5. Category cleanup (`guessCategory`), and perf: gitignore `public/models/*-GLB/`
   (~118 MB), code-split Three.js, virtualize the 478-card library list. The Auto
   Snap live preview rebuilds other parts' world snaps per `objectChange` — fine
   for small scenes, revisit if builds get large.

---

## Guardrails (per product direction — keep these)

No full CAD kernel. No mechanical/parametric constraint solver. No STEP/BREP
parsing or editing in the browser. No backend. No auth. Keep it a lightweight
classroom MVP. Inspect existing code and modify carefully — don't delete
unrelated files. Keep `npm run build` green and no console errors in normal use.
```
