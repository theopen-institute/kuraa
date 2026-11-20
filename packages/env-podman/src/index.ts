// The Podman environment component: each process runs in a locked-down container.
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
// reused; the tag is a hash of the recipe. On macOS and Windows, Podman runs
// containers in its own Linux virtual machine, so there is that boundary too.
// On Windows, folders are passed to it as they are (C:\Users\…): Podman (4.1 and
// later) turns them into the machine's paths for them (/mnt/c/Users/…).
//
// Limits on writing (the policy's `disk`): the root file system is read-only;
// /tmp is a tmpfs, so memory, of at most 1g (and no more than `disk`); scratch
// is a folder of this computer's, shared in, which Podman cannot limit the same
// way on a Mac and on Linux. So it is measured, every second, from this side,
// and a process that has written more than `disk` there (or made more than
// 100,000 files) is ended, saying why. It can overshoot by what it writes in a
// second, never by more.
//
// Containers are labelled with the process that started them (its id, and this
// computer's name). A host that crashed leaves its containers running; the
// first time this environment is used in a process, it removes those whose
// process is gone, on this computer, never another live host's.
//
// Operator options: { "podman": "/path/to/podman" }.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineRunComponent, findExecutable, mappedView, parseSize, type Environment, type ImageRecipe, type Mount, type Policy, type SandboxProcess, type StartRequest } from '@kuraa/run-kit';

const run = promisify(execFile);
const OWN_GROUP = process.platform !== 'win32';
export const INSIDE = { workspace: '/work', scratch: '/scratch', files: '/kuraa' };
/**
 * Who started a container: this process (its id, and when it started, in
 * seconds, as ids are reused), on this computer. The same for every host in
 * the process (a hub runs many), and for its worker threads.
 */
export const OWNER = { pid: String(process.pid), started: String(Math.round(Date.now() / 1000 - process.uptime())), machine: hostname() };
/** The most files a process may make in scratch. */
const MAX_FILES = 100_000;
/** How often scratch is measured. */
const MEASURE_MS = 1000;
const GiB = 1024 ** 3;

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
  // Where the installers put it, for an app whose PATH is from before Podman was installed.
  const installed = process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'RedHat', 'Podman')] : ['/opt/podman/bin', '/opt/homebrew/bin', '/usr/local/bin'];
  return findExecutable(explicit ?? 'podman', installed);
}

/** Podman's name for the machine's architecture (Go's: amd64, arm64) as `uname -m` gives it, which tools use. */
export function archOf(podmanArch: string): { arch?: string } {
  const a = podmanArch.trim();
  const arch = ({ amd64: 'x86_64', arm64: 'aarch64', '386': 'i686', arm: 'armv7l' } as Record<string, string>)[a] ?? a;
  return /^[a-z0-9_]+$/.test(arch) ? { arch } : {};
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
    `--label=kuraa.owner=${OWNER.pid}`, `--label=kuraa.started=${OWNER.started}`, `--label=kuraa.machine=${OWNER.machine}`,
    ...(policy.network ? [] : ['--network=none']),
    '--read-only', `--tmpfs=/tmp:rw,size=${Math.min(parseSize(policy.disk) ?? GiB, GiB)},mode=1777`,
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
    // Our program, not the image's ENTRYPOINT with our command as its arguments:
    // an image a workspace names must not decide what runs.
    `--entrypoint=${JSON.stringify(opts.argv.slice(0, 1))}`,
    opts.tag,
    ...opts.argv.slice(1),
  ];
}

/** Bytes and entries under `dir`, not following links, stopping once either passes its limit. */
export async function usage(dir: string, maxBytes: number, maxEntries = MAX_FILES): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length && bytes <= maxBytes && entries <= maxEntries) {
    const d = stack.pop()!;
    let found: Dirent[];
    try {
      found = await readdir(d, { withFileTypes: true });
    } catch {
      continue; // removed meanwhile
    }
    for (const e of found) {
      entries++;
      const path = join(d, e.name);
      if (e.isDirectory()) stack.push(path);
      else bytes += await lstat(path).then((st) => st.size, () => 0);
    }
  }
  return { bytes, entries };
}

/**
 * Remove kuraa containers that a process on this computer started and that
 * process is gone (a host that crashed). Those of live processes, of other
 * computers sharing this Podman, and without an owner (older hosts) are left.
 */
export async function removeOrphans(podman: string, log: (m: string) => void = () => undefined): Promise<string[]> {
  const { stdout } = await run(podman, ['ps', '--all', '--filter', 'label=kuraa=session', '--format', 'json'], { timeout: 30_000 });
  const listed = (JSON.parse(stdout || '[]') ?? []) as { Id?: string; Labels?: Record<string, string> | null }[];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'; // someone else's: alive
    }
  };
  const orphans = listed.filter((c) => {
    const labels = c.Labels ?? {};
    const pid = Number(labels['kuraa.owner']);
    if (!c.Id || labels['kuraa.machine'] !== OWNER.machine || !Number.isInteger(pid) || pid <= 0) return false;
    // This process's id, from another process that had it before (a second or two of leeway: clocks).
    if (String(pid) === OWNER.pid) return Math.abs(Number(labels['kuraa.started']) - Number(OWNER.started)) > 2;
    return !alive(pid);
  }).map((c) => c.Id!);
  if (orphans.length) {
    log(`removing ${orphans.length} container(s) left by hosts that are gone`);
    await run(podman, ['rm', '--force', ...orphans], { timeout: 60_000 });
  }
  return orphans;
}

