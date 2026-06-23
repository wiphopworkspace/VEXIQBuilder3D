type Props = {
  open: boolean
  onClose: () => void
}

/** Reopenable help overlay: the three ways to connect parts + keyboard keys. */
export default function HelpModal({ open, onClose }: Props) {
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="How to use the assembly builder"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span>How to build</span>
          <button className="coach-close" onClick={onClose} aria-label="Close help">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <ol className="help-steps">
            <li>
              <b>Add parts.</b> Click a part in the library on the left (beams,
              pins, gears, wheels…). It appears in the 3D view.
            </li>
            <li>
              <b>Move &amp; rotate.</b> Drag a part to move it. Use{' '}
              <b>⟲ ⟳ Rotate</b> / <b>⤵ Flip</b> in the toolbar (or <kbd>Q</kbd>{' '}
              <kbd>E</kbd> <kbd>F</kbd>) to turn it.
            </li>
            <li>
              <b>Connect them.</b> Three ways — pick whichever feels easiest:
            </li>
          </ol>

          <div className="help-cards">
            <div className="help-card">
              <div className="help-card-title">Auto Snap (easiest)</div>
              With <b>Auto Snap: On</b>, drag a part near a compatible hole and
              release — it snaps together. Rotating re-snaps automatically.
            </div>
            <div className="help-card">
              <div className="help-card-title">Joint Mode <kbd>J</kbd></div>
              Click one snap point, then a compatible (green) one on another
              part. The parts mate at those points.
            </div>
            <div className="help-card">
              <div className="help-card-title">Pin Mode <kbd>P</kbd></div>
              Choose a pin, then click a highlighted beam hole to drop the pin
              straight in.
            </div>
          </div>

          <div className="help-finish">
            <b>Finish &amp; use it:</b> <b>Save JSON</b> keeps your build to
            reopen later, <b>Load JSON</b> brings it back, and{' '}
            <b>Export Screenshot</b> saves a picture to share.
          </div>

          <div className="help-keys">
            <span><kbd>V</kbd> Select</span>
            <span><kbd>G</kbd> Move</span>
            <span><kbd>R</kbd> Rotate</span>
            <span><kbd>Q</kbd>/<kbd>E</kbd> Turn 90°</span>
            <span><kbd>F</kbd> Flip</span>
            <span><kbd>J</kbd> Joint</span>
            <span><kbd>P</kbd> Pin</span>
            <span><kbd>Ctrl</kbd>+<kbd>D</kbd> Duplicate</span>
            <span><kbd>Del</kbd> Delete</span>
            <span><kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo</span>
            <span><kbd>Esc</kbd> Cancel</span>
          </div>
        </div>

        <div className="modal-foot">
          <button className="coach-cta" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
