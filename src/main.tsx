import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useAssemblyStore } from './store/assemblyStore'
import './styles.css'

// Dev-only store handle for browser-driven verification (stripped from builds).
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__vexStore = useAssemblyStore
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
