import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const gatewayUrl = process.env['ANTSEED_GATEWAY_URL'] || 'http://127.0.0.1:8379'
// `ANTSEED_ANTS_URL=<an \`antseed ants\` session URL> VITE_MOCK=1 vite`: the mock
// console's staking pages read from that live dashboard backend (e.g. the Anvil sandbox).
const antsUrl = process.env['ANTSEED_ANTS_URL'] ? new URL(process.env['ANTSEED_ANTS_URL']) : null
const antsToken = antsUrl ? new URLSearchParams(antsUrl.hash.slice(1)).get('token') ?? '' : ''

// The gateway serves the built console at /console/ from dist/; in dev the
// Vite server proxies /console/api to a running gateway. `VITE_MOCK=1 vite`
// runs against an in-memory fake API instead (never part of a production build).
export default defineConfig({
  // Tailwind serves only the chat page (src/chat, shadcn AI Elements); see src/chat/chat.css.
  plugins: [react(), tailwindcss()],
  root: __dirname,
  base: '/console/',
  define: { 'import.meta.env.VITE_ANTS_PROXY': JSON.stringify(antsUrl ? '1' : '') },
  // @antseed/ui resolves React from the repo root; keep a single React copy. The
  // staking pages come from the ANTS dashboard's sources and must share the
  // console's wagmi, RainbowKit and React Query instances (one wallet connection).
  resolve: {
    dedupe: ['react', 'react-dom', 'wagmi', 'viem', '@rainbow-me/rainbowkit', '@tanstack/react-query', '@antseed/ui', '@antseed/wallet-config'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@antseed/ants-web': path.resolve(__dirname, '../ants/web/src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5183,
    proxy: {
      '/console/api': { target: gatewayUrl, changeOrigin: false },
      ...(antsUrl ? { '/__ants': { target: antsUrl.origin, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/__ants/, ''), headers: { authorization: `Bearer ${antsToken}` } } } : {}),
    },
  },
})
