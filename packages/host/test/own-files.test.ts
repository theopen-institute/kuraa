// A person's own files (docs/decisions/0082-annotations.md, Who owns an annotation): a file named
// `@<identity ID>` is that person's alone to change, wherever they read it, whatever the rules; anyone
// may move it unchanged (with its document). The policy says so, and the gate judges commits by it.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import crypto from 'hypercore-crypto';
import { Git } from '../src/git.js';
import { commitSigned } from '../src/signing.js';
import { gate, type GateContext } from '../src/peers/gate.js';
import { evaluate, makeOp, Policy, type PolicyEntry, type PolicyOp } from '../src/peers/policy.js';

const WS = 'cd'.repeat(16);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const run = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const person = () => ({ key: crypto.keyPair(), id: crypto.keyPair().publicKey.toString('hex') });
const ada = person();
const bo = person();
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');
const BO_FILE = `notes.md.annotations/@${bo.id}.jsonld`;

function policy(...ops: PolicyOp[]) {
  const entries: PolicyEntry[] = [];
  const personOf = (k: string) => [ada, bo].find((p) => hex(p.key) === k)?.id ?? null;
  const ctx = () => ({ workspace: WS, pin: entries[0]?.id ?? null, personOf });
  const add = (op: PolicyOp) => entries.push(makeOp(WS, op, op.t === 'genesis' ? [] : evaluate(entries, ctx()).heads, ada.key));
  add({ t: 'genesis', admins: [ada.id], legacy: false });
  add({ t: 'grant', group: 'workspace', who: bo.id, role: 'member' });
  for (const op of ops) add(op);
  return { policy: evaluate(entries, ctx()), known: new Set(entries.map((e) => e.id)), personOf, nameOf: (id: string) => (id === bo.id ? 'Bo' : 'Ada') };
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-own-'));
  dirs.push(dir);
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.name', 'Test');
  run(dir, 'config', 'user.email', 'test@example.org');
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe tide was out.\n');
  mkdirSync(join(dir, 'notes.md.annotations'));
  writeFileSync(join(dir, BO_FILE), '{"items": []}\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'Base');
  return { dir, git: new Git(dir), base: run(dir, 'rev-parse', 'HEAD') };
}
const write = (r: { dir: string }, path: string, text: string) => {
  mkdirSync(dirname(join(r.dir, path)), { recursive: true });
  writeFileSync(join(r.dir, path), text);
};
const commit = (r: { dir: string; git: Git }, paths: string[], key: { publicKey: Buffer; secretKey: Buffer }) => commitSigned(r.git, paths, 'Change', key, join(r.dir, '.git', 'tmp'));

describe('a person’s own files', () => {
  it('are theirs alone to change, wherever they read them, whatever the rules', () => {
    const { policy: p } = policy({ t: 'rule', path: '', by: [ada.id] }, { t: 'space', id: 'e'.repeat(32), audience: [ada.id] });
    // The workspace's rule names only Ada: Bo may still change his own, and Ada, an admin, may not change his.
    expect(p.mayWrite(bo.id, BO_FILE)).toBe(true);
    expect(p.mayWrite(ada.id, BO_FILE)).toBe(false);
    expect(p.mayWrite(bo.id, 'notes.md')).toBe(false);
    // In a space he does not read: not even his own.
    expect(p.mayWrite(bo.id, BO_FILE, 'e'.repeat(32))).toBe(false);
    // Anyone taken out of the workspace: no one's.
    expect(p.mayWrite('f'.repeat(64), `x/@${'f'.repeat(64)}.json`)).toBe(false);
    // No policy (a workspace on one computer): anyone.
    expect(new Policy({ groups: new Map(), geneses: [], applied: [], heads: [] }).mayWrite(null, BO_FILE)).toBe(true);
  });

  it('are taken from their owner, refused from anyone else, rules or none; moved unchanged by anyone', async () => {
    const ctx: GateContext = policy();
    // Bo's own change to his file: taken (no rules at all, and still judged: it is someone's own).
    let r = repo();
    write(r, BO_FILE, '{"items": ["bo"]}\n');
    let c = await commit(r, [BO_FILE], bo.key);
    expect((await gate(r.git, r.base, c, ctx)).refused).toEqual([]);
    // Ada's change to Bo's file: refused, his kept.
    r = repo();
    write(r, BO_FILE, '{"items": ["ada was here"]}\n');
    c = await commit(r, [BO_FILE], ada.key);
    const g = await gate(r.git, r.base, c, ctx);
    expect(g.refused).toEqual([{ commit: c, path: BO_FILE, by: 'Ada' }]);
    expect(g.keeps.get(BO_FILE)).toBe(run(r.dir, 'rev-parse', `${r.base}:${BO_FILE}`));
    // Ada renames the document: Bo's file goes with it, unchanged: taken.
    r = repo();
    mkdirSync(join(r.dir, 'field/notes.md.annotations'), { recursive: true });
    renameSync(join(r.dir, 'notes.md'), join(r.dir, 'field/notes.md'));
    renameSync(join(r.dir, BO_FILE), join(r.dir, `field/${BO_FILE}`));
    c = await commit(r, ['notes.md', 'field/notes.md', BO_FILE, `field/${BO_FILE}`], ada.key);
    expect((await gate(r.git, r.base, c, ctx)).refused).toEqual([]);
    // Moved and changed at once: refused (as are both of its paths).
    r = repo();
    rmSync(join(r.dir, BO_FILE));
    write(r, `elsewhere/${BO_FILE}`, '{"items": ["changed"]}\n');
    c = await commit(r, [BO_FILE, `elsewhere/${BO_FILE}`], ada.key);
    expect((await gate(r.git, r.base, c, ctx)).refused.map((x) => x.path).sort()).toEqual([BO_FILE, `elsewhere/${BO_FILE}`].sort());
  });

  it('are judged as read where they are: a space’s history, by its audience', async () => {
    const space = 'e'.repeat(32);
    const ctx: GateContext = { ...policy({ t: 'space', id: space, audience: [ada.id] }), space };
    const r = repo();
    write(r, BO_FILE, '{"items": ["bo"]}\n');
    const c = await commit(r, [BO_FILE], bo.key);
    expect((await gate(r.git, r.base, c, ctx)).refused.map((x) => x.path)).toEqual([BO_FILE]);
  });
});
