// The Podman environment without Podman: the policy as flags, image tags, what it
// says when Podman is missing or stopped, and the build-then-run sequence against
// a stand-in `podman` that records its arguments. A real run is in host tests,
// skipped where Podman is not installed.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, type StartRequest } from '@kuraa/run-kit';
import { imageTag, OWNER, podmanEnvironment, removeOrphans, runArgs, usage } from '../src/index.js';

const base = { name: 'kuraa-r-1', tag: 'localhost/kuraa-env:abc', workspace: '/Users/p/notes', scratch: '/Users/p/notes/.git/kuraa/run/scratch/x', files: '/Users/p/notes/.git/kuraa/run/engines/r', argv: ['Rscript', '/kuraa/driver.R'], cwd: '/work' };

describe('podman run arguments', () => {
  it('lock the container down by default', () => {
    const args = runArgs({ ...base, policy: DEFAULT_POLICY });
    expect(args).toEqual(expect.arrayContaining([
      '--network=none', '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges', '--userns=keep-id',
      '--pids-limit=512', '--memory=4g', '--cpus=2',
      '--volume=/Users/p/notes:/work:ro',
      '--volume=/Users/p/notes/.git/kuraa/run/scratch/x:/scratch:rw',
      '--volume=/Users/p/notes/.git/kuraa/run/engines/r:/kuraa:ro',
      '--mount=type=tmpfs,destination=/work/.git,tmpfs-size=4k,tmpfs-mode=0,notmpcopyup',
      `--tmpfs=/tmp:rw,size=${1024 ** 3},mode=1777`,
      `--label=kuraa.owner=${process.pid}`,
    ]));
    // Nothing else of the host is mounted, and the command comes last, after the
    // image, its program as the entrypoint: the image's own cannot wrap it.
    expect(args.filter((a) => a.startsWith('--volume='))).toHaveLength(3);
    expect(args.slice(-3)).toEqual(['--entrypoint=["Rscript"]', 'localhost/kuraa-env:abc', '/kuraa/driver.R']);
    expect(runArgs({ ...base, policy: { ...DEFAULT_POLICY, disk: '100m' } })).toContain(`--tmpfs=/tmp:rw,size=${100 * 1024 ** 2},mode=1777`);
  });

  it('hide a file by putting an empty one over it, and a folder by an empty, closed one (0066)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-podman-hide-'));
    mkdirSync(join(dir, 'private'));
    writeFileSync(join(dir, 'plan.md'), 'secret');
    const args = runArgs({ ...base, workspace: dir, policy: { ...DEFAULT_POLICY, hide: ['.git', 'plan.md', 'private'] } });
    expect(args).toContain('--mount=type=bind,source=/dev/null,destination=/work/plan.md,readonly');
    expect(args).toContain('--mount=type=tmpfs,destination=/work/private,tmpfs-size=4k,tmpfs-mode=0,notmpcopyup');
    rmSync(dir, { recursive: true, force: true });
  });

  it('open up only what the policy allows', () => {
    const args = runArgs({ ...base, policy: { ...DEFAULT_POLICY, workspace: 'read-write', network: true, memory: '8g' } });
    expect(args).toContain('--volume=/Users/p/notes:/work:rw');
    expect(args).not.toContain('--network=none');
    expect(args).toContain('--memory=8g');
    expect(args).toContain('--mount=type=tmpfs,destination=/work/.git,tmpfs-size=4k,tmpfs-mode=0,notmpcopyup');
  });
});

describe('images', () => {
  it('are tagged by their recipe', () => {
    const a = imageTag({ containerfile: 'FROM x\n' });
    expect(a).toMatch(/^localhost\/kuraa-env:[0-9a-f]{16}$/);
    expect(imageTag({ containerfile: 'FROM x\n' })).toBe(a);
    expect(imageTag({ containerfile: 'FROM y\n' })).not.toBe(a);
    expect(imageTag({ containerfile: 'FROM x\n', context: { 'renv.lock': '{}' } })).not.toBe(a);
  });
});

/** A stand-in podman: records each call; `image exists` fails, `info` per `infoOk`, `run` echoes stdin. */
function fakePodman(infoOk: boolean): { bin: string; dir: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-fakepodman-'));
  const log = join(dir, 'calls');
  const bin = join(dir, 'podman');
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  ps) cat "${dir}/ps.json" 2>/dev/null || echo '[]' ;;
  rm|kill) exit 0 ;;
  info) ${infoOk ? 'echo arm64; exit 0' : 'echo "Cannot connect to Podman: is the machine running?" >&2; exit 125'} ;;
  image) exit 1 ;;
  build) echo "STEP 1/2: FROM x"; exit 0 ;;
  run) exec cat ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, dir, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter((c) => !c.startsWith('ps ')) };
}

