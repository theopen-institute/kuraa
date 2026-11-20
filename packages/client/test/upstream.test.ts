// Out-of-date outputs and Rebuild above: whether code ran on the chunks above as
// they now read, from what a session has run.
import { describe, expect, it } from 'vitest';
import { hashText } from '@kuraa/kernel';
import type { RunRecord, RunSessionInfo, RunStep } from '@kuraa/session/model';
import { behind, describeBehind, latestStep } from '../src/upstream.js';
import { ChunkRunner, type Chunk } from '../src/runs.js';
import type { HostApi, RunInfo } from '../src/api.js';

const chunk = (index: number, code: string, label: string | null = null, engine = 'r'): Chunk =>
  ({ pos: index * 100, index, engine, label, header: engine, code, codeHash: hashText(code) });
const step = (c: Chunk, complete = true): RunStep => ({ label: c.label, index: c.index, codeHash: c.codeHash, complete });

describe('behind', () => {
  const a = chunk(0, 'x <- 1', 'setup');
  const b = chunk(1, 'y <- x + 1');
  const c = chunk(2, 'z <- y * 2');

  it('is null when every chunk above ran as it now reads', () => {
    expect(behind([a, b], [step(a), step(b)])).toBeNull();
    // Order among the steps, and runs of other chunks, do not matter.
    expect(behind([a, b], [step(b), step(c), step(a)])).toBeNull();
  });

  it('finds the first chunk above that never ran, changed, or ran only in part', () => {
    expect(behind([a, b], [step(b)])).toMatchObject({ chunk: a, why: 'not-run' });
    expect(behind([a, b], [step(a), { ...step(b), codeHash: hashText('y <- 0') }])).toMatchObject({ chunk: b, why: 'changed' });
    expect(behind([a, b], [step(a), step(b, false)])).toMatchObject({ chunk: b, why: 'incomplete' });
  });

  it('counts only the latest run of a chunk', () => {
    const old = { ...step(b), codeHash: hashText('y <- 0') };
    expect(behind([b], [step(b), old])).toMatchObject({ why: 'changed' });
    expect(behind([b], [old, step(b)])).toBeNull();
    expect(behind([b], [step(b), step(b, false)])).toMatchObject({ why: 'incomplete' });
  });

  it('matches labelled chunks by label, and others by place or code', () => {
    // A chunk renamed: its old runs are another chunk's.
    expect(behind([{ ...a, label: 'init' }], [step(a)])).toMatchObject({ why: 'not-run' });
    // An unlabelled chunk moved down by one inserted above it is still found by its code.
    expect(behind([{ ...b, index: 4 }], [step(b)])).toBeNull();
  });

  it('finds the same chunk as scanning the steps for each one', () => {
    // An unlabelled chunk's latest step is the later of the last by place and the last by code.
    let seed = 7;
    const pick = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    const codes = ['a', 'b', 'c'].map(hashText);
    const key = () => ({ label: pick(3) === 0 ? `l${pick(2)}` : null, index: pick(4), codeHash: codes[pick(3)]! });
    for (let round = 0; round < 500; round++) {
      const above = Array.from({ length: pick(5) }, key);
      const steps: RunStep[] = Array.from({ length: pick(8) }, () => ({ ...key(), complete: pick(4) > 0 }));
      let expected: { chunk: unknown; why: string } | null = null;
      for (const chunk of above) {
        const s = latestStep(chunk, steps);
        const why = !s ? 'not-run' : s.codeHash !== chunk.codeHash ? 'changed' : !s.complete ? 'incomplete' : null;
        if (why) {
          expected = { chunk, why };
          break;
        }
      }
      expect(behind(above, steps)).toEqual(expected);
    }
  });

  it('says why in a few words', () => {
    expect(describeBehind({ chunk: a, why: 'changed' })).toBe('chunk “setup” changed since');
    expect(describeBehind({ chunk: b, why: 'not-run' })).toBe('ran without chunk 2');
    expect(describeBehind({ chunk: b, why: 'incomplete' })).toBe('chunk 2 had not run in full');
  });
});

