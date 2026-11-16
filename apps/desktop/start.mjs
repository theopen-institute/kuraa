// Launch the built app with Electron, passing arguments through
// (e.g. `pnpm desktop -- --open ~/notes`). Some editors' terminals set
// ELECTRON_RUN_AS_NODE, which would start Electron as plain Node, so it is cleared.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { argv, env, exit } from 'node:process';

const electron = createRequire(import.meta.url)('electron');
const childEnv = { ...env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...argv.slice(2).filter((a) => a !== '--')], { stdio: 'inherit', env: childEnv });
child.on('exit', (code) => exit(code ?? 0));
