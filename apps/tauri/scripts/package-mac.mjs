// After `tauri build --bundles app` on a Mac (scripts/build.mjs): signs the app,
// notarizes it, and makes its downloads.
//
//   Signing, inside out, with the hardened runtime (a Developer ID's): every program and library in
//   its resources (git's, the native addons), then the Node beside the shell (with
//   entitlements.mac.plist: V8 compiles as it runs), then the app. With
//   KURAA_SIGN_IDENTITY (a "Developer ID Application" certificate in the keychain);
//   without it, ad hoc (it runs on this Mac, and nowhere it was downloaded to).
//   Notarized when Apple's credentials are in the environment (build.mjs names them),
//   and the ticket stapled to the app.
//
//   Downloads, in target/release/bundle/downloads:
//     Kuraa-<version>-mac-<arch>.dmg          for installing
//     Kuraa-<version>-mac-<arch>.zip          what the Electron app's updater downloads (as electron-builder
//                                             makes it), with latest-mac.yml: one release of the Electron app
//                                             hands installed copies to this one (decision 0127)
//     Kuraa-<version>-mac-<arch>.app.tar.gz   what this app's updater downloads, with its .sig (Tauri's
//                                             signer, TAURI_SIGNING_PRIVATE_KEY) and latest-darwin-<arch>.json,
//                                             this platform's part of the release's latest.json (updater-manifest.mjs)
//
//   node scripts/package-mac.mjs [--test]   (--test: the app the tests drive: signed, nothing more)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, arch, env, exit, stdout } from 'node:process';
import { Buffer } from 'node:buffer';

const APP_DIR = resolve(import.meta.dirname, '..');
const TAURI = join(APP_DIR, 'src-tauri');
const ROOT = resolve(APP_DIR, '../..');
const test = argv.includes('--test');
const version = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8')).version;
const app = join(TAURI, 'target/release/bundle/macos/Kuraa.app');
if (!existsSync(app)) throw new Error(`No app at ${app}: run tauri build first (scripts/build.mjs)`);
const identity = env.KURAA_SIGN_IDENTITY || '-';
const cpu = arch === 'arm64' ? 'arm64' : 'x64';

/** Whether a file is a Mach-O program or library (or a universal one). */
function machO(path) {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(4);
    if (readSync(fd, b, 0, 4, 0) < 4) return false;
    return ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(b.toString('hex'));
  } finally {
    closeSync(fd);
  }
}

function filesIn(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) filesIn(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

// The hardened runtime (which notarizing asks for) only with a Developer ID: it lets a program load only libraries of
// its own team, and signed ad hoc there is none, so Node could not load its native addons.
const signed = identity === '-' ? [] : ['--options', 'runtime', '--timestamp'];
const sign = (path, extra = []) => execFileSync('codesign', ['--force', ...signed, ...extra, '--sign', identity, path], { stdio: ['ignore', 'ignore', 'inherit'] });

// Inside out: what its resources run, then Node, then the app (which seals the rest).
const inside = filesIn(join(app, 'Contents/Resources')).filter(machO);
for (const f of inside) sign(f);
const entitlements = join(TAURI, 'entitlements.mac.plist');
sign(join(app, 'Contents/MacOS/node'), ['--entitlements', entitlements]);
sign(app);
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
stdout.write(`package: signed ${identity === '-' ? 'ad hoc (no KURAA_SIGN_IDENTITY)' : `as ${identity}`}: ${inside.length} programs and libraries inside, Node, the app\n`);
if (test) exit(0);

/** Notarizing's credentials, as notarytool takes them; null: none. */
function notaryArgs() {
  if (env.APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE];
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  return null;
}

const out = join(TAURI, 'target/release/bundle/downloads');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const base = `Kuraa-${version}-mac-${cpu}`;
const zip = join(out, `${base}.zip`);
const ditto = () => execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);

const notary = notaryArgs();
if (notary && identity !== '-') {
  ditto();
  stdout.write('package: notarizing (this takes a few minutes)…\n');
  execFileSync('xcrun', ['notarytool', 'submit', zip, ...notary, '--wait'], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'staple', app], { stdio: 'inherit' });
  rmSync(zip);
} else stdout.write(`package: not notarized (${identity === '-' ? 'not signed with a Developer ID' : 'no Apple credentials'})\n`);

// The downloads, from the app as signed (and stapled).
ditto();
const dmg = join(out, `${base}.dmg`);
execFileSync('hdiutil', ['create', '-quiet', '-volname', 'Kuraa', '-srcfolder', app, '-ov', '-format', 'UDZO', dmg]);
if (identity !== '-') sign(dmg);
const tarball = join(out, `${base}.app.tar.gz`);
execFileSync('tar', ['-czf', tarball, '-C', join(app, '..'), 'Kuraa.app']);

// The Electron app's updater: latest-mac.yml, as electron-builder writes it, for the zip.
const sha512 = (p) => createHash('sha512').update(readFileSync(p)).digest('base64');
const now = new Date().toISOString();
writeFileSync(
  join(out, 'latest-mac.yml'),
  [`version: ${version}`, 'files:', `  - url: ${base}.zip`, `    sha512: ${sha512(zip)}`, `    size: ${statSync(zip).size}`, `path: ${base}.zip`, `sha512: ${sha512(zip)}`, `releaseDate: '${now}'`, ''].join('\n'),
);

// This app's updater: the tarball's signature, and this platform's part of latest.json.
const target = `darwin-${cpu === 'arm64' ? 'aarch64' : 'x86_64'}`;
if (env.TAURI_SIGNING_PRIVATE_KEY) {
  execFileSync('pnpm', ['exec', 'tauri', 'signer', 'sign', tarball], { cwd: APP_DIR, stdio: 'inherit' });
  const where = (env.KURAA_UPDATES || '').trim();
  const gh = /^github:([\w.-]+)\/([\w.-]+)$/.exec(where);
  const url = gh ? `https://github.com/${gh[1]}/${gh[2]}/releases/download/v${version}/${base}.app.tar.gz` : `${where.replace(/\/$/, '')}/${base}.app.tar.gz`;
  writeFileSync(join(out, `latest-${target}.json`), `${JSON.stringify({ version, pub_date: now, platforms: { [target]: { signature: readFileSync(`${tarball}.sig`, 'utf8').trim(), url } } }, null, 2)}\n`);
} else stdout.write('package: the update not signed for the updater (no TAURI_SIGNING_PRIVATE_KEY)\n');

const mb = (p) => `${(statSync(p).size / 1048576).toFixed(1)} MB`;
stdout.write(`package:\n  ${dmg} (${mb(dmg)})\n  ${zip} (${mb(zip)})\n  ${tarball} (${mb(tarball)})\n`);
