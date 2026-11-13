import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const paymentsBackendPort = Number(process.env['ANTSEED_PAYMENTS_PORT']) || 3118;
const paymentsProxyTarget = process.env['ANTSEED_PAYMENTS_PROXY_TARGET'] || `http://127.0.0.1:${paymentsBackendPort}`;

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  root: 'web',
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    proxy: {
      // Forward all backend calls to the Fastify server spawned by the desktop app.
      // Override the target with ANTSEED_PAYMENTS_PROXY_TARGET if the server is on a different port.
      '/api': {
        target: paymentsProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
