import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // node-datachannel is a native addon that segfaults in worker threads;
    // run the suite that loads it in a forked process instead.
    poolMatchGlobs: [['**/webrtc-transport.test.ts', 'forks']],
  },
});
