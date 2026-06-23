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
          store.rotateSelectedY(-Math.PI / 2, { center: e.shiftKey })
          break
        case 'e':
        case 'E':
          store.rotateSelectedY(Math.PI / 2, { center: e.shiftKey })
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
