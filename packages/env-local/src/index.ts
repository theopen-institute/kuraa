// The local environment: a plain process on the host, as the host's user.
// It enforces no policy (it can read and write whatever you can, and use the
// network), so it is marked as not sandboxed and is never a default.
import { spawn } from 'node:child_process';
import { definePlugin, findExecutable, mappedView, type Environment, type SandboxProcess } from '@kuraa/run-kit';

// Its own process group, so Ctrl+C in the host's terminal does not reach it; the
// host decides when it stops. (Not on Windows: a detached child gets a console.)
const OWN_GROUP = process.platform !== 'win32';

export const localEnvironment: Environment = {
  id: 'local',
  label: 'on this computer (not sandboxed)',
  sandboxed: false,

  async check() {
    return { available: true, message: 'Code runs as you, with access to your files and the network.' };
  },

  async start(req) {
    const view = mappedView(req, req);
    const { argv, cwd, env } = req.command(view);
    const program = findExecutable(argv[0]!, req.searchPaths);
    if (!program) throw new Error(`${argv[0]} was not found on this computer.`);
    const child = spawn(program, argv.slice(1), {
      cwd, env: { ...process.env, ...env }, detached: OWN_GROUP, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (e) => {
        req.log(`could not start ${program}: ${e.message}`);
        resolve({ code: null, signal: null });
      });
    });
    const proc: SandboxProcess = {
      stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, view, exited,
      interrupt: () => void child.kill('SIGINT'),
      kill: () => void child.kill('SIGKILL'),
    };
    return proc;
  },
};

export default definePlugin({ name: '@kuraa/env-local', environments: [localEnvironment] });
