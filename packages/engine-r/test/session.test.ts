// The R engine's session without R: a stand-in environment plays the driver's
// side of the protocol, so what the engine does with what a process says (which
// people's code can forge) is tested quickly, everywhere.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DEFAULT_POLICY, mappedView, type EngineContext, type Environment, type PackageContext, type SandboxProcess } from '@kuraa/run-kit';
import { rEngine, readManifest } from '../src/index.js';
import { splitLines } from '../src/lines.js';

const PREFIX = '\u001fkuraa\u001f';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Driver {
  /** Lines the engine wrote to the process. */
  requests: AsyncIterator<Record<string, unknown>>;
  say(message: object): void;
  exit(): void;
  scratch: string;
}

/** An environment whose one process is played by `play`, once `gate` opens. */
function standIn(play: (d: Driver) => void, gate: Promise<void> = Promise.resolve()): { environment: Environment; killed: () => boolean; started: () => boolean } {
  let killed = false;
  let started = false;
  const environment: Environment = {
    id: 'stand-in', label: 'here', sandboxed: true,
    check: async () => ({ available: true, message: '' }),
    async start(req): Promise<SandboxProcess> {
      await gate;
      started = true;
      const view = mappedView(req, { workspace: '/work', scratch: '/scratch', files: '/kuraa' }, req.mounts);
      req.command(view);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let exit!: () => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => (exit = () => {
        stdout.end();
        resolve({ code: 0, signal: null });
      }));
      // R ends when its input does.
      stdin.on('finish', () => exit());
      const lines = (async function* () {
        let buffer = '';
        for await (const chunk of stdin) {
          buffer += String(chunk);
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            yield JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
            buffer = buffer.slice(nl + 1);
          }
        }
      })();
      play({ requests: lines, say: (m) => stdout.write(`${PREFIX}${JSON.stringify(m)}\n`), exit, scratch: req.scratch });
      return {
        stdin, stdout, stderr: new PassThrough(), view, exited,
        interrupt: () => undefined,
        kill: () => {
          killed = true;
          exit();
        },
      };
    },
  };
  return { environment, killed: () => killed, started: () => started };
}

function context(environment: Environment, more: Partial<EngineContext> = {}): EngineContext {
  const root = mkdtempSync(join(tmpdir(), 'kuraa-rsession-'));
  mkdirSync(join(root, 'ws'));
  return {
    environment, environmentOptions: undefined,
    workspace: join(root, 'ws'), scratch: join(root, 'scratch'), files: join(root, 'files'), dataDir: join(root, 'data'),
    workspaceKey: 'w', policy: DEFAULT_POLICY, requirements: undefined, options: undefined,
    install: async () => ({ ok: true, message: 'Installed.', log: '', restart: false }),
    remove: async () => ({ ok: true, message: 'Removed.', log: '', restart: false }),
    usedFromEnvironment: () => undefined,
    log: () => undefined, status: () => undefined,
    ...more,
  };
}

describe('the R session', () => {
  it('passes on plots it wrote to scratch, and nothing a process could point elsewhere', async () => {
    const secret = join(mkdtempSync(join(tmpdir(), 'kuraa-secret-')), 'secret.png');
    writeFileSync(secret, 'not for anyone');
    const { environment } = standIn((d) => void (async () => {
      d.say({ type: 'ready', r: 'R 4.5' });
      const req = (await d.requests.next()).value as { id: string; out: string };
      expect(req.out).toBe('/scratch');
      writeFileSync(join(d.scratch, `${req.id}-1.png`), PNG);
      symlinkSync(secret, join(d.scratch, `${req.id}-2.png`));
      d.say({
        type: 'result', id: req.id, outputs: [
          { type: 'image', file: `/scratch/${req.id}-1.png`, width: 672, height: 480 },
          { type: 'image', file: `/scratch/${req.id}-2.png`, width: 1, height: 1 },
          { type: 'image', file: '/scratch/../../secret.png', width: 1, height: 1 },
          { type: 'html', html: '<script>alert(1)</script>' },
          { type: 'text', text: 42 },
        ],
      });
    })());
    const ctx = context(environment);
    const session = rEngine.open(ctx);
    expect(await session.ready).toBe('R 4.5');
    const result = await session.run({ id: 'run-1', code: 'plot(1)', header: 'r', dir: ctx.workspace });
    expect(result.outputs).toEqual([
      { type: 'image', mime: 'image/png', data: PNG.toString('base64'), width: 672, height: 480 },
      { type: 'error', text: 'A plot could not be read.' },
      { type: 'error', text: 'A plot could not be read.' },
      { type: 'text', text: '42' },
    ]);
    expect(readFileSync(secret, 'utf8')).toBe('not for anyone');
  });

  it('starts no process once stopped, even while the environment was still starting it', async () => {
    let open!: () => void;
    const stand = standIn((d) => d.say({ type: 'ready', r: 'R' }), new Promise((r) => (open = r)));
    const session = rEngine.open(context(stand.environment));
    await new Promise((r) => setTimeout(r, 20));
    await session.stop();
    open();
    expect(await session.ended).toBe('Stopped before R started.');
    expect(stand.killed()).toBe(true);
    await expect(session.ready).rejects.toThrow('Stopped before R started.');
  });

  it('does not answer install.packages() once R has been stopped', async () => {
    let finish!: () => void;
    const installing = new Promise<void>((r) => (finish = r));
    const { environment } = standIn((d) => {
      d.say({ type: 'ready', r: 'R' });
      d.say({ type: 'install', refs: ['dplyr', 3] });
    });
    const refs: string[][] = [];
    const session = rEngine.open(context(environment, {
      install: async (r) => {
        refs.push(r);
        await installing;
        return { ok: true, message: 'Installed.', log: '', restart: false };
      },
    }));
    await session.ready;
    await new Promise((r) => setTimeout(r, 20));
    await session.stop();
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(refs).toEqual([['dplyr']]);
  });

  it('reads long replies a chunk at a time, and refuses one too long to hold', () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const feed = splitLines((l) => lines.push(l), (p) => overflows.push(p.length), 10);
    feed('ab');
    feed('c\nde');
    feed('f\n0123456789AB');
    feed('CD\nlast\n');
    expect(lines).toEqual(['abc', 'def', 'last']);
    expect(overflows).toEqual([12]);
  });
});

describe('R packages', () => {
  it('reads a manifest of the wrong shape as what it can, and removes only package names', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kuraa-manifest-'));
    mkdirSync(join(ws, '.kuraa'));
    writeFileSync(join(ws, '.kuraa/r-packages.json'), JSON.stringify({ requested: 'dplyr', packages: { a: { version: '1', ref: 'a@1' }, b: 'x' }, environment: { c: 2 }, system: ['libxml2-dev', 7] }));
    expect(readManifest(ws)).toEqual({ requested: [], packages: { a: { version: '1', ref: 'a@1' } }, environment: {}, system: ['libxml2-dev'] });

    const data = mkdtempSync(join(tmpdir(), 'kuraa-data-'));
    const outside = join(data, 'elsewhere');
    mkdirSync(join(data, 'libs', 'w'), { recursive: true });
    symlinkSync(ws, outside);
    const ctx = { ...context(standIn(() => undefined).environment), workspace: ws, dataDir: data, commit: async () => undefined } as PackageContext;
    const result = await rEngine.packages!.remove(ctx, ['../../elsewhere']);
    expect(result).toMatchObject({ ok: false, message: 'Not a package name: ../../elsewhere.' });
    expect(existsSync(outside)).toBe(true);
  });
});
