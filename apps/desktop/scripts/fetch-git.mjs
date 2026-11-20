// Fetches the git the packaged app ships: GitHub Desktop's builds of it
// (dugite-native), made to run from any folder. One per platform and processor,
// into vendor/git/<os>-<arch> (os as electron-builder names it: mac, win, linux).
// Each download is checked against its checksum below, and Git Credential Manager
// and git-lfs, which the app does not use, are left out (most of the size), as are git's translations.
//
//   node scripts/fetch-git.mjs                 this computer's
//   node scripts/fetch-git.mjs mac-arm64 mac-x64 win-x64
//
// Git is GPLv2: its source is at https://github.com/git/git at the tag below,
// and dugite-native's at https://github.com/desktop/dugite-native.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arch, argv, platform, stdout } from 'node:process';

const RELEASE = 'v2.56.0-2';
const BUILD = 'dugite-native-v2.56.0-a44aeca';
/** Target → the release's name for it, and its sha256. */
const TARGETS = {
  'mac-arm64': ['macOS-arm64', '1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7'],
  'mac-x64': ['macOS-x64', '52cc663281e1ec2f1d76ba781193ca4847e62dbbf767f6c99ec9ec5b978a7659'],
  'win-x64': ['windows-x64', 'f1e17876337d7be143e5d51976da36643d65528125cfbc14d57f171de0fd5f14'],
  'win-arm64': ['windows-arm64', '1834e7817589f25f97ae0f309ef4733578a6b8dbd438ed29f898d075e6ead4c2'],
  'linux-x64': ['ubuntu-x64', '1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9'],
  'linux-arm64': ['ubuntu-arm64', 'd5ce120515bf3013a014e6a918aa87ec0f7a6f5f9687c48d50127e637cb9b6c2'],
};

const VENDOR = resolve(import.meta.dirname, '../vendor/git');
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' };

/** Git Credential Manager (a .NET program, with its runtime) and git-lfs. */
const UNUSED = /^(git-credential-manager|git-lfs|gcmcore|Atlassian\.|Avalonia|GitHub\.dll|GitLab\.dll|HarfBuzzSharp|libHarfBuzzSharp|SkiaSharp|libSkiaSharp|MicroCom|Microsoft\.|System\.|Tmds\.|WindowsBase|mscorlib|netstandard|libclr|libcoreclr|libhost|libmscord|libSystem\.|libAvaloniaNative|msalruntime|av_libglesv2|createdump|uninstall\.sh|git-update-git-for-windows)/;
/** The credential manager's translations, beside it in git-core. */
const LOCALES = /^(cs|de|es|fr|it|ja|ko|pl|pt-BR|ru|tr|zh-Hans|zh-Hant)$/;

function prune(dir) {
  // Git's own translations: the app shows git's messages rarely, and in English.
  for (const sub of ['share/locale', 'ucrt64/share/locale']) rmSync(join(dir, sub), { recursive: true, force: true });
  for (const sub of ['libexec/git-core', 'ucrt64/bin', 'ucrt64/libexec/git-core']) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (UNUSED.test(name) || (sub === 'libexec/git-core' && LOCALES.test(name))) rmSync(join(d, name), { recursive: true, force: true });
    }
  }
}

async function fetchGit(target) {
  const known = TARGETS[target];
  if (!known) throw new Error(`Unknown target ${target}. Known: ${Object.keys(TARGETS).join(', ')}`);
  const [name, sha256] = known;
  const dir = join(VENDOR, target);
  const stamp = join(dir, '.kuraa-git');
  if (existsSync(stamp)) return stdout.write(`git: ${target} already there\n`);
  const url = `https://github.com/desktop/dugite-native/releases/download/${RELEASE}/${BUILD}-${name}.tar.gz`;
  stdout.write(`git: fetching ${target}\n`);
  const res = await globalThis.fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${url}: checksum ${got}, expected ${sha256}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(VENDOR, `${target}.tar.gz`);
  writeFileSync(archive, bytes);
  try {
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
  } finally {
    rmSync(archive, { force: true });
  }
  prune(dir);
  writeFileSync(stamp, `${BUILD}\n`);
}

const targets = argv.slice(2).length ? argv.slice(2) : [`${OS[platform]}-${arch}`];
for (const t of targets) await fetchGit(t);
