// Bundles the Electron main process (which embeds the host) and the preload
// script, and copies the web client build next to them.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { stdout } from 'node:process';

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });
const common = { bundle: true, format: 'cjs', external: ['electron'], sourcemap: 'inline', logLevel: 'warning' };
// Hyperswarm finds its native parts (sodium, udx) next to its own files: it is loaded from node_modules, not bundled.
const NATIVE = ['hyperswarm', 'hypercore-crypto', 'hyperdht'];
await build({
  ...common, external: [...common.external, ...NATIVE], platform: 'node', target: 'node22', entryPoints: ['src/main.ts'], outfile: 'build/main.cjs',
  // Some dependencies call createRequire(import.meta.url), which a CommonJS bundle lacks.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});
// The preload runs sandboxed, where require() offers little beyond 'electron': no shim, no Node built-ins.
await build({ ...common, platform: 'browser', target: 'chrome140', entryPoints: ['src/preload.ts'], outfile: 'build/preload.cjs' });
if (!existsSync('../web/dist/index.html')) throw new Error('Build the web client first: pnpm --filter @kuraa/web build');
cpSync('../web/dist', 'build/web', { recursive: true });
cpSync('static', 'build/static', { recursive: true });
stdout.write('desktop: built to apps/desktop/build\n');
