import { useAssemblyStore } from '../store/assemblyStore'
import { moveStepLabel } from '../utils/gridSnap'

const MODE_HELP: Record<string, string> = {
  select: 'Click a part to select it. Drag in empty space to orbit.',
  move: 'Drag the colored arrows to move the selected part — or its whole assembly when it is joined.',
  rotate: 'Drag the rings to rotate the selected part.',
  joint: 'Click a snap point, then a compatible target, to mate. Esc to cancel.',
  pin: 'Click a beam hole to insert a pin.',
  mate: 'Pick a connector on the part to move, then a green target — or click a green dot to mate the selected part in one click. Esc to cancel.',
}

export default function StatusBar() {
  const mode = useAssemblyStore((s) => s.mode)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const snapEnabled = useAssemblyStore((s) => s.snapEnabled)
  const status = useAssemblyStore((s) => s.statusMessage)
  const count = useAssemblyStore((s) => s.parts.length)
  const moveStep = useAssemblyStore((s) => s.moveStep)
  const dragAxis = useAssemblyStore((s) => s.basicDragAxis)

  return (
    <div className="statusbar">
      <span className="mode-chip">{mode}</span>
      <span className="helper">
        {easyMode && mode === 'select'
          ? dragAxis === 'height'
            ? 'Drag a part up or down to set its height. Joined parts carry their assembly.'
            : 'Click a part, drag it on the grid plane, release near a compatible snap. Joined parts carry their assembly.'
          : MODE_HELP[mode]}
      </span>
      <span className="right">
        {status} · Snap {snapEnabled ? 'On' : 'Off'} ·{' '}
        <span title="Move grid (keys 0–4). Dragged parts keep their holes on the VEX hole lattice.">
          Grid {moveStepLabel(moveStep)}
        </span>{' '}
        · {count} part
        {count === 1 ? '' : 's'}
      </span>
    </div>
  )
}
