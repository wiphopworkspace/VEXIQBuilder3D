import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // The GitHub Pages deploy workflow sets VITE_BASE_PATH=/VEXIQBuilder3D/;
  // local dev/build stays at the domain root.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
  },
  // GLB part models can be large; silence the chunk-size warning for builds.
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
