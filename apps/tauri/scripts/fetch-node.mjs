// Fetches the Node the Tauri app runs its host with (the released kuraa-host.mjs,
// scripts/build-server.mjs): nodejs.org's build, one per platform and processor,
// checked against its checksum below. Only the `node` program is kept (no npm,
// headers or docs), at src-tauri/binaries/node-<target triple>, where Tauri's
// bundler takes it as a program shipped beside the app's own (externalBin).
//
//   node scripts/fetch-node.mjs                this computer's
//   node scripts/fetch-node.mjs mac-arm64 mac-x64
//
// Node is MIT-licensed, with the licences of what it includes in its LICENSE (kept beside it).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { arch, argv, platform, stdout } from 'node:process';

export const NODE_VERSION = '24.20.0';
/** Target → nodejs.org's name for it, Rust's target triple (Tauri's name for the program), and the archive's sha256. */
const TARGETS = {
  'mac-arm64': ['darwin-arm64', 'aarch64-apple-darwin', 'b7bf7707070b950ba1ec5f1af3bb6de0f2b1962c5033973d94068ab021ef3014'],
  'mac-x64': ['darwin-x64', 'x86_64-apple-darwin', '26fc30891004603d094eed11de5efcd03bbd2efbc35c177fc72648d5d7a7701b'],
};
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' };
const BINARIES = resolve(import.meta.dirname, '../src-tauri/binaries');

async function fetchNode(target) {
  const entry = TARGETS[target];
  if (!entry) throw new Error(`No Node for ${target} here yet: ${Object.keys(TARGETS).join(', ')}`);
  const [name, triple, sha256] = entry;
  const out = join(BINARIES, `node-${triple}`);
  const stamp = `${out}.version`;
  if (existsSync(out) && existsSync(stamp)) return out;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${name}.tar.xz`;
  stdout.write(`node: ${url}\n`);
  const res = await globalThis.fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${url}: checksum ${got}, expected ${sha256}`);
  const tmp = mkdtempSync(join(tmpdir(), 'kuraa-node-'));
  try {
    const archive = join(tmp, 'node.tar.xz');
    writeFileSync(archive, bytes);
    execFileSync('tar', ['-xf', archive, '-C', tmp]);
    const dir = join(tmp, `node-v${NODE_VERSION}-${name}`);
    mkdirSync(BINARIES, { recursive: true });
    cpSync(join(dir, 'bin', 'node'), out);
    chmodSync(out, 0o755);
    cpSync(join(dir, 'LICENSE'), join(BINARIES, 'NODE-LICENSE'));
    writeFileSync(stamp, `${NODE_VERSION}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

const targets = argv.slice(2).length ? argv.slice(2) : [`${OS[platform] ?? platform}-${arch}`];
for (const t of targets) stdout.write(`node: ${await fetchNode(t)}\n`);
