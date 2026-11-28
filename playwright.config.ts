import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { E2E } from './tests/e2e/env.js';

// Never the keys of whoever runs the tests (packages/host/src/peers/person.ts): a folder of their own.
process.env.KURAA_PERSON = join(mkdtempSync(join(tmpdir(), 'kuraa-test-keys-')), 'person.json');

// The web client's tests, run in each engine people browse with: Chromium (Chrome, Edge, and Windows' WebView2),
// WebKit (Safari, and the webview a Tauri app gets on macOS and Linux) and Firefox.
const WEB = /(app|collab|cues|text|run|click|newfile|notes|components|source|header|conflicts|devices|rules|spaces|hub|citations|images|tables|find|render|render-builtin|export|search|versions|polish|tools|preferences|features|comments|coding|navigation|compile|composition|import|feature-contexts|feature-hooks|words|corkboard|motion|image-layout)\.spec\.ts/;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // No motion (0117): nothing waits on an animation; motion.spec.ts turns it back on to see it.
  use: { baseURL: E2E.url, trace: 'retain-on-failure', reducedMotion: 'reduce' },
  projects: [
    { name: 'web', testMatch: WEB, use: { browserName: 'chromium' } },
    { name: 'webkit', testMatch: WEB, use: { browserName: 'webkit' } },
    { name: 'firefox', testMatch: WEB, use: { browserName: 'firefox' } },
    { name: 'desktop', testMatch: /desktop\.spec\.ts/ },
    // The Tauri app (0127): driven through its own control (tauri-app.ts), no browser launched.
    { name: 'tauri', testMatch: /tauri\.spec\.ts/ },
    { name: 'dev', testMatch: /dev\.spec\.ts/, use: { browserName: 'chromium' } },
  ],
  webServer: {
    // A shared host on a fresh workspace, serving the built web client (built for the tests: with the example feature, 0082).
    command: 'pnpm --filter @kuraa/web build --mode e2e && tsx tests/e2e/serve.ts',
    url: E2E.url,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
