import { useRef } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { downloadProjectJSON } from '../utils/projectIO'
import { exportCanvasScreenshot } from '../utils/screenshot'

export default function TopBar({
  canvas,
  onHelp,
}: {
  canvas: HTMLCanvasElement | null
  onHelp: () => void
}) {
  const projectName = useAssemblyStore((s) => s.projectName)
  const setProjectName = useAssemblyStore((s) => s.setProjectName)
  const clearProject = useAssemblyStore((s) => s.clearProject)
  const exportProject = useAssemblyStore((s) => s.exportProject)
  const loadProject = useAssemblyStore((s) => s.loadProject)
  const setStatus = useAssemblyStore((s) => s.setStatus)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleNew = () => {
    if (
      useAssemblyStore.getState().parts.length > 0 &&
      !confirm('Start a new project? Unsaved changes will be lost.')
    ) {
      return
    }
    clearProject()
  }

  const handleSave = () => {
    downloadProjectJSON(exportProject())
    setStatus('Project saved to JSON')
  }

  const handleLoadClick = () => fileInputRef.current?.click()

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result))
        loadProject(json)
      } catch (err) {
        console.error(err)
        alert('Failed to load project: invalid JSON file.')
        setStatus('Load failed: invalid JSON')
      }
    }
    reader.readAsText(file)
    // Reset so loading the same file again re-triggers change.
    e.target.value = ''
  }

  const handleScreenshot = () => {
    if (!canvas) {
      alert('Viewport not ready yet.')
      return
    }
    exportCanvasScreenshot(canvas, `${projectName || 'vex-robot'}.png`)
    setStatus('Screenshot exported')
  }

  return (
    <div className="topbar">
      <div className="logo">
        VEX IQ <span>3D Assembly Builder</span>
      </div>
      <input
        className="project-name"
        type="text"
        value={projectName}
        onChange={(e) => setProjectName(e.target.value)}
        aria-label="Project name"
      />
      <div className="spacer" />
      <button onClick={handleNew} title="Start a new, empty project">
        New
      </button>
      <button onClick={handleSave} title="Save this build to a .json file you can reopen later">
        Save JSON
      </button>
      <button onClick={handleLoadClick} title="Open a build you saved earlier">
        Load JSON
      </button>
      <button onClick={handleScreenshot} title="Save a picture of your build to share">
        Export Screenshot
      </button>
      <button className="help-btn" onClick={onHelp} title="How to use the builder">
        ? Help
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
    </div>
  )
}
