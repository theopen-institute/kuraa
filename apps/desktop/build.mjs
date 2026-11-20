// Bundles the Electron main process (which embeds the host) and the preload
// script, and copies the web client build next to them. Everything the app runs
// is in build/, with no node_modules, so packaging it (package.mjs) needs no
// dependencies collected.
//
// Hyperswarm's native parts (sodium-native, udx-native) load their compiled
// addons from beside their own files; here they load them from build/native,
// copied there for each platform the app ships on.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stdout } from 'node:process';

const NATIVE = ['sodium-native', 'udx-native'];
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'];

/** Where a native package is, as Hyperswarm finds it (through hyperdht). */
function packageDir(name) {
  const fromHyperswarm = createRequire(createRequire(import.meta.url).resolve('hyperdht'));
  return dirname(fromHyperswarm.resolve(`${name}/package.json`));
}

const nativeAddons = {
  name: 'native-addons',
  setup(b) {
    b.onLoad({ filter: new RegExp(`[\\\\/](${NATIVE.join('|')})[\\\\/]binding\\.js$`) }, (args) => {
      const name = NATIVE.find((n) => args.path.includes(n));
      return { loader: 'js', contents: `module.exports = require(require('node:path').join(__dirname, 'native', process.platform + '-' + process.arch, ${JSON.stringify(`${name}.node`)}));` };
    });
  },
};

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });
const common = { bundle: true, format: 'cjs', external: ['electron'], sourcemap: 'inline', logLevel: 'warning' };
await build({
  ...common, platform: 'node', target: 'node22', entryPoints: ['src/main.ts'], outfile: 'build/main.cjs', plugins: [nativeAddons],
  // Some dependencies call createRequire(import.meta.url), which a CommonJS bundle lacks.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});
for (const name of NATIVE) {
  const dir = packageDir(name);
  for (const p of PLATFORMS) {
    const addon = join(dir, 'prebuilds', p, `${name}.node`);
    if (!existsSync(addon)) throw new Error(`${name} has no build for ${p}`);
    mkdirSync(join('build/native', p), { recursive: true });
    cpSync(addon, join('build/native', p, `${name}.node`));
  }
}
// The preload runs sandboxed, where require() offers little beyond 'electron': no shim, no Node built-ins.
await build({ ...common, platform: 'browser', target: 'chrome140', entryPoints: ['src/preload.ts'], outfile: 'build/preload.cjs' });
if (!existsSync('../web/dist/index.html')) throw new Error('Build the web client first: pnpm --filter @kuraa/web build');
cpSync('../web/dist', 'build/web', { recursive: true });
cpSync('static', 'build/static', { recursive: true });
stdout.write('desktop: built to apps/desktop/build\n');
