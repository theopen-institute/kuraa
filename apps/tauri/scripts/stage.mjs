// Gathers what the Tauri app is built from (decision 0127):
//
//   build/bridge.js, build/updates-bridge.js   the pages' bridges (src/bridge.ts, src/updates-bridge.ts),
//                                              which the shell puts in its windows (include_str!)
//   build/pages/                               the app's own pages (the Electron app's static/: the
//                                              starting page, the launcher, the updates window's)
//   src-tauri/staged/host/                     the hub (src/host.ts, bundled as kuraa-desktop.mjs), the
//                                              web client it serves, pandoc's and Typst's WebAssembly
//                                              with Typst's fonts (render/), and this platform's native
//                                              addons (native/): the app's resources, host/
//   src-tauri/staged/git/                      the git the Electron app ships (its scripts/fetch-git.mjs)
//
//   node scripts/stage.mjs              this computer's platform
//   node scripts/stage.mjs mac-x64      another's (its git and native addons)
//   node scripts/stage.mjs --bridge     only the bridges and pages (enough for `cargo check`)
//
// Build the web client first (pnpm --filter @kuraa/web build), and fetch git
// (node ../desktop/scripts/fetch-git.mjs <target>).
import { build } from 'esbuild';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { arch, argv, exit, platform, stdout } from 'node:process';
import { fetchFonts, fetchPandoc, typstCompiler } from '../../../scripts/fetch-render-tools.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const APP = resolve(import.meta.dirname, '..');
const BUILD = join(APP, 'build');
const STAGED = join(APP, 'src-tauri/staged');
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' };
const NODE_OS = { mac: 'darwin', win: 'win32', linux: 'linux' };
const NATIVE = ['sodium-native', 'udx-native'];

const onlyBridge = argv.includes('--bridge');
const target = argv.slice(2).find((a) => !a.startsWith('--')) ?? `${OS[platform] ?? platform}-${arch}`;
const [os, cpu] = target.split('-');
const version = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8')).version;

// The bridges, run in the pages before their own scripts: one file each, nothing loaded.
rmSync(BUILD, { recursive: true, force: true });
const page = { bundle: true, platform: 'browser', format: 'iife', target: ['safari15', 'chrome110', 'firefox115'], logLevel: 'warning', legalComments: 'none' };
await build({ ...page, entryPoints: [join(APP, 'src/bridge.ts')], outfile: join(BUILD, 'bridge.js') });
await build({ ...page, entryPoints: [join(APP, 'src/updates-bridge.ts')], outfile: join(BUILD, 'updates-bridge.js'), define: { __KURAA_VERSION__: JSON.stringify(version) } });
mkdirSync(join(BUILD, 'pages'), { recursive: true });
for (const p of ['starting.html', 'launcher.html', 'updates.html']) cpSync(join(ROOT, 'apps/desktop/static', p), join(BUILD, 'pages', p));
if (onlyBridge) {
  stdout.write(`stage: the bridges and pages, in ${BUILD}\n`);
  exit(0);
}

const web = join(ROOT, 'apps/web/dist');
if (!existsSync(join(web, 'index.html'))) throw new Error('Build the web client first: pnpm --filter @kuraa/web build');
const git = join(ROOT, 'apps/desktop/vendor/git', target);
if (!existsSync(join(git, 'bin')) && !existsSync(join(git, 'cmd'))) throw new Error(`No git for ${target} at ${git}: run node apps/desktop/scripts/fetch-git.mjs ${target}`);

rmSync(STAGED, { recursive: true, force: true });
const host = join(STAGED, 'host');

/** Where a native package is, as Hyperswarm finds it (through hyperdht). */
function packageDir(pkg) {
  const from = createRequire(join(ROOT, 'packages/host/package.json'));
  return dirname(createRequire(from.resolve('hyperdht')).resolve(`${pkg}/package.json`));
}
// Native addons load from native/<platform>-<arch>/ beside the bundle, as in the Electron app and the server.
const nativeAddons = {
  name: 'native-addons',
  setup(b) {
    b.onLoad({ filter: new RegExp(`[\\\\/](${NATIVE.join('|')})[\\\\/]binding\\.js$`) }, (args) => {
      const pkg = NATIVE.find((n) => args.path.includes(n));
      return { loader: 'js', contents: `module.exports = require(require('node:path').join(__dirname, 'native', process.platform + '-' + process.arch, ${JSON.stringify(`${pkg}.node`)}));` };
    });
  },
};
await build({
  entryPoints: [join(APP, 'src/host.ts')],
  outfile: join(host, 'kuraa-desktop.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  logLevel: 'warning',
  plugins: [nativeAddons],
  // CommonJS dependencies, in an ES module: require, __dirname and __filename as they expect.
  banner: {
    js: [
      "import { createRequire as __kuraaRequire } from 'node:module';",
      "import { fileURLToPath as __kuraaPath } from 'node:url';",
      "import { dirname as __kuraaDir } from 'node:path';",
      'const require = __kuraaRequire(import.meta.url);',
      'const __filename = __kuraaPath(import.meta.url);',
      'const __dirname = __kuraaDir(__filename);',
    ].join('\n'),
  },
});
const native = `${NODE_OS[os]}-${cpu}`;
for (const pkg of NATIVE) {
  const addon = join(packageDir(pkg), 'prebuilds', native, `${pkg}.node`);
  if (!existsSync(addon)) throw new Error(`${pkg} has no build for ${native}`);
  mkdirSync(join(host, 'native', native), { recursive: true });
  cpSync(addon, join(host, 'native', native, `${pkg}.node`));
}
cpSync(web, join(host, 'web'), { recursive: true });
// pandoc.wasm, with its licence, and Typst's (typst.ts) with its fonts, where @kuraa/render-pandoc looks
// beside the bundle (render/): Markdown rendered without Podman (0107, 0113), the same on every platform.
const fetched = (p) => !p.endsWith('.kuraa-fetched');
cpSync(await fetchPandoc(), join(host, 'render', 'pandoc'), { recursive: true, filter: fetched });
cpSync(await fetchFonts(), join(host, 'render', 'typst-fonts'), { recursive: true, filter: fetched });
cpSync(typstCompiler(), join(host, 'render', 'typst'), { recursive: true, filter: (p) => !/\.d\.ts$|wasm-pack-shim/.test(p) });
// Git's symbolic links (libexec/git-core: 145 of its commands by name, each a link to git, and git-remote-https
// and the like to git-remote-http) become two-line scripts that run what they pointed at: Tauri's bundler copies a
// link as the file it points at (148 copies of a 3.5 MB program: 520 MB), on every platform, in every package. Git
// runs its own commands as `git <command>`; a name like git-fetch is for whoever runs it by that name.
cpSync(git, join(STAGED, 'git'), { recursive: true, verbatimSymlinks: true, filter: (p) => !p.endsWith('.kuraa-git') });
let scripts = 0;
(function unlink(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) unlink(p);
    else if (st.isSymbolicLink()) {
      const to = basename(readlinkSync(p));
      const command = to === 'git' && name.startsWith('git-') ? `"$(dirname "$0")/git" ${name.slice(4)} "$@"` : `"$(dirname "$0")/${to}" "$@"`;
      rmSync(p);
      writeFileSync(p, `#!/bin/sh\nexec ${command}\n`, { mode: 0o755 });
      scripts++;
    }
  }
})(join(STAGED, 'git'));
stdout.write(`stage: ${STAGED} (kuraa ${version}, native ${native}, git ${target}, ${scripts} of its links made scripts)\n`);