describe('podman environment', () => {
  it('says how to install Podman when it is missing', async () => {
    expect(await podmanEnvironment.check({ podman: '/nonexistent/podman' })).toEqual({
      available: false,
      message: 'Podman is not installed. Install it (on a Mac: brew install podman), then run podman machine init and podman machine start.',
    });
  });

  it('says it is not working when podman info fails', async () => {
    const { bin } = fakePodman(false);
    const status = await podmanEnvironment.check({ podman: bin });
    expect(status.available).toBe(false);
    expect(status.message).toContain('Podman is installed but not working: Cannot connect to Podman: is the machine running?');
  });

  it('builds the image once from the recipe, then runs the command in it', async () => {
    const { bin, calls } = fakePodman(true);
    expect((await podmanEnvironment.check({ podman: bin })).available).toBe(true);
    const ws = mkdtempSync(join(tmpdir(), 'kuraa-ws-'));
    const statuses: string[] = [];
    const req: StartRequest = {
      name: 'r', workspace: ws, scratch: join(ws, 'scratch'), files: join(ws, 'files'), policy: DEFAULT_POLICY,
      image: { containerfile: 'FROM docker.io/rocker/r-ver:4.5\n' },
      command: (view) => ({ argv: ['Rscript', `${view.files}/driver.R`], cwd: view.inside(join(ws, 'reports')) }),
      log: () => undefined,
      status: (m) => statuses.push(m),
    };
    const proc = await podmanEnvironment.start(req, { podman: bin });
    // The process is `podman run`, here a stand-in that echoes: the pipes work.
    proc.stdin.write('ping\n');
    const echoed = await new Promise<string>((resolve) => proc.stdout.once('data', (d: Buffer) => resolve(d.toString())));
    expect(echoed).toBe('ping\n');
    proc.stdin.end();
    await proc.exited;

    const [info, exists, build, run] = calls();
    expect(info).toBe('info --format {{.Host.Arch}}');
    expect(exists).toMatch(/^image exists localhost\/kuraa-env:[0-9a-f]{16}$/);
    expect(build).toMatch(/^build --tag localhost\/kuraa-env:[0-9a-f]{16} --file .*Containerfile /);
    expect(run).toContain('--workdir=/work/reports');
    expect(run).toMatch(/--entrypoint=\["Rscript"\] localhost\/kuraa-env:[0-9a-f]{16} \/kuraa\/driver\.R$/);
    expect(statuses).toEqual(['Building the environment. The first time takes a few minutes.']);
    expect(proc.view.outside('/scratch/plots/a.png')).toBe(join(ws, 'scratch/plots/a.png'));
  });
});

describe('limits and leftovers', () => {
  const request = (ws: string, disk: string): StartRequest => ({
    name: 'r', workspace: ws, scratch: join(ws, 'scratch'), files: join(ws, 'files'), policy: { ...DEFAULT_POLICY, disk },
    image: { containerfile: 'FROM x\n' },
    command: () => ({ argv: ['Rscript', '/kuraa/driver.R'], cwd: '/work' }),
    log: () => undefined, status: () => undefined,
  });

  it('measures what is written, not following links, and stops counting past the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-usage-'));
    mkdirSync(join(dir, 'a/b'), { recursive: true });
    writeFileSync(join(dir, 'a/b/x'), Buffer.alloc(3000));
    writeFileSync(join(dir, 'y'), Buffer.alloc(2000));
    expect(await usage(dir, 1e9)).toEqual({ bytes: 5000, entries: 4 });
    expect((await usage(dir, 1e9, 2)).entries).toBeLessThan(4);
  });

  it('ends a process that writes more than the policy allows, saying why', async () => {
    const { bin } = fakePodman(true);
    const ws = mkdtempSync(join(tmpdir(), 'kuraa-ws-'));
    mkdirSync(join(ws, 'scratch'));
    const proc = await podmanEnvironment.start(request(ws, '1m'), { podman: bin });
    writeFileSync(join(ws, 'scratch', 'big'), Buffer.alloc(2 * 1024 * 1024));
    const exit = await proc.exited;
    expect(exit.reason).toBe('It wrote more than 1m of files, the most this host allows.');
  });

  it('removes containers whose host process is gone, on this computer only', async () => {
    const { bin, dir, calls } = fakePodman(true);
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    const c = (id: string, labels: Record<string, string>) => ({ Id: id, Labels: { 'kuraa': 'session', ...labels } });
    writeFileSync(join(dir, 'ps.json'), JSON.stringify([
      c('mine', { 'kuraa.owner': OWNER.pid, 'kuraa.started': OWNER.started, 'kuraa.machine': OWNER.machine }),
      c('crashed', { 'kuraa.owner': gone, 'kuraa.machine': OWNER.machine }),
      c('earlier-me', { 'kuraa.owner': OWNER.pid, 'kuraa.started': String(Number(OWNER.started) - 3600), 'kuraa.machine': OWNER.machine }),
      c('live-other-host', { 'kuraa.owner': String(process.ppid), 'kuraa.machine': OWNER.machine }),
      c('other-computer', { 'kuraa.owner': gone, 'kuraa.machine': `${OWNER.machine}-elsewhere` }),
      c('older-host', {}),
    ]));
    expect(await removeOrphans(bin)).toEqual(['crashed', 'earlier-me']);
    expect(calls()).toContain('rm --force crashed earlier-me');
  });
});
