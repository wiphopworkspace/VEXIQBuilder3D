import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'

const STEP_LABELS = ['Source', 'Target', 'Apply'] as const

/**
 * On-canvas step panel for the Mate Tool (mounted by Viewport while
 * `mode === 'mate'`). Replaces the plain one-line hint with a 1-2-3 progress
 * row plus a short instruction in the "action · action · Esc" style, and a
 * clickable Cancel that mirrors Esc (`resetTool`).
 */
export default function MateStepPanel() {
  const resetTool = useAssemblyStore((s) => s.resetTool)
  const partName = (instanceId: string | null | undefined) => {
    if (!instanceId) return null
    const inst = useAssemblyStore
      .getState()
      .parts.find((p) => p.instanceId === instanceId)
    if (!inst) return null
    return getPartDefinition(inst.partId)?.name ?? inst.partId
  }
  const sourceName = useAssemblyStore((s) =>
    s.mateSource ? (partName(s.mateSource.instanceId) ?? 'part') : null,
  )
  const targetPicked = useAssemblyStore((s) => s.mateTarget != null)
  const selectedName = useAssemblyStore((s) =>
    s.mateSource ? null : partName(s.selectedInstanceId),
  )

  const step = targetPicked ? 3 : sourceName ? 2 : 1
  const instruction =
    step === 3
      ? 'Adjust offset · roll · flip in the Mate Editor, then Apply'
      : step === 2
        ? `Click a green connector to attach “${sourceName}” to · Esc restarts`
        : selectedName
          ? `Click a dot on “${selectedName}” (it moves) · or a green dot on another part to attach it there`
          : 'Click a part to see its connector dots'

  return (
    <div className="mate-steps">
      <div className="mate-steps-row">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1
          const state = n < step ? 'done' : n === step ? 'current' : 'todo'
          return (
            <span key={label} className={`mate-step mate-step-${state}`}>
              <span className="mate-step-num">{n < step ? '✓' : n}</span>
              {label}
            </span>
          )
        })}
        <button
          className="mate-steps-cancel"
          onClick={resetTool}
          title="Cancel the Mate Tool (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="mate-steps-hint">{instruction}</div>
    </div>
  )
}
