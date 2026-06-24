import { useAssemblyStore } from '../store/assemblyStore'

const MODE_HELP: Record<string, string> = {
  select: 'Click a part to select it. Drag in empty space to orbit.',
  move: 'Drag the colored arrows to move the selected part.',
  rotate: 'Drag the rings to rotate the selected part.',
  joint: 'Click a snap point, then a compatible target, to mate. Esc to cancel.',
  pin: 'Click a beam hole to insert a pin.',
  mate: 'Click a source connector, then a target, to open the Mate Editor. Esc to cancel.',
}

export default function StatusBar() {
  const mode = useAssemblyStore((s) => s.mode)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const snapEnabled = useAssemblyStore((s) => s.snapEnabled)
  const status = useAssemblyStore((s) => s.statusMessage)
  const count = useAssemblyStore((s) => s.parts.length)

  return (
    <div className="statusbar">
      <span className="mode-chip">{mode}</span>
      <span className="helper">
        {easyMode && mode === 'select'
          ? 'Click a part, drag it on the grid plane, release near a compatible snap.'
          : MODE_HELP[mode]}
      </span>
      <span className="right">
        {status} · Snap {snapEnabled ? 'On' : 'Off'} · {count} part
        {count === 1 ? '' : 's'}
      </span>
    </div>
  )
}
