import { defineConfig } from '@playwright/test';
import { E2E } from './tests/e2e/env.js';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: E2E.url, trace: 'retain-on-failure' },
  projects: [
    { name: 'web', testMatch: /(app|collab|cues|text|run|click|newfile|notes|plugins|source)\.spec\.ts/, use: { browserName: 'chromium' } },
    { name: 'desktop', testMatch: /desktop\.spec\.ts/ },
    { name: 'dev', testMatch: /dev\.spec\.ts/, use: { browserName: 'chromium' } },
  ],
  webServer: {
    // A shared host on a fresh workspace, serving the built web client.
    command: 'pnpm --filter @kuraa/web build && tsx tests/e2e/serve.ts',
    url: E2E.url,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