describe('ChunkRunner', () => {
  const info: RunInfo = { enabled: true, engines: [{ id: 'r', label: 'R', handles: ['r'], packages: false }], allowInstalls: false, environment: null } as RunInfo;
  const user = () => ({ name: 'Ada', email: 'ada@example.org', color: '#123456' });

  function setup(chunks: Chunk[]) {
    const sent: string[] = [];
    let n = 0;
    const api = {
      run: async (req: { code: string; chunk: RunRecord['chunk'] }) => {
        sent.push(req.code);
        return record(`q${n++}`, req.chunk, 'queued');
      },
    } as unknown as HostApi;
    const runner = new ChunkRunner(api, 'doc.Rmd', info, user);
    runner.setChunks(chunks);
    return { runner, sent };
  }

  let clock = 0;
  const record = (id: string, ref: RunRecord['chunk'], state: RunRecord['state'], steps?: RunStep[]): RunRecord => ({
    id, path: 'doc.Rmd', chunk: ref, engine: 'r', state, outputs: [], by: { name: 'Ada', color: '#123456' },
    queuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(), finishedAt: null, ms: null,
    ...(steps ? { basis: { session: 's1', steps } } : {}),
  });
  const ref = (c: Chunk) => ({ label: c.label, index: c.index, codeHash: c.codeHash });
  const session = (steps: RunStep[]): RunSessionInfo => ({ path: 'doc.Rmd', engine: 'r', environment: 'podman', state: 'ready', message: null, id: 's1', steps });

  const a = chunk(0, 'x <- 1');
  const b = chunk(1, 'y <- x + 1');
  const c = chunk(2, 'print(y)');

  it('marks an output computed before a chunk above changed', () => {
    const { runner } = setup([a, b, c]);
    runner.receive({ type: 'run', run: record('r1', ref(c), 'done', [step(a), step(b)]) });
    expect(runner.state(c.pos).upstream).toBeNull();
    const edited = { ...b, code: 'y <- x + 2', codeHash: hashText('y <- x + 2') };
    runner.setChunks([a, edited, c]);
    expect(runner.state(c.pos)).toMatchObject({ stale: false, upstream: { chunk: { index: 1 }, why: 'changed' } });
    // Outputs from before outputs were tracked: nothing to say.
    runner.receive({ type: 'run', run: record('r2', ref(edited), 'done') });
    expect(runner.state(edited.pos).upstream).toBeNull();
  });

  it('offers Rebuild above only when the session lacks a chunk above as it reads, from that chunk down', async () => {
    const { runner, sent } = setup([a, b, c]);
    // No session: everything above must run.
    expect(runner.rebuild(c.pos)).toMatchObject({ fresh: true, chunks: [a, b] });
    expect(runner.rebuild(a.pos)).toBeNull();

    runner.receive({ type: 'run-session', session: session([step(a), step(b)]) });
    expect(runner.rebuild(c.pos)).toBeNull();

    const edited = { ...b, code: 'y <- x + 2', codeHash: hashText('y <- x + 2') };
    runner.setChunks([a, edited, c]);
    expect(runner.rebuild(c.pos)).toMatchObject({ fresh: false, why: 'changed', chunks: [edited] });
    expect(runner.rebuild(edited.pos)).toBeNull();

    await runner.rebuildAbove(c.pos);
    expect(sent).toEqual(['y <- x + 2']);
    // Queued runs count: nothing more to offer while they wait.
    expect(runner.rebuild(c.pos)).toBeNull();
  });

  it('leaves chunks another engine runs out of it', () => {
    const py = chunk(1, 'z = 1', null, 'python');
    const { runner } = setup([a, py, c]);
    runner.receive({ type: 'run-session', session: session([step(a)]) });
    expect(runner.rebuild(c.pos)).toBeNull();
  });
});
