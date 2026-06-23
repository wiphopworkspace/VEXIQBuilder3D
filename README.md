# VEX IQ 3D Assembly Builder

A lightweight, classroom-friendly VEX IQ assembly simulator that runs entirely
in the browser. Students can place robotics parts, move/rotate them, snap pins
into beam holes, save/load projects as JSON, and generate a bill of materials.

No backend, no login, no CAD kernel — just a fast local 3D prototype.

## Tech stack

- **Vite** + **React** + **TypeScript**
- **Three.js** via **@react-three/fiber** and **@react-three/drei**
- **Zustand** for state management
- JSON save/load + optional `localStorage` autosave

## Run locally

```bash
npm install
npm run analyze:ldcadvex # optional: refresh LDCadVEX taxonomy reference
npm run generate:parts   # scan the STEP folder -> src/data/generatedStepParts.ts
npm run dev              # starts http://localhost:5173
npm run build           # type-check + production build
npm run preview         # preview the production build
```

## LDCadVEX Reference Usage

The local `LDCadVEX` folder is used as a readable reference for VEX IQ
taxonomy and LDraw-style conventions only. The analyzer reads `Library/Parts.lst`
and text `.dat` headers/filenames to generate
`src/data/ldcadVexReference.ts`.

We do **not** copy LDCadVEX geometry or implementation code into the browser
app. Subparts in `Library/parts/s` are used only to identify convention names
such as `vexpinhole`, `vexpincap`, and `vexaxlehole`; they are not exposed as
selectable app parts.

Useful concepts applied from the reference:

- VEX part taxonomy, part numbers, and naming.
- LDraw hole pitch reference: 16 units between beam holes.
- Two-ended pin behavior with cap/shoulder stop faces.
- Beam holes as receiving features through part thickness.
- Axles, wheels, and gears as center-axis mates.

Refresh the reference metadata with:

```bash
npm run analyze:ldcadvex
npm run generate:parts
npm run dev
```

Accurate assembly still depends on curated snap metadata in
`src/data/snapOverrides.ts`; the generated fallbacks remain approximate.

## STEP Files and GLB Conversion

This app uses your local VEX IQ **STEP** folders as the source parts library.

> **Important:** a browser / Three.js cannot render STEP directly. STEP is a
> CAD/BREP format; WebGL renders meshes such as **GLB/glTF**. The app scans STEP
> files **only to build the parts library** (names, categories, snap points). To
> see real geometry in the viewport you must convert the STEP file to **GLB**
> first. Until then the part renders as a procedural placeholder.

### Folder layout

```
public/models/
  VEX-IQ-All-Control-STEP/        <- source STEP files (control parts)
  VEX-IQ-All-Control-GLB/         <- converted GLB for the control parts
  VEX-IQ-All-Parts-2024-11-08/    <- source STEP files (full parts catalog)
  VEX-IQ-All-Parts-GLB/           <- converted GLB for the full catalog
  thumbnails/                     <- optional generated thumbnails (.png)
```

Each STEP collection has its **own** GLB folder. The manifest generator scans
**both** STEP folders and looks for matching GLBs in the paired GLB folder:

| STEP source folder              | GLB folder searched           |
| ------------------------------- | ----------------------------- |
| `VEX-IQ-All-Control-STEP`       | `VEX-IQ-All-Control-GLB`      |
| `VEX-IQ-All-Parts-2024-11-08`   | `VEX-IQ-All-Parts-GLB`        |

### Workflow

1. **Put STEP files** in one (or both) STEP folders above.
2. **Run** `npm run generate:parts`. This scans both folders recursively,
   normalizes names, guesses a category, infers beam hole counts, checks for a
   matching GLB, and writes a typed manifest to
   `src/data/generatedStepParts.ts`.
3. **Run** `npm run dev`. Generated parts appear in the left panel under their
   category, each with a status badge:
   - **✓ GLB Ready** — a converted GLB was found and is rendered as a real model.
   - **⚠ Needs GLB Conversion** — no GLB yet, so a category-specific procedural
     placeholder is shown (still selectable, movable, snappable, saved, and
     counted in the BOM).
4. **Re-run** `npm run generate:parts` any time you add STEP files or drop in
   converted GLB files, then refresh the app.

Browser asset paths always use the Vite public root, e.g.
`/models/VEX-IQ-All-Parts-GLB/Beam 2x6.glb` — never absolute Windows paths.

### Converting STEP → GLB

