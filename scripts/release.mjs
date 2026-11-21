// pnpm release <version>: release the desktop app (decision 0051).
//
// Sets the app's version (apps/desktop/package.json), commits it, tags it
// v<version>, and pushes both. The tag starts the Release workflow on GitHub
// (.github/workflows/release.yml), which tests, builds and signs it, and
// publishes it: installed apps update to it within hours.
//
//   pnpm release 0.2.0           a release
//   pnpm release 0.3.0-beta.1    a pre-release: installed apps do not update to it
//   pnpm release 0.2.0 --dry-run say what would be done, and do nothing
//
// From main, with nothing uncommitted, and the version above the last one.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const APP = resolve(ROOT, 'apps/desktop/package.json');
const LINK = 'packages/host/src/peers/link.ts';

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const fail = (m) => {
  console.error(`release: ${m}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const version = args.find((a) => !a.startsWith('--'));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
if (!version || !SEMVER.test(version)) fail('give the version to release, as 1.2.3 (or 1.2.3-beta.1 for a pre-release)');

/** Compare two versions as semver does (a pre-release comes before its release). */
function compare(a, b) {
  const [, ...x] = SEMVER.exec(a);
  const [, ...y] = SEMVER.exec(b);
  for (let i = 0; i < 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (!x[3] || !y[3]) return (x[3] ? -1 : 0) - (y[3] ? -1 : 0);
  const p = x[3].split('.');
  const q = y[3].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]) ? Number(p[i]) - Number(q[i]) : p[i].localeCompare(q[i]);
    if (n) return n;
  }
  return 0;
}

if (git('status', '--porcelain')) fail('there are uncommitted changes: commit or put them away first');
if (git('branch', '--show-current') !== 'main') fail('release from main');
const tag = `v${version}`;
if (git('tag', '--list', tag)) fail(`${tag} is a tag already`);
const text = readFileSync(APP, 'utf8');
const current = JSON.parse(text).version;
if (compare(version, current) <= 0) fail(`${version} is not above the app's version now, ${current}: installed apps update only to a higher one`);

// What devices say to each other changed since the last release: every device must be updated to keep syncing.
const last = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter(Boolean)[0];
const protocol = (src) => /export const PROTOCOL = (\d+);/.exec(src)?.[1] ?? null;
if (last) {
  let before = null;
  try {
    before = protocol(git('show', `${last}:${LINK}`));
  } catch { /* not there then */ }
  const now = protocol(readFileSync(resolve(ROOT, LINK), 'utf8'));
  if (before !== now) console.log(`release: the protocol devices speak changed since ${last} (${before ?? 'none'} → ${now}): say in the release notes that every device must be updated to go on syncing.`);
}

const steps = [
  `set apps/desktop/package.json version ${current} → ${version}`,
  `commit "Release ${tag}" and tag it ${tag}`,
  `push main and ${tag} to origin, which starts the Release workflow`,
];
if (dry) {
  console.log(['release: would', ...steps.map((s) => `  - ${s}`)].join('\n'));
  process.exit(0);
}
writeFileSync(APP, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
git('commit', '-q', '-m', `Release ${tag}`, '--', 'apps/desktop/package.json');
git('tag', '-a', tag, '-m', `kuraa ${version}`);
// Both or neither: a tag without its commit on main, or the other way round, is no release.
git('push', '--atomic', 'origin', 'main', tag);
console.log(`release: pushed ${tag}. The Release workflow tests, builds and publishes it (Actions on GitHub shows how it is going).`);
