// Fetches what documents are rendered with outside Podman (decisions 0107,
// 0113): pandoc's WebAssembly build, and the fonts Typst comes with (its own
// program, a WebAssembly build of Typst, is the npm dependency
// @myriaddreamin/typst-ts-web-compiler of @kuraa/render-pandoc, pinned by the
// lockfile). Each download is checked against its checksum below. They are kept
// once per computer, in a cache folder every checkout shares
// (KURAA_RENDER_TOOLS, else the user's cache folder: kuraa/render-tools), where
// @kuraa/render-pandoc finds them in development. `--into <dir>` also puts all
// of it where a package is made from: <dir>/pandoc/, <dir>/typst/ (typst.ts's
// module and its glue) and <dir>/typst-fonts/.
//
//   node scripts/fetch-render-tools.mjs
//   node scripts/fetch-render-tools.mjs --into apps/desktop/vendor/render
//   node scripts/fetch-render-tools.mjs --quiet-fail     as pnpm install runs it: offline, say so and go on
//
// pandoc is GPL-2.0-or-later: its source is at https://github.com/jgm/pandoc at
// the tag below (its COPYING.md goes with it). typst.ts is Apache-2.0
// (https://github.com/Myriad-Dreamin/typst.ts). The fonts are typst-assets'
// (https://github.com/typst/typst-assets), each under its own licence (SIL Open
// Font License, GUST Font License, Bitstream Vera), which the font files carry.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, env, exit, pid, platform, stderr, stdout } from 'node:process';

export const PANDOC = {
  version: '3.14',
  url: 'https://github.com/jgm/pandoc/releases/download/3.14/pandoc-3.14-wasm.zip',
  sha256: '84e1023db1892cfdeb9ee518b8d95e6f6c667bbde7c99f24ec889a2099367ee5',
};
/** The fonts Typst comes with, as typst-assets has them at this tag (Typst's version). */
export const FONTS_TAG = 'v0.15.1';
const FONTS = [
  ['DejaVuSansMono-Bold.ttf', 'bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769'],
  ['DejaVuSansMono-BoldOblique.ttf', '91713a71d550bba22c2a6b2bb2a9ad8f9a159e12e4e9f0a5b2677998ba21213e'],
  ['DejaVuSansMono-Oblique.ttf', '742097840c541870e8d6dc5c9b37bb1ceeea6c0dedd1d475faf903ef9df734b0'],
  ['DejaVuSansMono.ttf', 'b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582'],
  ['LibertinusSerif-Bold.otf', '0264914210ed51b3231ebc92ce529e9f2e166ba9eebf0cd4a579558690a27b64'],
  ['LibertinusSerif-BoldItalic.otf', '47a665259f09f554f5d133d7718cdad43ff462c6a6b2328f38023465e62d57ce'],
  ['LibertinusSerif-Italic.otf', '9a393d63d6e05f620d3dc0190dfd35a8ede58c0808cf0fc9de7fcb9c723e4c24'],
  ['LibertinusSerif-Regular.otf', 'fcf06307a77367394fcb0ccb241e59eea70dba3d732be309647611224679c733'],
  ['LibertinusSerif-Semibold.otf', 'a4b3f28e85881db34695c1f005e4c79233a6caf3a2bd286c9b418c025fb99308'],
  ['LibertinusSerif-SemiboldItalic.otf', '397f0d7aba35ae6a988948ae046c14c6b1e0d270fcc6e292b8bc29fd625c6101'],
  ['NewCM10-Bold.otf', '40b0b32b63655fe802679ee4a14adb29c762a4712095d9c84cf7df7852b5152e'],
  ['NewCM10-BoldItalic.otf', 'fb53f43500c8ffbcc6dfdea5a519961d475543174ea2a0dcbe16c08510299fdf'],
  ['NewCM10-Italic.otf', 'a55d07607eec48889b6e7e7d51d7703c3beb915a39690f34fe01b4e2a744a9d6'],
  ['NewCM10-Regular.otf', '328698d764ccdf7acf6bc1088aefd83a237f6a1d8b812de1e77ac5e4483bf3d1'],
  ['NewCMMath-Bold.otf', 'c6c0e060da57d4f44274705afb956013047231dc62be5a4b02a351ab0dc43f2f'],
  ['NewCMMath-Book.otf', '2ea09ebc9167b1e1a66f31390dc917f2d4004ecfca72d51b28010e4ad6becd95'],
  ['NewCMMath-Regular.otf', 'd66ac1cc91c55c24d3636ae2df1238076debdff51841f9893fc5419cc2df3df7'],
];

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

