import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
  testDir: '.',
  testMatch: 'web-sdk.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  outputDir: join(tmpdir(), 'antseed-web-sdk-playwright'),
  use: {
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
