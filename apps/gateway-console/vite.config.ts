import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const gatewayUrl = process.env['ANTSEED_GATEWAY_URL'] || 'http://127.0.0.1:8379'

// The gateway serves the built console at /console/ from dist/; in dev the
// Vite server proxies /console/api to a running gateway. `VITE_MOCK=1 vite`
// runs against an in-memory fake API instead (never part of a production build).
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: '/console/',
  // @antseed/ui resolves React from the repo root; keep a single React copy.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5183,
    proxy: {
      '/console/api': { target: gatewayUrl, changeOrigin: false },
    },
  },
})
