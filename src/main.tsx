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
  // `__vexShot` drives a DETERMINISTIC close-up: it points the live R3F camera
  // at an exact world position from an exact direction at an exact distance,
  // forces one synchronous render, and reads the frame back. Orbit/auto-framing
  // never touches it, so the same call always produces the same image — which
  // is what makes a screenshot admissible as contact evidence rather than a
  // "looks about right" glance.
  w.__vexShot = async (opts: {
    target: [number, number, number]
    dir?: [number, number, number]
    distance?: number
    settleMs?: number
    name: string
  }) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) throw new Error('no canvas')
    const st = (window as unknown as Record<string, any>).__vexThree as
      | { camera: any; gl: any; scene: any; controls?: any }
      | undefined
    if (!st?.camera || !st?.gl || !st?.scene) {
      throw new Error('__vexThree not published (is DevThreeBridge mounted?)')
    }
    // Let React commit the parts added in this tick, let any newly-referenced
    // GLB finish loading (a suspended part renders NOTHING), and let R3F run a
    // real frame. Without this the synchronous render below can capture an
    // empty scene and the "evidence" would be a black frame.
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 1500))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const THREE = await import('three')
    const dir = new THREE.Vector3(...(opts.dir ?? [1, 0.55, 1])).normalize()
    const target = new THREE.Vector3(...opts.target)
    const distance = opts.distance ?? 1.1
    st.camera.position.copy(target.clone().add(dir.multiplyScalar(distance)))
    st.camera.near = 0.01
    st.camera.far = 100
    if ('fov' in st.camera) (st.camera as { fov: number }).fov = 20
    st.camera.lookAt(target)
    st.camera.updateProjectionMatrix()
    st.camera.updateMatrixWorld(true)
    st.gl.render(st.scene, st.camera)
    const dataUrl = canvas.toDataURL('image/png')
    const res = await fetch('/__pin-evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: opts.name, dataUrl }),
    })
    return res.json()
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