/** Orphans are looked for once per process, the first time a process starts. */
let cleaned: Promise<unknown> | null = null;

/** Builds under way, by tag: sessions that start together wait for one build, not one each. */
const builds = new Map<string, { done: Promise<string>; waiting: StartRequest[]; building: boolean }>();
const BUILDING = 'Building the environment. The first time takes a few minutes.';

function ensureImage(podman: string, recipe: ImageRecipe, req: StartRequest): Promise<string> {
  const tag = imageTag(recipe);
  const under = builds.get(tag);
  if (under) {
    under.waiting.push(req);
    if (under.building) req.status(BUILDING);
    return under.done;
  }
  const entry = { waiting: [req], building: false, done: Promise.resolve(tag) };
  entry.done = ensureImageNow(podman, tag, recipe, entry).finally(() => builds.delete(tag));
  builds.set(tag, entry);
  return entry.done;
}

async function ensureImageNow(podman: string, tag: string, recipe: ImageRecipe, entry: { waiting: StartRequest[]; building: boolean }): Promise<string> {
  const exists = await run(podman, ['image', 'exists', tag]).then(() => true, () => false);
  if (exists) return tag;
  entry.building = true;
  for (const r of entry.waiting) r.status(BUILDING);
  const req = entry.waiting[0]!;
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
    if (!podman) {
      const how = process.platform === 'win32' ? 'Install it from podman.io (it uses WSL)' : 'Install it (on a Mac: brew install podman)';
      return { available: false, message: `Podman is not installed. ${how}, then run podman machine init and podman machine start.` };
    }
    try {
      const { stdout } = await run(podman, ['info', '--format', '{{.Host.Arch}}'], { timeout: 15_000 });
      return { available: true, message: 'Code runs in a container with no network and only this workspace visible, read-only.', ...archOf(stdout) };
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
    // Container names allow letters, digits and _.- only; the engine's name is not checked elsewhere.
    const name = `kuraa-${req.name.replace(/[^A-Za-z0-9_.-]/g, '-')}-${randomBytes(4).toString('hex')}`;
    cleaned ??= removeOrphans(podman, req.log).catch((e: Error) => req.log(`podman: could not look for containers left behind: ${e.message}`));
    const limit = parseSize(req.policy.disk);
    if (limit === null) throw new Error(`Not a size: "${req.policy.disk}".`);
    const child = spawn(podman, runArgs({ name, tag, policy: req.policy, workspace: req.workspace, scratch: req.scratch, files: req.files, mounts: req.mounts, argv, cwd, env }), {
      detached: OWN_GROUP, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Writing to a process that has gone fails; the engine finds out from `exited`, and the host must not crash.
    child.stdin!.on('error', (e) => req.log(`podman: input: ${e.message}`));
    const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      // 'close' comes once stdout and stderr have been read to the end, so the
      // engine has the process's last words (an installer's result, say). If
      // something else holds the pipes open, 'exit' plus a moment will do.
      let late: ReturnType<typeof setTimeout> | undefined;
      child.once('exit', (code, signal) => (late = setTimeout(() => resolve({ code, signal }), 2000)));
      child.once('close', (code, signal) => {
        clearTimeout(late);
        resolve({ code, signal });
      });
      child.once('error', (e) => {
        req.log(`podman: ${e.message}`);
        resolve({ code: null, signal: null });
      });
    });
    const kill = () => {
      void run(podman, ['kill', name]).catch(() => undefined);
      child.kill('SIGKILL');
    };
    // What it writes to scratch, measured from here (see the top of this file).
    let reason: string | undefined;
    let measuring = false;
    const watch = setInterval(() => {
      if (measuring) return;
      measuring = true;
      void usage(req.scratch, limit).then(({ bytes, entries }) => {
        measuring = false;
        if (reason || (bytes <= limit && entries <= MAX_FILES)) return;
        reason = bytes > limit
          ? `It wrote more than ${req.policy.disk} of files, the most this host allows.`
          : `It made more than ${MAX_FILES} files, the most this host allows.`;
        req.log(`podman: ${name}: ${reason}`);
        kill();
      });
    }, MEASURE_MS);
    watch.unref();
    const exited = ended.then((r) => {
      clearInterval(watch);
      return reason ? { ...r, reason } : r;
    });
    const proc: SandboxProcess = {
      stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, view, exited,
      // Exactly one SIGINT, to the process in the container.
      interrupt: () => void run(podman, ['kill', '--signal=SIGINT', name]).catch((e: Error) => req.log(`podman kill: ${e.message}`)),
      kill,
    };
    return proc;
  },
};

export default defineRunComponent({ name: '@kuraa/env-podman', environments: [podmanEnvironment] });
