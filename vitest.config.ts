import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Never the keys of whoever runs the tests (packages/host/src/peers/person.ts): a folder of their own.
    env: { KURAA_PERSON: join(mkdtempSync(join(tmpdir(), 'kuraa-test-keys-')), 'person.json') },
  },
});
