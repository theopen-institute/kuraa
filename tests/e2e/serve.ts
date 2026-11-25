// Starts a shared host on a fresh workspace for the browser tests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../../packages/host/src/index.js';
import { standardRunComponents } from '../../packages/run-components/src/index.js';
import { marksFeature } from '../../packages/feature-example/src/index.js';
import { standardFeatures } from '../../packages/features/src/index.js';
import { createPerson, readPerson } from '../../packages/host/src/peers/person.js';
import { E2E, NOTES } from './env.js';

const git = (...args: string[]) => execFileSync('git', args, { cwd: E2E.dir, encoding: 'utf8' });
rmSync(E2E.dir, { recursive: true, force: true });
// Package installs start from nothing too.
rmSync(join(E2E.dir, '..', 'kuraa-e2e-rdata'), { recursive: true, force: true });
mkdirSync(E2E.dir, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Shared Host');
git('config', 'user.email', 'host@example.org');
writeFileSync(join(E2E.dir, 'notes.md'), NOTES);
writeFileSync(join(E2E.dir, 'other.md'), '# Other\n');
git('add', '-A');
git('commit', '-q', '-m', 'Initial');

// The host's person has an identity, as the app makes one where it may (0038): what you annotate is your own (0082).
if (!(await readPerson())) await createPerson('E2E');

const running = await startHost({
  dir: E2E.dir,
  port: E2E.port,
  host: '127.0.0.1',
  token: E2E.token,
  run: { engines: ['r'], components: standardRunComponents, allowInstalls: true, dataDir: join(E2E.dir, '..', 'kuraa-e2e-rdata') },
  // The standard features (annotations) and the example one (0082), off until a test turns them on for the workspace.
  features: [...standardFeatures, marksFeature],
  staticDir: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
  timings: { flushMs: 300, idleCommitMs: 1500, maxCommitMs: 10_000, dropMs: 1000 },
  log: (m) => console.log(`[host] ${m}`),
});
console.log(`[host] ${running.url} serving ${E2E.dir}`);
const stop = () => void running.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
