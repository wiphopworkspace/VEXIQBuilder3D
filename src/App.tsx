import { useEffect } from 'react'
import Layout from './components/Layout'
import { useAssemblyStore } from './store/assemblyStore'

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
          {
            const selectedId = store.selectedInstanceId
            const hasMate =
              !!selectedId &&
              store.connections.some(
                (c) =>
                  c.aInstanceId === selectedId ||
                  c.bInstanceId === selectedId,
              )
            const step = !e.shiftKey && hasMate ? Math.PI / 12 : Math.PI / 2
            store.rotateSelectedY(-step, { center: e.shiftKey })
          }
          break
        case 'e':
        case 'E':
          {
            const selectedId = store.selectedInstanceId
            const hasMate =
              !!selectedId &&
              store.connections.some(
                (c) =>
                  c.aInstanceId === selectedId ||
                  c.bInstanceId === selectedId,
              )
            const step = !e.shiftKey && hasMate ? Math.PI / 12 : Math.PI / 2
            store.rotateSelectedY(step, { center: e.shiftKey })
          }
          break
        case 'f':
        case 'F':
          store.rotateSelected([1, 0, 0], Math.PI / 2, {
            center: e.shiftKey,
          })
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
        // Arrow-key nudge: half-pitch steps on the ground plane, Shift+↑/↓ for
        // vertical, Ctrl/Cmd for a 0.05 fine step. No auto-snap — nudging is
        // precise placement (see nudgeSelected).
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!store.selectedInstanceId) break
          e.preventDefault()
          const step = e.ctrlKey || e.metaKey ? 0.05 : 0.25
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
          store.nudgeSelected(delta)
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
