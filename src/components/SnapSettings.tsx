import { useAssemblyStore } from '../store/assemblyStore'
// Preset values + labels live in utils/gridSnap.ts, shared with the number-key
// shortcuts in App.tsx (index = digit key) so the buttons and keys never drift.
import { MOVE_STEP_PRESETS, ROTATION_STEP_PRESETS } from '../utils/gridSnap'

/** Compact Auto Snap / Joint settings shown at the top of the right panel. */
export default function SnapSettings() {
  const snapEnabled = useAssemblyStore((s) => s.snapEnabled)
  const toggleSnap = useAssemblyStore((s) => s.toggleSnap)
  const snapThreshold = useAssemblyStore((s) => s.snapThreshold)
  const setSnapThreshold = useAssemblyStore((s) => s.setSnapThreshold)
  const moveStep = useAssemblyStore((s) => s.moveStep)
  const setMoveStep = useAssemblyStore((s) => s.setMoveStep)
  const rotationStepDeg = useAssemblyStore((s) => s.rotationStepDeg)
  const setRotationStepDeg = useAssemblyStore((s) => s.setRotationStepDeg)
  const showSnapPoints = useAssemblyStore((s) => s.showSnapPoints)
  const toggleShowSnapPoints = useAssemblyStore((s) => s.toggleShowSnapPoints)
  const showMarkersWhileMoving = useAssemblyStore(
    (s) => s.showMarkersWhileMoving,
  )
  const toggleMarkersWhileMoving = useAssemblyStore(
    (s) => s.toggleMarkersWhileMoving,
  )
  const breakOnMove = useAssemblyStore((s) => s.breakOnMove)
  const toggleBreakOnMove = useAssemblyStore((s) => s.toggleBreakOnMove)

  return (
    <div className="prop-section snap-settings">
      <div className="prop-row">
        <span className="label">Snap Settings</span>
      </div>

      <label className="setting-row">
        <input type="checkbox" checked={snapEnabled} onChange={toggleSnap} />
        <span>Auto Snap (snap on drag release)</span>
      </label>

      <div className="setting-slider">
        <div className="prop-row">
          <span className="label">Snap threshold</span>
          <span className="value">{snapThreshold.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={snapThreshold}
          onChange={(e) => setSnapThreshold(parseFloat(e.target.value))}
        />
      </div>

      <div className="setting-steps">
        <div className="prop-row">
          <span className="label" title="Dragged parts move on this grid, hole-aligned: the part's holes land on the VEX 0.5-unit hole lattice, so holes across parts line up for pins. Keys 1–4 pick a preset, 0 = Free. Snapping to holes still seats exactly.">
            Move step
          </span>
        </div>
        <div className="step-btns">
          {MOVE_STEP_PRESETS.map((s, i) => (
            <button
              key={s.label}
              className={moveStep === s.value ? 'active' : ''}
              onClick={() => setMoveStep(s.value)}
              title={`Shortcut: ${i}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-steps">
        <div className="prop-row">
          <span className="label" title="The Advanced rotate gizmo turns in this angle increment. Shift+1–4 pick a preset, Shift+0 = Free. Q/E/F stay 90°.">
            Rotation step
          </span>
        </div>
        <div className="step-btns">
          {ROTATION_STEP_PRESETS.map((s, i) => (
            <button
              key={s.label}
              className={rotationStepDeg === s.value ? 'active' : ''}
              onClick={() => setRotationStepDeg(s.value)}
              title={`Shortcut: Shift+${i}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={showSnapPoints}
          onChange={toggleShowSnapPoints}
        />
        <span>Show snap points</span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={showMarkersWhileMoving}
          onChange={toggleMarkersWhileMoving}
        />
        <span>Show snap markers on selected part</span>
      </label>

      <label className="setting-row">
        <input
          type="checkbox"
          checked={breakOnMove}
          onChange={toggleBreakOnMove}
        />
        <span>Break connection on manual move</span>
      </label>
    </div>
  )
}
