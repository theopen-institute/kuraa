// Builds the Tauri app (decision 0127), once scripts/stage.mjs has gathered what
// it carries: `tauri build` for this platform, then, on a Mac, package-mac.mjs
// (signing, notarizing, the zip and DMG, the update files).
//
//   node scripts/build.mjs           the app, for release (what it updates from: KURAA_UPDATES)
//   node scripts/build.mjs --test    the app the desktop tests drive (src/testing.rs), never released
//
// Updates: KURAA_UPDATES says where the app looks for newer releases, as for the
// Electron app: `github:<owner>/<repo>` (each release's latest.json, at
// releases/latest/download/latest.json) or an https URL (a folder holding
// latest.json and the updates). Tauri's updater takes only updates signed with the
// key whose public half is built in: TAURI_UPDATER_PUBKEY (from `tauri signer
// generate`), with TAURI_SIGNING_PRIVATE_KEY (and its password,
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD) to sign this build's. Without KURAA_UPDATES,
// the app built does not update itself.
//
// Signing on a Mac: KURAA_SIGN_IDENTITY (a "Developer ID Application" certificate in
// the keychain); notarizing with the Electron app's variables (APPLE_KEYCHAIN_PROFILE;
// or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID; or APPLE_API_KEY,
// APPLE_API_KEY_ID and APPLE_API_ISSUER). On Windows, Tauri signs with what its
// configuration names (bundle.windows.signCommand), given in KURAA_WINDOWS_SIGN_COMMAND.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, env, execPath, platform, stdout } from 'node:process';

const APP = resolve(import.meta.dirname, '..');
const test = argv.includes('--test');

/** Where updates are, from KURAA_UPDATES; null: nowhere. */
function endpoint() {
  const where = (env.KURAA_UPDATES || '').trim();
  if (!where) return null;
  const gh = /^github:([\w.-]+)\/([\w.-]+)$/.exec(where);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/releases/latest/download/latest.json`;
  if (/^https:\/\//.test(where)) return `${where.replace(/\/$/, '')}/latest.json`;
  throw new Error(`KURAA_UPDATES should be github:<owner>/<repo> or an https URL, not "${where}"`);
}

const config = {};
const updates = test ? null : endpoint();
if (updates) {
  if (!env.TAURI_UPDATER_PUBKEY) throw new Error('KURAA_UPDATES names where the app updates from, so TAURI_UPDATER_PUBKEY must name the key its updates are signed with');
  config.plugins = { updater: { pubkey: env.TAURI_UPDATER_PUBKEY, endpoints: [updates], windows: { installMode: 'passive' } } };
  // Windows and Linux: Tauri makes the update files itself (signed with TAURI_SIGNING_PRIVATE_KEY). A Mac's are made
  // by package-mac.mjs, after it signs the app.
  if (platform !== 'darwin') config.bundle = { createUpdaterArtifacts: true };
}
if (platform === 'win32' && env.KURAA_WINDOWS_SIGN_COMMAND) config.bundle = { ...config.bundle, windows: { signCommand: env.KURAA_WINDOWS_SIGN_COMMAND } };

const overlay = join(APP, 'build', 'tauri.build.json');
mkdirSync(join(APP, 'build'), { recursive: true });
writeFileSync(overlay, `${JSON.stringify(config, null, 2)}\n`);

const bundles = test ? 'app' : { darwin: 'app', win32: 'nsis', linux: 'deb,rpm,appimage' }[platform];
const args = ['exec', 'tauri', 'build', '--config', overlay, ...(bundles ? ['--bundles', bundles] : ['--no-bundle']), ...(test ? ['--features', 'test-control'] : [])];
// A Mac's app is signed by package-mac.mjs, not by Tauri's bundler (whose copy of each file would then be sealed
// before Tauri is done with it).
const buildEnv = { ...env };
if (platform === 'darwin') delete buildEnv.APPLE_SIGNING_IDENTITY;
// The test build is a release build too (as fast, and as the person's), told apart by its feature alone.
execFileSync('pnpm', args, { cwd: APP, stdio: 'inherit', env: buildEnv, shell: platform === 'win32' });
if (platform === 'darwin') execFileSync(execPath, [join(APP, 'scripts/package-mac.mjs'), ...(test ? ['--test'] : [])], { stdio: 'inherit' });
stdout.write(`build: done${updates ? `, updating from ${updates}` : test ? ' (for the tests)' : ', not updating itself (no KURAA_UPDATES)'}\n`);
