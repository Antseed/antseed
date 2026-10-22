import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static bundle for the Antseed Points site (own domain, Cloudflare Pages).
// Contract addresses come from the generated constants in @antseed/node so the
// site never drifts from deployments/base-mainnet/current.json; the alias pulls
// in that one file only, no Node or ethers code.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@antseed/contract-addresses': fileURLToPath(
        new URL('../../packages/node/src/payments/generated-contract-addresses.ts', import.meta.url),
      ),
    },
  },
  server: { port: 5192 },
  build: { outDir: 'dist', sourcemap: true },
});
