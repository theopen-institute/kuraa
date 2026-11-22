// Who may change what, where work comes in: cutoffs, and merges made again (gate.ts, decision 0066 step 4).
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import { TypeRegistry } from '@kuraa/kernel';
import { standardTypes } from '@kuraa/formats';
import { Git } from '../src/git.js';
import { commitSigned } from '../src/signing.js';
import { MERGE_VERSION, mergeCommits } from '../src/merging.js';
import { gate, type GateContext } from '../src/peers/gate.js';
import { evaluate, makeOp, type PolicyEntry, type PolicyOp } from '../src/peers/policy.js';

const WS = 'ab'.repeat(16);
const registry = new TypeRegistry();
for (const t of standardTypes) registry.register(t);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const person = () => ({ key: crypto.keyPair(), id: crypto.keyPair().publicKey.toString('hex') });
const ada = person();
const bo = person();
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');

function repo(): { dir: string; git: Git; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-gate-'));
  dirs.push(dir);
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.name', 'Test');
  run(dir, 'config', 'user.email', 'test@example.org');
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe tide was out.\n');
  writeFileSync(join(dir, 'free.md'), 'Anyone may.\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'Base');
  return { dir, git: new Git(dir), base: run(dir, 'rev-parse', 'HEAD') };
}

/** Commit a file's text, signed with a key. */
async function commit(r: { dir: string; git: Git }, path: string, text: string, key: { publicKey: Buffer; secretKey: Buffer }): Promise<string> {
  writeFileSync(join(r.dir, path), text);
  return commitSigned(r.git, [path], `Change ${path}`, key, join(r.dir, '.git', 'tmp'));
}

/** A policy: Ada its admin, Bo a member, and the operations given after. */
function policy(...ops: PolicyOp[]) {
  const entries: PolicyEntry[] = [];
  const add = (op: PolicyOp, by: typeof ada) => entries.push(makeOp(WS, op, op.t === 'genesis' ? [] : evaluate(entries, ctx()).heads, by.key));
  const personOf = (k: string) => [ada, bo].find((p) => hex(p.key) === k)?.id ?? null;
  const ctx = () => ({ workspace: WS, pin: entries[0]?.id ?? null, personOf });
  add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
  add({ t: 'grant', group: 'workspace', who: bo.id, role: 'member' }, ada);
  for (const op of ops) add(op, ada);
  return { policy: evaluate(entries, ctx()), known: new Set(entries.map((e) => e.id)), personOf, nameOf: (id: string) => (id === bo.id ? 'Bo' : 'Ada') };
}

describe('the gate, step 4', () => {
  it('refuses what someone taken out did past their cutoff, even where anyone may change it', async () => {
    const r = repo();
    const before = await commit(r, 'free.md', 'Bo’s first.\n', bo.key);
    const after = await commit(r, 'free.md', 'Bo’s second, after he was taken out.\n', bo.key);
    const ctx: GateContext = policy({ t: 'revoke', group: 'workspace', who: bo.id, cutoff: [before] });
    const g = await gate(r.git, r.base, after, ctx);
    expect(g.keeps.get('free.md')).toBe(run(r.dir, 'rev-parse', `${r.base}:free.md`));
    expect(g.refused).toEqual([{ commit: after, path: 'free.md', by: 'Bo' }]);
    // Up to the cutoff, his work counts.
    expect((await gate(r.git, r.base, before, ctx)).keeps.size).toBe(0);
  });

  it('counts a revoked key’s commits as its person’s up to the cutoff, and no further', async () => {
    const r = repo();
    const lost = crypto.keyPair();
    const before = await commit(r, 'notes.md', '# Notes\n\nBo’s, from the laptop he later lost.\n', lost);
    const after = await commit(r, 'notes.md', '# Notes\n\nWhoever found the laptop.\n', lost);
    const ctx: GateContext = { ...policy({ t: 'rule', path: 'notes.md', by: [bo.id] }), cutKeys: new Map([[hex(lost), { person: bo.id, heads: [before] }]]) };
    expect((await gate(r.git, r.base, before, ctx)).keeps.size).toBe(0);
    const g = await gate(r.git, r.base, after, ctx);
    expect([...g.keeps.keys()]).toEqual(['notes.md']);
  });

  it('makes merges again: one holding a change of its own is judged as that change; an honest one, or one that kept a side, is not', async () => {
    const r = repo();
    const ctx: GateContext = { ...policy({ t: 'rule', path: 'notes.md', by: [ada.id] }), remake: async (a, b) => run(r.dir, 'rev-parse', `${(await mergeCommits(r.git, a, b, { typeFor: (p, h) => registry.resolve(p, h), tmpDir: join(r.dir, '.git', 'tmp') })).commit}^{tree}`), mergeVersion: MERGE_VERSION };
    const left = await commit(r, 'free.md', 'Ada’s.\n', ada.key);
    run(r.dir, 'checkout', '-q', '-b', 'side', r.base);
    const right = await commit(r, 'free.md', 'Anyone may.\n\nBo’s line.\n', bo.key);
    // An honest merge, as any device makes it: nothing of its own.
    const honest = (await mergeCommits(r.git, left, right, { typeFor: (p, h) => registry.resolve(p, h), tmpDir: join(r.dir, '.git', 'tmp') })).commit;
    expect((await gate(r.git, r.base, honest, ctx)).keeps.size).toBe(0);
    // The same merge, with notes.md changed in it too (unsigned: no one's): that change is refused.
    const tree = run(r.dir, 'rev-parse', `${honest}^{tree}`);
    run(r.dir, 'read-tree', tree);
    writeFileSync(join(r.dir, 'notes.md'), '# Notes\n\nSlipped in by a merge.\n');
    run(r.dir, 'add', 'notes.md');
    const forged = run(r.dir, 'commit-tree', run(r.dir, 'write-tree'), '-p', left, '-p', right, '-m', `Merge\n\nKuraa-Merge: ${MERGE_VERSION}`);
    const g = await gate(r.git, r.base, forged, ctx);
    expect([...g.keeps.keys()]).toEqual(['notes.md']);
    // Saying it kept notes.md does not help, where neither side had that text.
    run(r.dir, 'read-tree', tree);
    writeFileSync(join(r.dir, 'notes.md'), '# Notes\n\nSlipped in again.\n');
    run(r.dir, 'add', 'notes.md');
    const claimed = run(r.dir, 'commit-tree', run(r.dir, 'write-tree'), '-p', left, '-p', right, '-m', `Merge\n\nKept notes.md as it was: not Bo to change\n\nKuraa-Merge: ${MERGE_VERSION}`);
    expect([...(await gate(r.git, r.base, claimed, ctx)).keeps.keys()]).toEqual(['notes.md']);
  });
});
