import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@antseed\/node\/discovery$/, replacement: resolve(__dirname, '../packages/node/src/discovery/index.ts') },
      { find: /^@antseed\/node\/metering$/, replacement: resolve(__dirname, '../packages/node/src/metering/index.ts') },
      { find: /^@antseed\/node$/, replacement: resolve(__dirname, '../packages/node/src/index.ts') },
      { find: /^@antseed\/provider-core$/, replacement: resolve(__dirname, '../packages/provider-core/src/index.ts') },
      { find: /^@antseed\/provider-anthropic$/, replacement: resolve(__dirname, '../plugins/provider-anthropic/src/index.ts') },
      { find: /^@antseed\/router-local$/, replacement: resolve(__dirname, '../plugins/router-local/src/index.ts') },
    ],
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
    // Builds @antseed/node and the CLI once; test files must not rebuild them (see global-setup.ts).
    globalSetup: ['./global-setup.ts'],
    pool: 'forks',
  },
});
