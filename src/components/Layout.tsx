import { useState } from 'react'
import TopBar from './TopBar'
import Toolbar from './Toolbar'
import PartsPanel from './PartsPanel'
import Viewport from './Viewport'
import PropertiesPanel from './PropertiesPanel'
import StatusBar from './StatusBar'
import HelpModal from './HelpModal'
import MateEditorPanel from './MateEditorPanel'
import SnapAuthoringPanel from './SnapAuthoringPanel'

export default function Layout() {
  // The live WebGL canvas, lifted up so the TopBar can export screenshots.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  return (
    <div className="app">
      <div>
        <TopBar canvas={canvas} onHelp={() => setHelpOpen(true)} />
        <Toolbar />
      </div>

      <div className="app-body">
        <PartsPanel />
        <div className="viewport-wrap">
          <Viewport onCanvasReady={setCanvas} />
          <MateEditorPanel />
          <SnapAuthoringPanel />
        </div>
        <PropertiesPanel />
      </div>

      <StatusBar />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
