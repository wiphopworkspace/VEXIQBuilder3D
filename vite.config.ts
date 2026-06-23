import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
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
