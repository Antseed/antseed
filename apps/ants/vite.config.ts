import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendPort = Number(process.env['ANTSEED_ANTS_PORT']) || 3119;

// The dashboard is served by the Fastify server in src/server.ts from
// dist/ants-web; in dev the Vite server proxies /api to a running backend.
export default defineConfig({
  plugins: [react()],
  root: 'web',
  // @antseed/ui resolves React from the repo root; keep a single React copy.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: path.resolve(__dirname, 'dist/ants-web'),
    emptyOutDir: true,
  },
  server: {
    port: 5181,
    proxy: {
      '/api': { target: process.env['ANTSEED_ANTS_PROXY_TARGET'] || `http://127.0.0.1:${backendPort}`, changeOrigin: true },
    },
  },
});
