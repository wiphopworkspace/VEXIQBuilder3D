import { useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { PARTS } from '../data/parts'

const HIDE_KEY = 'vex-iq-coach-hidden'

function firstBeamId(): string | null {
  return (
    PARTS.find((p) => p.id === 'beam-2x6')?.id ??
    PARTS.find((p) => p.category === 'Beams')?.id ??
    PARTS[0]?.id ??
    null
  )
}

type Step = {
  n: number
  total: number
  title: string
  body: string
  cta?: { label: string; onClick: () => void }
  tip?: string
}

/**
 * Contextual "what do I do next" coach. Reads live scene state and shows a
 * single, friendly next step — a welcome when the scene is empty, then guidance
 * through adding parts, connecting them, and finishing. Dismissible, and
 * reopenable from a small pill so it never traps the user.
 */
export default function GuideCoach() {
  const parts = useAssemblyStore((s) => s.parts)
  const connections = useAssemblyStore((s) => s.connections)
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const snapEnabled = useAssemblyStore((s) => s.snapEnabled)
  const addPart = useAssemblyStore((s) => s.addPart)
  const setStatus = useAssemblyStore((s) => s.setStatus)

  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === '1'
    } catch {
      return false
    }
  })

  const hide = () => {
    setHidden(true)
    try {
      localStorage.setItem(HIDE_KEY, '1')
    } catch {
      // best-effort
    }
  }
  const show = () => {
    setHidden(false)
    try {
      localStorage.removeItem(HIDE_KEY)
    } catch {
      // best-effort
    }
  }

  const addStarterBeam = () => {
    const id = firstBeamId()
    if (!id) {
      setStatus('No beam available in the parts library.')
      return
    }
    addPart(id)
  }

  // Decide the current step from scene state.
  let step: Step
  if (parts.length === 0) {
    step = {
      n: 1,
      total: 4,
      title: "Welcome — let's build a robot!",
      body: 'Start by adding a beam. Then add more parts and snap them together.',
      cta: { label: '＋ Add a beam to start', onClick: addStarterBeam },
      tip: 'You can also click any part in the library on the left to add it.',
    }
  } else if (parts.length === 1 && connections.length === 0) {
    step = {
      n: 2,
      total: 4,
      title: 'Add a second part',
      body: 'Pick another part from the library on the left — try a connector pin or another beam.',
      tip: 'Pins go into beam holes; beams connect to each other with pins.',
    }
  } else if (connections.length === 0) {
    step = {
      n: 3,
      total: 4,
      title: 'Snap them together',
      body: easyMode
        ? snapEnabled
          ? 'Click a part and drag it so its marker meets another part’s hole, then release — it snaps into place.'
          : 'Turn on “Auto Snap: On” in the toolbar, then drag a part near a hole and release.'
        : 'Use Joint Mode (J): click one snap point, then a compatible one on another part.',
      tip: selectedId
        ? 'Facing the wrong way? Use ⟲ ⟳ Rotate or ⤵ Flip (Q / E / F) — it re-snaps automatically.'
        : 'Click a part to select it first.',
    }
  } else {
    step = {
      n: 4,
      total: 4,
      title: 'Nice — you made a connection! 🎉',
      body: 'Keep adding and snapping parts to finish your build.',
      tip: 'When you’re done: Save JSON to keep it, or Export Screenshot to share it.',
    }
  }

  if (hidden) {
    return (
      <button className="coach-pill" onClick={show} title="Show build tips">
        💡 Tips
      </button>
    )
  }

  return (
    <div className="coach">
      <div className="coach-head">
        <span className="coach-step">
          Step {step.n} / {step.total}
        </span>
        <button className="coach-close" onClick={hide} title="Hide tips" aria-label="Hide tips">
          ✕
        </button>
      </div>
      <div className="coach-title">{step.title}</div>
      <div className="coach-body">{step.body}</div>
      {step.cta && (
        <button className="coach-cta" onClick={step.cta.onClick}>
          {step.cta.label}
        </button>
      )}
      {step.tip && <div className="coach-tip">💡 {step.tip}</div>}
    </div>
  )
}
