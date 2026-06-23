/**
 * Export the WebGL canvas as a PNG download.
 *
 * The canvas must have been created with `preserveDrawingBuffer: true`
 * (set on the R3F <Canvas gl={{ preserveDrawingBuffer: true }} />) otherwise
 * the captured image may be blank on some browsers.
 */
export function exportCanvasScreenshot(
  canvas: HTMLCanvasElement,
  fileName = 'vex-robot.png',
) {
  try {
    const dataURL = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = dataURL
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } catch (err) {
    console.error('Screenshot export failed:', err)
    alert('Screenshot export failed. See console for details.')
  }
}
