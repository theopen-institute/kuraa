// The release's latest.json, which installed copies of the Tauri app read to
// learn of a newer version (Tauri's updater: each platform's update, its
// address and its signature), from each platform's part:
//
//   node scripts/updater-manifest.mjs part      this computer's part, from what `tauri build` made
//                                               (Windows: the NSIS installer; Linux: the AppImage), as
//                                               latest-<target>.json beside it in target/release/bundle
//                                               (a Mac's is made by package-mac.mjs)
//   node scripts/updater-manifest.mjs merge <dir>   every latest-*.json in <dir> (the release's files,
//                                               gathered), as <dir>/latest.json
//
// The addresses are where KURAA_UPDATES says (github:<owner>/<repo>: the release's own files).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argv, arch, env, platform, stdout } from 'node:process';

const ROOT = resolve(import.meta.dirname, '../../..');
const BUNDLE = resolve(import.meta.dirname, '../src-tauri/target/release/bundle');
const version = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8')).version;
const [command, dir] = argv.slice(2);

function addressOf(file) {
  const where = (env.KURAA_UPDATES || '').trim();
  const gh = /^github:([\w.-]+)\/([\w.-]+)$/.exec(where);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/releases/download/v${version}/${file}`;
  if (/^https:\/\//.test(where)) return `${where.replace(/\/$/, '')}/${file}`;
  throw new Error('KURAA_UPDATES should name where the updates are');
}

if (command === 'part') {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const [os, folder, pattern] = platform === 'win32' ? ['windows', 'nsis', /-setup\.exe$/] : ['linux', 'appimage', /\.AppImage$/];
  const files = readdirSync(join(BUNDLE, folder)).filter((f) => pattern.test(f) && existsSync(join(BUNDLE, folder, `${f}.sig`)));
  if (files.length !== 1) throw new Error(`Expected one signed update in ${join(BUNDLE, folder)}, found ${files.length}`);
  const file = files[0];
  const target = `${os}-${cpu}`;
  const part = { version, pub_date: new Date().toISOString(), platforms: { [target]: { signature: readFileSync(join(BUNDLE, folder, `${file}.sig`), 'utf8').trim(), url: addressOf(basename(file)) } } };
  writeFileSync(join(BUNDLE, `latest-${target}.json`), `${JSON.stringify(part, null, 2)}\n`);
  stdout.write(`updater: ${join(BUNDLE, `latest-${target}.json`)}\n`);
} else if (command === 'merge' && dir) {
  const parts = readdirSync(dir).filter((f) => /^latest-.+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (!parts.length) throw new Error(`No latest-*.json in ${dir}`);
  const versions = new Set(parts.map((p) => p.version));
  if (versions.size !== 1) throw new Error(`The parts are of different versions: ${[...versions].join(', ')}`);
  const merged = { version: parts[0].version, pub_date: parts.map((p) => p.pub_date).sort().at(-1), platforms: Object.assign({}, ...parts.map((p) => p.platforms)) };
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(merged, null, 2)}\n`);
  stdout.write(`updater: ${join(dir, 'latest.json')} (${Object.keys(merged.platforms).join(', ')})\n`);
} else {
  throw new Error('Usage: updater-manifest.mjs part | merge <dir>');
}
