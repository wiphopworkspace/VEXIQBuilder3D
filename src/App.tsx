import { useEffect } from 'react'
import Layout from './components/Layout'
import { useAssemblyStore } from './store/assemblyStore'
import { MOVE_STEP_PRESETS, ROTATION_STEP_PRESETS } from './utils/gridSnap'

/**
 * Q / E, and their modifiers.
 *
 * Plain Q/E is a QUARTER TURN, mated or not — that is what the shortcut has
 * always been documented as, and it is the only step that keeps a part's other
 * holes on the 0.5 hole lattice, so the thing you just turned can still be
 * pinned to something. (It briefly became 15° for mated parts, which spins a
 * hinge nicely but leaves every other hole off-lattice, and left no way at all
 * to index a mated part by 90° — Shift meant "ignore the joint".)
 *
 *   Q / E         quarter turn (on the joint when the part has one)
 *   Alt + Q / E   turn the WHOLE connected assembly a quarter turn
 *   Shift + Q / E rotate about the part's own centre, ignoring the joint
 *
 * Alt, not Ctrl: Cmd+Q quits the browser on macOS and cannot be intercepted.
 * Fine-grained hinge angles live on the Properties panel's joint Angle slider
 * and the rotate gizmo's `rotationStepDeg`, which is where a continuous control
 * belongs — a keyboard step should land somewhere you can build on.
 */
function rotateByKey(
  store: ReturnType<typeof useAssemblyStore.getState>,
  sign: 1 | -1,
  e: KeyboardEvent,
) {
  const id = store.selectedInstanceId
  if (e.altKey) {
    if (id) store.rotateConnectedGroup(id, [0, 1, 0], (sign * Math.PI) / 2)
    return
  }
  store.rotateSelectedY((sign * Math.PI) / 2, { center: e.shiftKey })
}

export default function App() {
  // Lightweight global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      // Ignore shortcuts while typing in inputs.
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }
      const store = useAssemblyStore.getState()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        store.redo()
        return
      }
      // Copy / Paste. Ctrl on Windows/Linux, Cmd on macOS. These sit AFTER the
      // editable-target guard above, so typing Ctrl+C in the project-name box,
      // the parts search, or any modal field keeps the browser's own behavior.
      // Shift is excluded so future Ctrl+Shift+C/V bindings stay free.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'c') {
          e.preventDefault()
          store.copySelection()
          return
        }
        if (k === 'v') {
          e.preventDefault()
          store.pasteClipboard()
          return
        }
      }
      // Grid presets, RoboStem-style: 1–4 pick the move grid (Fine → 2 holes),
      // Shift+1–4 the rotation step (15° → 90°), 0 / Shift+0 = free. e.code so
      // Shift+digit still reads as its digit; Ctrl/Alt+digit stays with the
      // browser (tab switching), which is why Shift replaces RoboStem's Ctrl.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^Digit[0-4]$/.test(e.code)) {
        const idx = Number(e.code.slice(5))
        if (e.shiftKey) store.setRotationStepDeg(ROTATION_STEP_PRESETS[idx].value)
        else store.setMoveStep(MOVE_STEP_PRESETS[idx].value)
        return
      }
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          store.deleteSelected()
          break
        case 'd':
        case 'D':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            store.duplicateSelected()
          }
          break
        case 'g':
          store.setMode('move')
          break
        case 'r':
          store.setMode('rotate')
          break
        case 'q':
        case 'Q':
          e.preventDefault()
          rotateByKey(store, -1, e)
          break
        case 'e':
        case 'E':
          e.preventDefault()
          rotateByKey(store, 1, e)
          break
        case 'f':
        case 'F':
          e.preventDefault()
          if (e.altKey) {
            const id = store.selectedInstanceId
            if (id) store.rotateConnectedGroup(id, [1, 0, 0], Math.PI / 2)
          } else {
            store.flipSelected({ center: e.shiftKey })
          }
          break
        case 'v':
          store.setMode('select')
          break
        case 'j':
          store.setMode('joint')
          break
        case 'p':
          store.setMode('pin')
          break
        // RoboStem-style "Connector Dots" toggle — show snap markers on every
        // part. Purely visual, so it works in Basic Mode too (the Advanced-only
        // toolbar button is just one way to flip it).
        case 'h':
        case 'H':
          store.toggleShowSnapPoints()
          break
        // Arrow-key nudge: one ACTIVE grid step on the ground plane (half
        // pitch when the grid is free), Shift+↑/↓ for vertical, Ctrl/Cmd for
        // a 0.05 fine step. No auto-snap — nudging is precise placement (see
        // nudgeSelected).
        //
        // Alt is the group modifier throughout (Alt+Q/E/F turn an assembly),
        // so Alt+arrows translate the whole assembly. A plain arrow still
        // moves one part and still refuses on a joint-locked one — that
        // refusal is the lock doing its job, and the hint it prints now names
        // this shortcut.
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          const id = store.selectedInstanceId
          if (!id) break
          e.preventDefault()
          const grid = store.moveStep > 0 ? store.moveStep : 0.25
          const step = e.ctrlKey || e.metaKey ? 0.05 : grid
          const delta: [number, number, number] =
            e.key === 'ArrowLeft'
              ? [-step, 0, 0]
              : e.key === 'ArrowRight'
                ? [step, 0, 0]
                : e.key === 'ArrowUp'
                  ? e.shiftKey
                    ? [0, step, 0]
                    : [0, 0, -step]
                  : e.shiftKey
                    ? [0, -step, 0]
                    : [0, 0, step]
          if (e.altKey) store.moveParts(store.moveGroupIdsFor(id), delta)
          else store.nudgeSelected(delta)
          break
        }
        case 'Escape':
          store.resetTool()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return <Layout />
}
