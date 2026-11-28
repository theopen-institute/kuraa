// Fetches the programs documents are rendered with outside Podman (decision
// 0107): pandoc's WebAssembly build (one file, every platform) and Typst, a
// program per platform and processor. Each download is checked against its
// checksum below. They are kept once per computer, in a cache folder every
// checkout shares (KURAA_RENDER_TOOLS, else the user's cache folder:
// kuraa/render-tools), where @kuraa/render-pandoc finds them in development.
// `--into <dir>` also copies them where a package is made from: pandoc.wasm
// into <dir>/pandoc/, Typst into <dir>/<os>-<arch>/ (os as electron-builder
// names it: mac, win, linux).
//
//   node scripts/fetch-render-tools.mjs                      this computer's
//   node scripts/fetch-render-tools.mjs --into apps/desktop/vendor/render mac-arm64 mac-x64
//   node scripts/fetch-render-tools.mjs --quiet-fail          as pnpm install runs it: offline, say so and go on
//
// pandoc is GPL-2.0-or-later: its source is at https://github.com/jgm/pandoc at
// the tag below (its COPYING.md goes with it). Typst is Apache-2.0
// (https://github.com/typst/typst, its LICENSE and NOTICE go with it).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { arch, argv, env, exit, pid, platform, stderr, stdout } from 'node:process';

export const PANDOC = {
  version: '3.14',
  url: 'https://github.com/jgm/pandoc/releases/download/3.14/pandoc-3.14-wasm.zip',
  sha256: '84e1023db1892cfdeb9ee518b8d95e6f6c667bbde7c99f24ec889a2099367ee5',
};
export const TYPST_VERSION = '0.15.1';
/** Target → Typst's name for it, and its sha256. */
const TYPST = {
  'mac-arm64': ['aarch64-apple-darwin.tar.xz', '48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a'],
  'mac-x64': ['x86_64-apple-darwin.tar.xz', '7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa'],
  'win-x64': ['x86_64-pc-windows-msvc.zip', '19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736'],
  'win-arm64': ['aarch64-pc-windows-msvc.zip', '4ab28e1b71ec3184d38d580ab797f499b6770d952b6b19167be5cea5c2662e14'],
  'linux-x64': ['x86_64-unknown-linux-musl.tar.xz', 'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c'],
  'linux-arm64': ['aarch64-unknown-linux-musl.tar.xz', '5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee'],
};
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' };

/** The folder kept once per computer (as @kuraa/render-pandoc's where.ts has it). */
export function cacheDir() {
  if (env.KURAA_RENDER_TOOLS) return resolve(env.KURAA_RENDER_TOOLS);
  const base = platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
    : platform === 'win32' ? (env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
      : (env.XDG_CACHE_HOME || join(homedir(), '.cache'));
  return join(base, 'kuraa', 'render-tools');
}

async function download(url, sha256) {
  const res = await globalThis.fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${url}: checksum ${got}, expected ${sha256}`);
  return bytes;
}

/** An archive unpacked into a new folder, made whole before it takes the name (an interrupted fetch leaves nothing half there). */
async function fetchInto(dir, url, sha256, unpack) {
  if (existsSync(join(dir, '.kuraa-fetched'))) return false;
  const bytes = await download(url, sha256);
  const tmp = `${dir}.${pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, url.slice(url.lastIndexOf('/') + 1));
  writeFileSync(archive, bytes);
  try {
    // bsdtar (macOS, Windows) reads zip and xz; GNU tar, xz (`J`), and zip through unzip.
    if (archive.endsWith('.zip') && platform === 'linux') execFileSync('unzip', ['-q', archive, '-d', tmp]);
    else execFileSync('tar', ['-xf', archive, '-C', tmp]);
  } finally {
    rmSync(archive, { force: true });
  }
  unpack(tmp);
  writeFileSync(join(tmp, '.kuraa-fetched'), `${url}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return true;
}

/** The one folder an archive unpacked into (its files are in it). */
const only = (dir) => {
  const names = readdirSync(dir).filter((n) => !n.startsWith('.'));
  return names.length === 1 ? join(dir, names[0]) : dir;
};
/** A folder's files moved up into it, the folder they were in gone. */
function flatten(dir) {
  const inner = only(dir);
  if (inner === dir) return;
  for (const name of readdirSync(inner)) renameSync(join(inner, name), join(dir, name));
  rmSync(inner, { recursive: true, force: true });
}

export async function fetchPandoc(cache = cacheDir()) {
  const dir = join(cache, `pandoc-${PANDOC.version}`);
  const fetched = await fetchInto(dir, PANDOC.url, PANDOC.sha256, flatten);
  stdout.write(`pandoc ${PANDOC.version} (WebAssembly): ${fetched ? 'fetched' : 'already there'}\n`);
  return dir;
}

export async function fetchTypst(target, cache = cacheDir()) {
  const known = TYPST[target];
  if (!known) throw new Error(`Unknown target ${target}. Known: ${Object.keys(TYPST).join(', ')}`);
  const [name, sha256] = known;
  const dir = join(cache, `typst-${TYPST_VERSION}-${target}`);
  const url = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${name}`;
  const fetched = await fetchInto(dir, url, sha256, (tmp) => {
    flatten(tmp);
    if (!target.startsWith('win')) chmodSync(join(tmp, 'typst'), 0o755);
  });
  stdout.write(`typst ${TYPST_VERSION} ${target}: ${fetched ? 'fetched' : 'already there'}\n`);
  return dir;
}

async function main() {
  const args = argv.slice(2);
  const quiet = args.includes('--quiet-fail');
  const at = args.indexOf('--into');
  const into = at >= 0 ? resolve(args[at + 1]) : null;
  const targets = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
  try {
    const pandoc = await fetchPandoc();
    const typst = [];
    for (const t of targets.length ? targets : [`${OS[platform]}-${arch}`]) typst.push([t, await fetchTypst(t)]);
    if (into) {
      const copy = (from, to) => {
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith('.kuraa-fetched') });
      };
      copy(pandoc, join(into, 'pandoc'));
      for (const [t, dir] of typst) copy(dir, join(into, t));
      stdout.write(`copied into ${into}\n`);
    }
  } catch (e) {
    if (!quiet) throw e;
    stderr.write(`Could not fetch pandoc and Typst (${e.message}); documents render only where Podman runs until \`node scripts/fetch-render-tools.mjs\` succeeds.\n`);
    exit(0);
  }
}

if (import.meta.url === `file://${argv[1]}` || resolve(argv[1] ?? '') === resolve(import.meta.filename)) await main();
