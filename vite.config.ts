import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/**
 * DEV-ONLY evidence sink for pin-seating verification.
 *
 * The verification workflow needs deterministic close-up IMAGES of each
 * connector's stopping surface sitting on its receiver. The renderer can
 * produce them (`preserveDrawingBuffer: true` on the R3F canvas, so
 * `canvas.toDataURL()` returns a real frame), but a browser cannot write to
 * the repo. This accepts the captured PNG and writes it under
 * `docs/pin-seating-evidence/`.
 *
 * `apply: 'serve'` — it never exists in a production build, and it only ever
 * writes PNGs into that one directory.
 */
function pinEvidenceSink(): Plugin {
  const outDir = path.resolve('docs/pin-seating-evidence')
  return {
    name: 'vexiq-pin-evidence-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__pin-evidence', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { name, dataUrl } = JSON.parse(body) as {
              name: string
              dataUrl: string
            }
            const safe = String(name).replace(/[^a-z0-9._-]/gi, '_')
            const b64 = dataUrl.replace(/^data:image\/png;base64,/, '')
            fs.mkdirSync(outDir, { recursive: true })
            const file = path.join(outDir, `${safe}.png`)
            fs.writeFileSync(file, Buffer.from(b64, 'base64'))
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, file, bytes: b64.length }))
          } catch (e) {
            res.statusCode = 400
            res.end(String(e))
          }
        })
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  // The GitHub Pages deploy workflow sets VITE_BASE_PATH=/VEXIQBuilder3D/;
  // local dev/build stays at the domain root.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), pinEvidenceSink()],
  server: {
    port: 5173,
    open: true,
  },
  // GLB part models can be large; silence the chunk-size warning for builds.
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        /**
         * Split the renderer out of the app bundle.
         *
         * Everything used to ship as one ~1.83 MB file, so every deploy — a
         * copy tweak, a new snap override — made every device re-download
         * three.js as well. That is the wrong trade for the two places this
         * runs: a classroom of iPads on shared wifi, and a lab of PCs that
         * open the site fresh each lesson. three.js and the R3F/drei layer
         * change only when a dependency is bumped, so giving them their own
         * hashed chunks means a normal release invalidates the small half.
         *
         * Split by TOP-LEVEL dependency, not per-package: three, fiber and
         * drei are one interlocking graph and cutting between them risks
         * circular-init order problems for no benefit — they are always
         * loaded together anyway.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (
            id.includes('/three/') ||
            id.includes('@react-three/') ||
            id.includes('/three-stdlib/')
          ) {
            return 'three'
          }
          if (id.includes('/react/') || id.includes('/react-dom/')) {
            return 'react'
          }
          return undefined
        },
      },
    },
  },
})
