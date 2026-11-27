// `pnpm server`: the server's command line, run from the repository (cli.ts; released, `kuraa-host server`).
import { runServerCli } from './cli.js';

await runServerCli(process.argv.slice(2));
