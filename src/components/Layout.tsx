import { useEffect, useState } from 'react'
import TopBar from './TopBar'
import Toolbar from './Toolbar'
import PartsPanel from './PartsPanel'
import Viewport from './Viewport'
import PropertiesPanel from './PropertiesPanel'
import StatusBar from './StatusBar'
import HelpModal from './HelpModal'
import MateEditorPanel from './MateEditorPanel'
import SnapAuthoringPanel from './SnapAuthoringPanel'

/**
 * Below this width the three-column desktop layout stops working: the parts
 * library and properties panels together take 520px, which on an iPad in
 * portrait (768px) leaves ~250px of viewport — not enough to build in. At and
 * below it the two side panels become overlay drawers instead, so the whole
 * screen is the model. 1180 rather than 1024 because a landscape iPad Pro
 * (1194) is only barely wide enough and reads far better with drawers too.
 */
const DRAWER_BREAKPOINT_PX = 1180

function useDrawerLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT_PX}px)`).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT_PX}px)`)
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    // Rotating an iPad fires this, so the layout follows the orientation
    // instead of being decided once at load.
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

export default function Layout() {
  // The live WebGL canvas, lifted up so the TopBar can export screenshots.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const drawers = useDrawerLayout()
  const [partsOpen, setPartsOpen] = useState(false)
  const [propsOpen, setPropsOpen] = useState(false)

  // Back on a wide screen both panels are docked again, so any half-open
  // drawer state would linger as a stuck overlay.
  useEffect(() => {
    if (!drawers) {
      setPartsOpen(false)
      setPropsOpen(false)
    }
  }, [drawers])

  // Only one drawer at a time: on a tablet they each cover most of the screen,
  // and two stacked would hide the model entirely.
  const openParts = (open: boolean) => {
    setPartsOpen(open)
    if (open) setPropsOpen(false)
  }
  const openProps = (open: boolean) => {
    setPropsOpen(open)
    if (open) setPartsOpen(false)
  }

  return (
    <div className={`app${drawers ? ' app-drawers' : ''}`}>
      <div>
        <TopBar canvas={canvas} onHelp={() => setHelpOpen(true)} />
        <Toolbar />
      </div>

      <div className="app-body">
        {/* Hidden from assistive tech while closed; `visibility: hidden` in the
            drawer CSS is what takes it out of the tab order, since a drawer
            merely slid off-screen is still focusable. */}
        <div
          className={`panel-slot left${partsOpen ? ' open' : ''}`}
          aria-hidden={drawers && !partsOpen}
        >
          <PartsPanel />
        </div>

        <div className="viewport-wrap">
          <Viewport onCanvasReady={setCanvas} />
          <MateEditorPanel />
          <SnapAuthoringPanel />
          {drawers && (
            <>
              <button
                className={`drawer-tab left${partsOpen ? ' active' : ''}`}
                onClick={() => openParts(!partsOpen)}
                title="Show or hide the parts library"
              >
                {partsOpen ? '‹' : '›'} Parts
              </button>
              <button
                className={`drawer-tab right${propsOpen ? ' active' : ''}`}
                onClick={() => openProps(!propsOpen)}
                title="Show or hide the properties panel"
              >
                Info {propsOpen ? '›' : '‹'}
              </button>
            </>
          )}
          {drawers && (partsOpen || propsOpen) && (
            <div
              className="drawer-scrim"
              onPointerDown={() => {
                setPartsOpen(false)
                setPropsOpen(false)
              }}
            />
          )}
        </div>

        <div
          className={`panel-slot right${propsOpen ? ' open' : ''}`}
          aria-hidden={drawers && !propsOpen}
        >
          <PropertiesPanel />
        </div>
      </div>

      <StatusBar />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