1. Open the `.step` file in a tool that exports glTF/GLB — e.g. **CAD Assistant**
   (free, by the OpenCASCADE team), **FreeCAD**, or Blender (with a STEP import
   addon).
2. Export/convert to **`.glb`**.
3. Save it in the GLB folder that **pairs with the STEP source**, and keep the
   filename similar to the STEP base name. Matching ignores case, spaces,
   underscores, and hyphens, and also matches on the VEX part code, so all of
   these match `Beam 2x6.step`: `Beam_2x6.glb`, `beam-2x6.GLB`, `BEAM 2X6.glb`.

   ```
   public/models/VEX-IQ-All-Parts-2024-11-08/Beam 2x6.step
   public/models/VEX-IQ-All-Parts-GLB/Beam 2x6.glb

   public/models/VEX-IQ-All-Control-STEP/VEX IQ Smart Motor.step
   public/models/VEX-IQ-All-Control-GLB/VEX IQ Smart Motor.glb
   ```

4. Run `npm run generate:parts` again. The part's `hasConvertedModel` flips to
   `true` and the app renders the GLB instead of the placeholder. If a GLB ever
   fails to load at runtime, the app shows a warning and falls back to the
   placeholder automatically.

## How to use

- **Parts Library (left):** search and click a part to add it to the scene.
- **Toolbar:** switch between Select / Move / Rotate / Joint Mode / Pin Mode,
  toggle Auto Snap, Show Snap Points, Delete or Duplicate the selected part.
- **Viewport (center):** orbit with the mouse. In Move/Rotate mode a gizmo
  appears on the selected part.
- **Joint Mode:** click a snap point, then a compatible one on another part.
- **Pin Mode:** beam hole markers highlight — click one to insert a pin.
- **Properties (right):** Snap Settings (Auto Snap, threshold, break-on-move),
  plus the selected part's name/category, model status, LDCad reference when
  known, snap metadata source, snap-point count, connection/mate list, and the
  live Bill of Materials.
- **Top bar:** rename the project, New / Save JSON / Load JSON / Export
  Screenshot.

### Keyboard shortcuts

`V` select · `G` move · `R` rotate · `J` joint mode · `P` pin mode ·
`Esc` cancel joint pick · `Delete` remove · `Ctrl/Cmd+D` duplicate.

## Assembly Workflows

Three ways to mate parts — all use the same snap points and store the same
kind of connection. None of this is a CAD constraint solver; it is a practical
VEX IQ snap-point workflow.

- **Auto Snap** — toggle **Auto Snap: On**, select a part, and drag it with the
  Move gizmo near a compatible snap point. A green target marker and a yellow
  guide line appear and the status bar shows **“Release to snap”**; release to
  snap the part into place and record the connection. Dragging a connected part
  away past the threshold breaks the old connection (if *Break connection on
  manual move* is on).
- **Joint Mode** (`J`) — click a snap point on one part (it turns **yellow**);
  compatible snap points on other parts highlight **green** while incompatible
  ones dim. Click a green target and the first part is moved/oriented so the two
  snap points meet, and the connection is stored. `Esc` or a click on empty
  space cancels the pick.
- **Pin Mode** (`P`) — beam hole markers appear; click a hole to insert a pin,
  aligned by the pin's snap point. Occupied holes are rejected.

When both snap points carry a surface normal (e.g. a pin and a beam hole), the
moving part is also **oriented** so the pin faces *into* the hole rather than
sideways. When normals are missing, the current rotation is preserved.

**Snap Settings** (top of the right panel): Auto Snap on/off, a snap-distance
threshold slider (0.1–1.0, default 0.35), show snap points, and break-connection
on manual move.

### Limitations

- This is **not** a full CAD constraint solver and does no physics — snapping is
  a single rigid placement per mate.
- Snap points are **metadata / inferred** points, not read from the mesh.
  Converted GLB models may need **curated snap metadata** (`src/data/snapOverrides.ts`)
  for perfect alignment with visible holes.
- STEP files do not contain browser-readable snap points; the app infers them
  from the part name/category at manifest-generation time.

## Assembly Snap System

The builder assembles parts with **snap points**, not a full CAD constraint
solver or mechanical mate solver. The goal is a fast, practical VEX IQ workflow
(pins into beam holes, wheels/gears onto axles), not rigid-body simulation.

