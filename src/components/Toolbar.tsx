import { useAssemblyStore } from '../store/assemblyStore'
import type { EditorMode } from '../types/assembly'
import { getPinPartOptions } from '../data/parts'

const MODES: { id: EditorMode; label: string; title: string }[] = [
  { id: 'select', label: 'Select', title: 'Select parts (V)' },
  { id: 'move', label: 'Move', title: 'Move the selected part (G)' },
  { id: 'rotate', label: 'Rotate', title: 'Rotate the selected part (R)' },
  {
    id: 'joint',
    label: 'Joint Mode',
    title: 'Click a source snap point, then a compatible target (J)',
  },
  { id: 'pin', label: 'Pin Mode', title: 'Click a beam hole to insert a pin (P)' },
  {
    id: 'mate',
    label: 'Mate Tool',
    title:
      'Mate Connector Tool: click a source connector, then a target, to open the Mate Editor (Advanced)',
  },
]

export default function Toolbar() {
  const mode = useAssemblyStore((s) => s.mode)
  const setMode = useAssemblyStore((s) => s.setMode)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const toggleEasyMode = useAssemblyStore((s) => s.toggleEasyMode)
  const snapEnabled = useAssemblyStore((s) => s.snapEnabled)
  const toggleSnap = useAssemblyStore((s) => s.toggleSnap)
  const showSnapPoints = useAssemblyStore((s) => s.showSnapPoints)
  const toggleShowSnapPoints = useAssemblyStore((s) => s.toggleShowSnapPoints)
  const snapDebug = useAssemblyStore((s) => s.snapDebug)
  const toggleSnapDebug = useAssemblyStore((s) => s.toggleSnapDebug)
  const deleteSelected = useAssemblyStore((s) => s.deleteSelected)
  const duplicateSelected = useAssemblyStore((s) => s.duplicateSelected)
  const rotateSelected = useAssemblyStore((s) => s.rotateSelected)
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const hasSelection = selectedId != null
  const isInstanceConnected = useAssemblyStore((s) => s.isInstanceConnected)
  const isJointPositionLocked = useAssemblyStore(
    (s) => s.isJointPositionLocked,
  )
  const toggleJointPositionLock = useAssemblyStore(
    (s) => s.toggleJointPositionLock,
  )
  const HALF_PI = Math.PI / 2
  const undo = useAssemblyStore((s) => s.undo)
  const redo = useAssemblyStore((s) => s.redo)
  const canUndo = useAssemblyStore((s) => s.historyPast.length > 0)
  const canRedo = useAssemblyStore((s) => s.historyFuture.length > 0)
  const selectedPinPartId = useAssemblyStore((s) => s.selectedPinPartId)
  const setSelectedPinPartId = useAssemblyStore((s) => s.setSelectedPinPartId)
  const resetTool = useAssemblyStore((s) => s.resetTool)
  const pinOptions = getPinPartOptions()
  const selectedConnected = selectedId ? isInstanceConnected(selectedId) : false
  const selectedJointLocked = selectedId
    ? isJointPositionLocked(selectedId)
    : false
  const visibleModes = easyMode
    ? MODES.filter((m) => ['select', 'joint', 'pin'].includes(m.id))
    : MODES

  return (
    <div className="toolbar">
      <button
        className={`tool-btn${!easyMode ? ' active' : ''}`}
        onClick={toggleEasyMode}
        title={
          easyMode
            ? 'Basic Mode: click parts, drag to move, release near compatible holes to snap. Click to switch to Advanced (CAD-lite) tools.'
            : 'Advanced Mode: CAD-lite Mate Connector Tool, Mate Editor, gizmo, and snap debug. Click to return to Basic Mode.'
        }
      >
        {easyMode ? 'Basic Mode' : 'Advanced Mode'}
      </button>

      <div className="divider" />

      <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">
        Undo
      </button>
      <button
        onClick={redo}
        disabled={!canRedo}
        title="Redo (Ctrl+Y or Ctrl/Cmd+Shift+Z)"
      >
        Redo
      </button>

      <div className="divider" />

      {visibleModes.map((m) => (
        <button
          key={m.id}
          className={`tool-btn${mode === m.id ? ' active' : ''}`}
          onClick={() => setMode(m.id)}
          title={m.title}
        >
          {m.label}
        </button>
      ))}

      <div className="divider" />

      <button
        className={`tool-btn${snapEnabled ? ' snap-on' : ''}`}
        onClick={toggleSnap}
        title="Auto Snap: drag a part near a compatible point to snap on release"
      >
        Auto Snap: {snapEnabled ? 'On' : 'Off'}
      </button>
      {mode === 'pin' && (
        <select
          className="toolbar-select"
          value={selectedPinPartId}
          onChange={(e) => setSelectedPinPartId(e.target.value)}
          title="Pin Mode: choose which connector pin to insert"
        >
          {pinOptions.map(({ part, profile }) => (
            <option key={part.id} value={part.id}>
              {profile?.displayName ?? part.name}
              {part.partNumber ? ` (${part.partNumber})` : ''}
              {profile?.curatedNeedsReview ? ' *' : ''}
            </option>
          ))}
        </select>
      )}
      {!easyMode && (
        <>
          <button
            className={`tool-btn${showSnapPoints ? ' active' : ''}`}
            onClick={toggleShowSnapPoints}
            title="Show snap-point markers for all parts"
          >
            Show Snap Points
          </button>
          <button
            className={`tool-btn${snapDebug ? ' active' : ''}`}
            onClick={toggleSnapDebug}
            title="Show origin axes + snap-point labels on the selected part"
          >
            Snap Debug
          </button>
        </>
      )}

      <div className="divider" />

      {selectedConnected && selectedId && (
        <button
          className={`tool-btn${selectedJointLocked ? ' active' : ''}`}
          onClick={() => toggleJointPositionLock(selectedId)}
          title={
            selectedJointLocked
              ? 'Unlock this connected part so it can be moved. Right-click the part also toggles this.'
              : 'Lock this connected part in position again. It can still rotate around the joint.'
          }
        >
          {selectedJointLocked ? 'Unlock Position' : 'Lock Position'}
        </button>
      )}

      <button
        onClick={() => rotateSelected([0, 1, 0], -HALF_PI)}
        disabled={!hasSelection}
        title="Rotate selected part 90° left (Q). Connected locked parts rotate around their joint."
      >
        ⟲ Rotate
      </button>
      <button
        onClick={() => rotateSelected([0, 1, 0], HALF_PI)}
        disabled={!hasSelection}
        title="Rotate selected part 90° right (E). Connected locked parts rotate around their joint."
      >
        ⟳ Rotate
      </button>
      <button
        onClick={() => rotateSelected([1, 0, 0], HALF_PI)}
        disabled={!hasSelection}
        title="Flip selected part 90° onto its side (F). Connected locked parts rotate around their joint."
      >
        ⤵ Flip
      </button>

      <div className="divider" />

      <button onClick={resetTool} title="Cancel the current tool or pending snap pick (Esc)">
        Cancel
      </button>
      <button onClick={deleteSelected} disabled={!hasSelection}>
        Delete
      </button>
      <button onClick={duplicateSelected} disabled={!hasSelection}>
        Duplicate
      </button>
    </div>
  )
}
