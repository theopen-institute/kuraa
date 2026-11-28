// Gathers what the Tauri app carries into src-tauri/staged/, for its bundler
// (tauri.conf.json's resources): the host as released (scripts/build-server.mjs:
// kuraa-host.mjs, the web client, pandoc's and Typst's WebAssembly, the native
// addons) without its source map and with only this platform's native addons, and
// the git the desktop app ships (apps/desktop's scripts/fetch-git.mjs).
//
//   node scripts/stage.mjs            this computer's platform
//   node scripts/stage.mjs mac-x64
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arch, argv, platform, stdout } from 'node:process';

const ROOT = resolve(import.meta.dirname, '../../..');
const STAGED = resolve(import.meta.dirname, '../src-tauri/staged');
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' };
const NODE_OS = { mac: 'darwin', win: 'win32', linux: 'linux' };

const target = argv[2] ?? `${OS[platform] ?? platform}-${arch}`;
const [os, cpu] = target.split('-');
const version = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8')).version;
const host = join(ROOT, 'dist/server', `kuraa-server-${version}`);
if (!existsSync(join(host, 'kuraa-host.mjs'))) throw new Error(`No host built at ${host}: run node scripts/build-server.mjs (after pnpm web:build)`);
const git = join(ROOT, 'apps/desktop/vendor/git', target);
if (!existsSync(join(git, 'bin'))) throw new Error(`No git for ${target} at ${git}: run node apps/desktop/scripts/fetch-git.mjs ${target}`);

rmSync(STAGED, { recursive: true, force: true });
const native = `${NODE_OS[os]}-${cpu}`;
cpSync(host, join(STAGED, 'host'), {
  recursive: true,
  filter: (p) => {
    if (p.endsWith('.map')) return false;
    const rel = p.slice(host.length + 1);
    // Only this platform's native addons.
    return !(rel.startsWith('native/') && rel.split('/')[1] && rel.split('/')[1] !== native);
  },
});
cpSync(git, join(STAGED, 'git'), { recursive: true, filter: (p) => !p.endsWith('.kuraa-git') });
stdout.write(`stage: ${STAGED} (host ${version}, native ${readdirSync(join(STAGED, 'host', 'native')).join(', ')}, git ${target})\n`);
