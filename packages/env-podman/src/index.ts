// The Podman environment plugin: each process runs in a locked-down container.
//
//   - the workspace is mounted read-only at /work (read-write only if the policy
//     allows), with .git hidden; a scratch folder read-write at /scratch; the
//     engine's files read-only at /kuraa; nothing else of the host is visible
//   - no network unless the policy allows it
//   - read-only root file system, a private /tmp, all capabilities dropped,
//     no privilege escalation, limits on memory, CPUs and processes
//   - the host user's id inside (keep-id), not root, so it can write scratch
//
// Images come from the engine's recipe (a Containerfile), built once and
// reused; the tag is a hash of the recipe. On macOS, Podman runs containers in
// its own Linux virtual machine, so there is that boundary too.
//
// Operator options: { "podman": "/path/to/podman" }.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { definePlugin, findExecutable, mappedView, type Environment, type ImageRecipe, type Mount, type Policy, type SandboxProcess, type StartRequest } from '@kuraa/run-kit';

const run = promisify(execFile);
const OWN_GROUP = process.platform !== 'win32';
export const INSIDE = { workspace: '/work', scratch: '/scratch', files: '/kuraa' };

interface Options { podman?: string }

/** Whether Podman is installed and answering (for tests and tools that must skip without it). Blocks up to 15 s. */
export function podmanWorks(options?: unknown): boolean {
  const podman = findPodman(options);
  if (!podman) return false;
  try {
    execFileSync(podman, ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function findPodman(options?: unknown): string | null {
  const explicit = (options as Options | undefined)?.podman ?? process.env.KURAA_PODMAN;
  return findExecutable(explicit ?? 'podman', ['/opt/podman/bin', '/opt/homebrew/bin', '/usr/local/bin']);
}

/** The image tag for a recipe: the same recipe always gives the same tag. */
export function imageTag(recipe: ImageRecipe): string {
  const hash = createHash('sha256').update(recipe.containerfile).update(JSON.stringify(recipe.context ?? {})).digest('hex');
  return `localhost/kuraa-env:${hash.slice(0, 16)}`;
}

/** `podman run` arguments for a session, from the policy. */
export function runArgs(opts: {
  name: string; tag: string; policy: Policy;
  workspace: string; scratch: string; files: string; mounts?: Mount[];
  argv: string[]; cwd: string; env?: Record<string, string>;
}): string[] {
  const { policy } = opts;
  return [
    // --sig-proxy=false: signals to the podman process stay there. Passed on, one
    // SIGINT reached the container twice; interrupts go through podman kill instead.
    'run', '--rm', '--interactive', '--sig-proxy=false', '--name', opts.name, '--label', 'kuraa=session',
    ...(policy.network ? [] : ['--network=none']),
    '--read-only', '--tmpfs=/tmp:rw,size=1g,mode=1777',
    '--cap-drop=all', '--security-opt=no-new-privileges',
    `--pids-limit=${policy.pids}`, `--memory=${policy.memory}`, `--cpus=${policy.cpus}`,
    '--userns=keep-id',
    '--env=HOME=/tmp',
    ...Object.entries(opts.env ?? {}).map(([k, v]) => `--env=${k}=${v}`),
    ...(policy.workspace === 'none' ? [] : [
      `--volume=${opts.workspace}:${INSIDE.workspace}:${policy.workspace === 'read-write' ? 'rw' : 'ro'}`,
      // Hidden paths: an empty, inaccessible tmpfs over each. notmpcopyup matters:
      // by default Podman copies what is already at the path into the tmpfs, which
      // would put a copy of .git inside instead of hiding it.
      ...policy.hide.map((p) => `--mount=type=tmpfs,destination=${INSIDE.workspace}/${p.replace(/^\/+|\/+$/g, '')},tmpfs-size=4k,tmpfs-mode=0,notmpcopyup`),
    ]),
    `--volume=${opts.scratch}:${INSIDE.scratch}:rw`,
    `--volume=${opts.files}:${INSIDE.files}:ro`,
    ...(opts.mounts ?? []).map((m) => `--volume=${m.host}:${m.inside}:${m.access === 'read-write' ? 'rw' : 'ro'}`),
    `--workdir=${opts.cwd}`,
    opts.tag,
    ...opts.argv,
  ];
}

async function ensureImage(podman: string, recipe: ImageRecipe, req: StartRequest): Promise<string> {
  const tag = imageTag(recipe);
  const exists = await run(podman, ['image', 'exists', tag]).then(() => true, () => false);
  if (exists) return tag;
  req.status('Building the environment. The first time takes a few minutes.');
  req.log(`building ${tag}`);
  const dir = await mkdtemp(join(tmpdir(), 'kuraa-build-'));
  try {
    await writeFile(join(dir, 'Containerfile'), recipe.containerfile);
    for (const [name, content] of Object.entries(recipe.context ?? {})) await writeFile(join(dir, name), content);
    let tail = '';
    await new Promise<void>((resolve, reject) => {
      const build = spawn(podman, ['build', '--tag', tag, '--file', join(dir, 'Containerfile'), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      const keep = (d: Buffer) => {
        const text = d.toString();
        tail = (tail + text).slice(-4000);
        for (const line of text.split('\n')) if (line.trim()) req.log(`build: ${line.trim()}`);
      };
      build.stdout.on('data', keep);
      build.stderr.on('data', keep);
      build.once('error', reject);
      build.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Building the environment failed:\n${tail.trim().split('\n').slice(-12).join('\n')}`))));
    });
    return tag;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const podmanEnvironment: Environment = {
  id: 'podman',
  label: 'in a Podman container',
  description: 'A container with no network, the workspace read-only and .git hidden, and nothing else of this computer visible.',
  sandboxed: true,

  async check(options) {
    const podman = findPodman(options);
    if (!podman) return { available: false, message: 'Podman is not installed. Install it (on a Mac: brew install podman), then run podman machine init and podman machine start.' };
    try {
      await run(podman, ['info', '--format', '{{.Host.Arch}}'], { timeout: 15_000 });
      return { available: true, message: 'Code runs in a container with no network and only this workspace visible, read-only.' };
    } catch (e) {
      const why = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n')[0];
      const hint = process.platform === 'darwin' || process.platform === 'win32' ? ' Start it with: podman machine start' : '';
      return { available: false, message: `Podman is installed but not working: ${why}.${hint}` };
    }
  },

  async start(req, options) {
    const podman = findPodman(options);
    if (!podman) throw new Error('Podman is not installed.');
    if (!req.image) throw new Error('This engine has no container recipe, so it cannot run in Podman.');
    const tag = await ensureImage(podman, req.image, req);
    const view = mappedView(req, INSIDE, req.mounts);
    const { argv, cwd, env } = req.command(view);
    const name = `kuraa-${req.name}-${randomBytes(4).toString('hex')}`;
    const child = spawn(podman, runArgs({ name, tag, policy: req.policy, workspace: req.workspace, scratch: req.scratch, files: req.files, mounts: req.mounts, argv, cwd, env }), {
      detached: OWN_GROUP, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (e) => {
        req.log(`podman: ${e.message}`);
        resolve({ code: null, signal: null });
      });
    });
    const proc: SandboxProcess = {
      stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, view, exited,
      // Exactly one SIGINT, to the process in the container.
      interrupt: () => void run(podman, ['kill', '--signal=SIGINT', name]).catch((e: Error) => req.log(`podman kill: ${e.message}`)),
      kill: () => {
        void run(podman, ['kill', name]).catch(() => undefined);
        child.kill('SIGKILL');
      },
    };
    return proc;
  },
};

export default definePlugin({ name: '@kuraa/env-podman', environments: [podmanEnvironment] });
