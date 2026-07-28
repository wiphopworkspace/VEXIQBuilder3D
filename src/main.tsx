import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useAssemblyStore } from './store/assemblyStore'
import './styles.css'

// Dev-only handles for browser-driven verification (stripped from builds).
// `__vexStore` scripts scenarios; `__vexMeasure` reports the MECHANICAL
// contact geometry of a scene so a browser session can quote real measured
// gaps instead of eyeballing the render.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>
  w.__vexStore = useAssemblyStore
  w.__vexMeasure = async () => {
    const snap = await import('./utils/snap')
    const parts = await import('./data/parts')
    const contact = await import('./data/contactFrames')
    return { ...snap, ...parts, ...contact }
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
