// After `tauri build --bundles app`: puts git's links back in the app, and makes
// the downloads the Electron app's release has (decision 0051), to compare: a zip
// (what updates download, made as electron-builder makes it) and a DMG (zlib, UDZO,
// electron-builder's default).
//
// Tauri's bundler copies a resource's symbolic links as the files they point at,
// so git's 148 links in libexec/git-core (each to the 3.5 MB git) became 148
// copies: 520 MB. Each link in staged/git is made again in the app.
//
// Unsigned: a release would sign and notarize the app after this, then make these.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdout } from 'node:process';

const TAURI = resolve(import.meta.dirname, '../src-tauri');
const app = join(TAURI, 'target/release/bundle/macos/Kuraa Tauri.app');
const staged = join(TAURI, 'staged/git');
const into = join(app, 'Contents/Resources/git');
const out = join(TAURI, 'target/release/bundle/downloads');

let relinked = 0;
function relink(dir) {
  for (const name of readdirSync(join(staged, dir))) {
    const rel = join(dir, name);
    const st = lstatSync(join(staged, rel));
    if (st.isSymbolicLink()) {
      rmSync(join(into, rel), { force: true });
      symlinkSync(readlinkSync(join(staged, rel)), join(into, rel));
      relinked++;
    } else if (st.isDirectory()) relink(rel);
  }
}
relink('');

const mb = (p) => (statSync(p).size / 1048576).toFixed(1);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const zip = join(out, 'Kuraa-Tauri-mac-arm64.zip');
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
const dmg = join(out, 'Kuraa-Tauri-mac-arm64.dmg');
execFileSync('hdiutil', ['create', '-quiet', '-volname', 'Kuraa Tauri', '-srcfolder', app, '-ov', '-format', 'UDZO', dmg]);
stdout.write(`package: ${relinked} links made again in git\n  ${zip} (${mb(zip)} MB)\n  ${dmg} (${mb(dmg)} MB)\n`);
