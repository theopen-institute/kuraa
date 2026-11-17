// The Podman environment without Podman: the policy as flags, image tags, what it
// says when Podman is missing or stopped, and the build-then-run sequence against
// a stand-in `podman` that records its arguments. A real run is in host tests,
// skipped where Podman is not installed.
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, type StartRequest } from '@kuraa/run-kit';
import { imageTag, podmanEnvironment, runArgs } from '../src/index.js';

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
    ]));
    // Nothing else of the host is mounted, and the command comes last, after the image.
    expect(args.filter((a) => a.startsWith('--volume='))).toHaveLength(3);
    expect(args.slice(-3)).toEqual(['localhost/kuraa-env:abc', 'Rscript', '/kuraa/driver.R']);
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
function fakePodman(infoOk: boolean): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-fakepodman-'));
  const log = join(dir, 'calls');
  const bin = join(dir, 'podman');
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  info) ${infoOk ? 'echo arm64; exit 0' : 'echo "Cannot connect to Podman: is the machine running?" >&2; exit 125'} ;;
  image) exit 1 ;;
  build) echo "STEP 1/2: FROM x"; exit 0 ;;
  run) exec cat ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
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
    expect(run).toMatch(/localhost\/kuraa-env:[0-9a-f]{16} Rscript \/kuraa\/driver\.R$/);
    expect(statuses).toEqual(['Building the environment. The first time takes a few minutes.']);
    expect(proc.view.outside('/scratch/plots/a.png')).toBe(join(ws, 'scratch/plots/a.png'));
  });
});
