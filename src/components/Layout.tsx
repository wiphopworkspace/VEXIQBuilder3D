import { useEffect, useRef, useState } from 'react'
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
 * screen is the model.
 *
 * 1280, not the 1024 a "tablet" breakpoint usually is, because the landscape
 * iPads are the whole point: 1180 CSS px (iPad Air 11", iPad 10th gen) and
 * 1194 (iPad Pro 11"). The old value WAS 1180 and its comment already said a
 * 1194 iPad Pro "reads far better with drawers too" — but 1194 > 1180, so that
 * iPad missed the breakpoint by 14px and got the docked three-column layout
 * with no way to reclaim the space. 1280 clears every 11" iPad in landscape
 * with room to spare while leaving real desktop windows docked.
 */
const DRAWER_BREAKPOINT_PX = 1280

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
  /**
   * TWO INDEPENDENT BOOLEANS. Not `activePanel: 'left' | 'right' | null`, not a
   * shared `sidebarOpen`, and nothing anywhere may close one side as a side
   * effect of the other opening — that is the invariant this layout is built
   * around, in both the docked and the overlay layout.
   *
   * It was NOT true before: while the panels were drawers each opener closed
   * the opposite one ("only one drawer at a time: on a tablet they each cover
   * most of the screen"). On an iPad that reads as the app throwing your parts
   * library away the moment you look at a part's properties. The width is the
   * real constraint behind that rule, so the width is what got fixed — a drawer
   * is `clamp(280px, 38vw, 380px)` now, so both fit side by side with canvas
   * left over even on the narrowest iPad in portrait (measured at 744px: 38vw
   * is 282.7 a side, leaving a 178px strip of model — and either panel is one
   * tap from closing).
   *
   * Each panel is on screen by default in the layout that has a column for it,
   * and closed by default in the layout where it would cover the model.
   */
  const [partsOpen, setPartsOpen] = useState(!drawers)
  const [propsOpen, setPropsOpen] = useState(!drawers)

  // Crossing the breakpoint (a rotation, a resized window) deliberately does
  // NOT touch either flag. A rotation is not a request to close anything, and
  // the two layouts express the same two booleans — a docked column and an
  // overlay are the same "this panel is open", drawn differently.

  // Every caller: exactly one setter, exactly one panel. Adding a second setter
  // to either of these is the bug this file exists to not have.
  const openParts = (open: boolean) => setPartsOpen(open)
  const openProps = (open: boolean) => setPropsOpen(open)

  // The edge tab is the way back to a hidden panel — and ONLY that. It used to
  // stay up as a toggle while its drawer was open, where it sat on top of the
  // panel it had just opened and did nothing you could not do from inside;
  // closing is the dismiss handle in the panel's own corner.
  const showLeftTab = !partsOpen
  const showRightTab = !propsOpen

  // Opening a panel unmounts the tab that opened it, which would drop keyboard
  // focus on the floor. Hand it to that panel's dismiss handle — the control
  // that undoes what was just done.
  const partsHandle = useRef<HTMLButtonElement>(null)
  const propsHandle = useRef<HTMLButtonElement>(null)
  const handOffFocus = (handle: React.RefObject<HTMLButtonElement>) => {
    requestAnimationFrame(() => handle.current?.focus())
  }

  return (
    <div
      className={`app${drawers ? ' app-drawers' : ''}${partsOpen ? '' : ' left-hidden'}${
        propsOpen ? '' : ' right-hidden'
      }`}
    >
      <div>
        <TopBar canvas={canvas} onHelp={() => setHelpOpen(true)} />
        <Toolbar />
      </div>

      <div className="app-body">
        {/* Hidden from assistive tech while closed; `visibility: hidden` in the
            panel CSS is what takes it out of the tab order, since a drawer
            merely slid off-screen — or a column collapsed to 0px — is still
            focusable. */}
        <div className={`panel-slot left${partsOpen ? ' open' : ''}`} aria-hidden={!partsOpen}>
          <PartsPanel />
          <button
            ref={partsHandle}
            className="panel-collapse"
            onClick={() => openParts(false)}
            title="Hide the parts library"
            aria-label="Hide the parts library"
          >
            ‹
          </button>
        </div>

        <div className="viewport-wrap">
          <Viewport onCanvasReady={setCanvas} />
          <MateEditorPanel />
          <SnapAuthoringPanel />
          {showLeftTab && (
            <button
              className="drawer-tab left"
              onClick={() => {
                openParts(true)
                handOffFocus(partsHandle)
              }}
              title="Show the parts library"
            >
              <span className="drawer-tab-caret" aria-hidden="true">
                ›
              </span>
              Parts
            </button>
          )}
          {showRightTab && (
            <button
              className="drawer-tab right"
              onClick={() => {
                openProps(true)
                handOffFocus(propsHandle)
              }}
              title="Show the properties panel"
            >
              <span className="drawer-tab-caret" aria-hidden="true">
                ‹
              </span>
              Info
            </button>
          )}
        </div>

        <div className={`panel-slot right${propsOpen ? ' open' : ''}`} aria-hidden={!propsOpen}>
          <PropertiesPanel />
          <button
            ref={propsHandle}
            className="panel-collapse"
            onClick={() => openProps(false)}
            title="Hide the properties panel"
            aria-label="Hide the properties panel"
          >
            ›
          </button>
        </div>
      </div>

      <StatusBar />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
