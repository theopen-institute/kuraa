// Bundles the Electron main process (which embeds the host) and the preload
// script, and copies the web client build next to them.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { stdout } from 'node:process';

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });
const common = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: 'inline', logLevel: 'warning',
  // Some dependencies call createRequire(import.meta.url), which a CommonJS bundle lacks.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
};
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'build/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'build/preload.cjs' });
if (!existsSync('../web/dist/index.html')) throw new Error('Build the web client first: pnpm --filter @kuraa/web build');
cpSync('../web/dist', 'build/web', { recursive: true });
cpSync('static', 'build/static', { recursive: true });
stdout.write('desktop: built to apps/desktop/build\n');
