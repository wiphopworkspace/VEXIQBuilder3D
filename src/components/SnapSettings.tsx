import { useAssemblyStore } from '../store/assemblyStore'

/** Compact Auto Snap / Joint settings shown at the top of the right panel. */
export default function SnapSettings() {
  const snapEnabled = useAssemblyStore((s) => s.snapEnabled)
  const toggleSnap = useAssemblyStore((s) => s.toggleSnap)
  const snapThreshold = useAssemblyStore((s) => s.snapThreshold)
  const setSnapThreshold = useAssemblyStore((s) => s.setSnapThreshold)
  const showSnapPoints = useAssemblyStore((s) => s.showSnapPoints)
  const toggleShowSnapPoints = useAssemblyStore((s) => s.toggleShowSnapPoints)
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
          checked={breakOnMove}
          onChange={toggleBreakOnMove}
        />
        <span>Break connection on manual move</span>
      </label>
    </div>
  )
}