/** A folder made whole before it takes its name (an interrupted fetch leaves nothing half there). */
async function fill(dir, make) {
  if (existsSync(join(dir, '.kuraa-fetched'))) return false;
  const tmp = `${dir}.${pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await make(tmp);
  writeFileSync(join(tmp, '.kuraa-fetched'), 'fetched\n');
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return true;
}

export async function fetchPandoc(cache = cacheDir()) {
  const dir = join(cache, `pandoc-${PANDOC.version}`);
  const fetched = await fill(dir, async (tmp) => {
    const archive = join(tmp, 'pandoc.zip');
    writeFileSync(archive, await download(PANDOC.url, PANDOC.sha256));
    try {
      // bsdtar (macOS, Windows) reads zip; on Linux, unzip.
      if (platform === 'linux') execFileSync('unzip', ['-q', archive, '-d', tmp]);
      else execFileSync('tar', ['-xf', archive, '-C', tmp]);
    } finally {
      rmSync(archive, { force: true });
    }
    // Its files up out of the folder they came in.
    const inner = readdirSync(tmp).find((n) => !n.startsWith('.'));
    for (const name of readdirSync(join(tmp, inner))) renameSync(join(tmp, inner, name), join(tmp, name));
    rmSync(join(tmp, inner), { recursive: true, force: true });
  });
  stdout.write(`pandoc ${PANDOC.version} (WebAssembly): ${fetched ? 'fetched' : 'already there'}\n`);
  return dir;
}

export async function fetchFonts(cache = cacheDir()) {
  const dir = join(cache, `typst-fonts-${FONTS_TAG}`);
  const fetched = await fill(dir, async (tmp) => {
    for (const [name, sha256] of FONTS) writeFileSync(join(tmp, name), await download(`https://raw.githubusercontent.com/typst/typst-assets/${FONTS_TAG}/files/fonts/${name}`, sha256));
  });
  stdout.write(`Typst's fonts (${FONTS_TAG}): ${fetched ? 'fetched' : 'already there'}\n`);
  return dir;
}

/** typst.ts's module and glue, as installed (the lockfile pins them). */
export function typstCompiler() {
  const require = createRequire(join(import.meta.dirname, '..', 'packages', 'render-pandoc', 'package.json'));
  return join(dirname(require.resolve('@myriaddreamin/typst-ts-web-compiler/package.json')), 'pkg');
}

async function main() {
  const args = argv.slice(2);
  const quiet = args.includes('--quiet-fail');
  const at = args.indexOf('--into');
  const into = at >= 0 ? resolve(args[at + 1]) : null;
  try {
    const pandoc = await fetchPandoc();
    const fonts = await fetchFonts();
    if (into) {
      const copy = (from, to, filter = () => true) => {
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith('.kuraa-fetched') && filter(p) });
      };
      copy(pandoc, join(into, 'pandoc'));
      copy(fonts, join(into, 'typst-fonts'));
      copy(typstCompiler(), join(into, 'typst'), (p) => !/\.d\.ts$|wasm-pack-shim/.test(p));
      stdout.write(`copied into ${into}\n`);
    }
  } catch (e) {
    if (!quiet) throw e;
    stderr.write(`Could not fetch pandoc and Typst's fonts (${e.message}); Markdown renders only where Podman runs until \`node scripts/fetch-render-tools.mjs\` succeeds.\n`);
    exit(0);
  }
}

if (resolve(argv[1] ?? '') === resolve(import.meta.filename)) await main();