- **Snap points come from metadata/inferred defaults, not mesh analysis.**
  STEP/GLB models do not carry reliable snap metadata, so the app generates
  fallback snap points per part (`src/utils/snapPointGenerator.ts`): beam/plate
  hole rows (hole count inferred from the name, e.g. `2x6` → 6, default 6), pin
  tips, axle points, wheel/gear centers, and motor shafts.
- **Snap metadata has a visible source:** curated overrides, part definitions,
  generated fallbacks, or future bounds-inferred data. The Properties panel and
  Snap Debug labels show this source so approximate parts are easy to identify.
- **Compatibility** is type-based: holes accept pins/connectors, axles accept
  axle-holes / wheel centers / gear centers / motor shafts, etc.
- **Snap on move:** with **Snap: On**, drag a part with the Move gizmo near a
  compatible point — a yellow preview line appears, and on release the part
  snaps into place and a connection (mate) is recorded.
- **Click-to-snap:** with snap markers visible, click a snap point on one part,
  then a compatible snap point on another, to mate them.
- **Pin Mode:** highlights hole markers; click one to insert and mate a pin.
- **Show Snap Points** (toolbar) reveals all markers for debugging; hover a
  marker to see its instance / id / type in the status bar.
- **Connections** are stored in app state, saved/loaded in the project JSON
  (`version: 2`, `connections: []`), removed when a part is deleted, and shown
  in the Properties panel. Occupied holes won't accept a second pin.

Markers are colored by type (holes blue, pins green, axle/center orange, motor
shaft pink), dim red when occupied, and bright yellow while previewing a snap.

### Accuracy on converted GLB models (important)

Inferred snap points are **approximate** on real GLB parts. They are authored in
a **center-origin** local frame (the same frame the procedural placeholders use),
so the app renders each converted GLB **re-centered on its bounding-box center**.
That keeps inferred hole markers near the part's visible midline instead of along
its grounded bottom edge — but the app does **not** read true hole positions from
the mesh, and the hole row is assumed to run along the part's local X axis, which
converted STEP orientation does not guarantee. The Properties panel flags such
parts with an "Inferred snap points (approximate)" note.

For **accurate** assembly on a specific part, supply **curated snap metadata**:
add or extend that part's entry in `src/data/snapOverrides.ts`. Curated metadata
can match exact part IDs, LDCad/VEX part numbers, or fuzzy part-name patterns.
This is the recommended path — see "Automatic hole detection" below for why
deriving holes from a tessellated mesh is unreliable.

Re-snapping is non-accumulating: each snap point holds **at most one mate**, so
moving a pin from one hole to another frees the old hole, and dragging a
connected part away beyond the snap threshold breaks its mate (keeping the
occupied-hole state honest). Connections are still removed on delete and filtered
on load.

### Automatic hole detection (experimental, not used by default)

`src/utils/holeDetection.ts` is a research stub only. Detecting holes from an
arbitrary GLB/STEP-converted **mesh** is difficult and unreliable — a tessellated
mesh has no notion of "a hole", only triangles, and real feature recognition
needs the BREP topology that GLB discards. The recommended approach is curated
snap-point metadata plus the inferred defaults above. To author accurate snap
points for a specific part, override its `snapPoints` in `parts.ts` (built-ins)
or extend the generator's rules for that part name/category.

## Project structure

```
scripts/
  analyze-ldcadvex.ts           LDCadVEX Parts.lst/.dat -> reference metadata
  generate-parts-manifest.ts   STEP folder -> generatedStepParts.ts
src/
  App.tsx, main.tsx, styles.css
  components/   Layout, TopBar, Toolbar, PartsPanel, Viewport,
                ScenePart, ProceduralModel, PropertiesPanel,
                StatusBar, BillOfMaterials
  data/         parts.ts             (sample parts + combined library)
                ldcadVexReference.ts (AUTO-GENERATED LDCadVEX metadata)
                snapCalibration.ts   (VEX/LDraw-inspired app-scale constants)
                snapOverrides.ts     (curated snap metadata resolver)
                snapFactories.ts     (shared snap-point/procedural helpers)
                generatedStepParts.ts (AUTO-GENERATED from the STEP folder)
  store/        assemblyStore.ts     (Zustand state + actions)
  types/        assembly.ts
  utils/        snap.ts, projectIO.ts, screenshot.ts, geometry.ts
```

The library combines hand-authored sample parts (`BUILT_IN_PARTS` in
`parts.ts`) with the generated STEP parts. Project JSON saves only instance
data (`instanceId`, `partId`, `position`, `rotation`, `scale`, `color`) — never
raw STEP/GLB geometry.
