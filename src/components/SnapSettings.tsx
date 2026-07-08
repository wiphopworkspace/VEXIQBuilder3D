import { useAssemblyStore } from '../store/assemblyStore'

// One VEX hole pitch is 0.5 world units; 0.25 (half pitch) also matches the
// y=0.25 resting height, so it is the default — RoboStem's "Normal" grid.
const MOVE_STEPS = [
  { label: 'Free', value: 0 },
  { label: 'Fine', value: 0.05 },
  { label: '½ hole', value: 0.25 },
  { label: '1 hole', value: 0.5 },
  { label: '2 holes', value: 1 },
] as const

const ROTATION_STEPS = [
  { label: 'Free', value: 0 },
  { label: '15°', value: 15 },
  { label: '30°', value: 30 },
  { label: '45°', value: 45 },
  { label: '90°', value: 90 },
] as const

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
          <span className="label" title="Dragged parts move on this grid. 1 hole = 0.5 units (VEX hole pitch); Fine = 0.05. Snapping to holes still seats exactly.">
            Move step
          </span>
        </div>
        <div className="step-btns">
          {MOVE_STEPS.map((s) => (
            <button
              key={s.label}
              className={moveStep === s.value ? 'active' : ''}
              onClick={() => setMoveStep(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-steps">
        <div className="prop-row">
          <span className="label" title="The Advanced rotate gizmo turns in this angle increment. Q/E/F stay 90°.">
            Rotation step
          </span>
        </div>
        <div className="step-btns">
          {ROTATION_STEPS.map((s) => (
            <button
              key={s.label}
              className={rotationStepDeg === s.value ? 'active' : ''}
              onClick={() => setRotationStepDeg(s.value)}
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
