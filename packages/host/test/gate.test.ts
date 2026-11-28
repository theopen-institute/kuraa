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
import { MERGE_VERSION, mergeCommits, mergeTrailerValue } from '../src/merging.js';
import { gate, type GateContext } from '../src/peers/gate.js';
import { startHost } from '../src/index.js';
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
  it('judges a commit no one known signed as the device’s it came from: a server’s, or no one’s, refused; a person’s, theirs (0099)', async () => {
    const r = repo();
    // Unsigned (as plain git makes it), and one signed by a key that is no one's here.
    writeFileSync(join(r.dir, 'free.md'), 'Changed, unsigned.\n');
    run(r.dir, 'commit', '-q', '-am', 'Unsigned');
    const unsigned = run(r.dir, 'rev-parse', 'HEAD');
    const stranger = await commit(r, 'notes.md', '# Notes\n\nA stranger’s.\n', crypto.keyPair());
    const server = hex(crypto.keyPair());
    const p = policy({ t: 'rule', path: 'notes.md', by: [ada.id] });
    const judged = (from: string | null | undefined, servers = new Set<string>([server])) => gate(r.git, r.base, stranger, { ...p, servers, from });
    // From a server: both refused, rules or none (free.md has no rule).
    expect((await judged(server)).refused.map((x) => x.path).sort()).toEqual(['free.md', 'notes.md']);
    // From a device that is no one in the workspace: likewise.
    expect((await judged(null)).refused.map((x) => x.path).sort()).toEqual(['free.md', 'notes.md']);
    // From Bo's device: as Bo's, so free.md is taken and notes.md (Ada's alone) kept out.
    expect((await judged(bo.id)).refused.map((x) => x.path)).toEqual(['notes.md']);
    // From Ada's: as Ada's, both taken.
    expect((await judged(ada.id)).refused).toEqual([]);
    // From no device (the online copy): as before, no one's (refused only where a rule says).
    expect((await judged(undefined, new Set())).refused.map((x) => x.path)).toEqual(['notes.md']);
    void unsigned;
  });

  it('counts a key as someone’s only where the workspace has or had them: an identity no one let in is no one (0112)', async () => {
    const r = repo();
    // Sam: an identity of someone's own making, its key vouched for (personOf knows it), never let in.
    const sam = person();
    const samsCommit = await commit(r, 'free.md', 'Sam was here.\n', sam.key);
    const server = hex(crypto.keyPair());
    const p = policy();
    const personOf = (k: string) => (k === hex(sam.key) ? sam.id : p.personOf(k));
    // Even a revocation with a cutoff naming the commit, as its own identity could say, makes it no one's still.
    const cutKeys = new Map([[hex(sam.key), { person: sam.id, heads: [samsCommit] }]]);
    const judged = (from: string | null) => gate(r.git, r.base, samsCommit, { ...p, personOf, cutKeys, servers: new Set([server]), from });
    // Brought by a server: no one known signed it, so refused, though no rule names free.md.
    expect((await judged(server)).refused.map((x) => [x.commit, x.path])).toEqual([[samsCommit, 'free.md']]);
    // By a device let in by a link whose person is not in yet: refused too.
    expect((await judged(sam.id)).refused.map((x) => x.path)).toEqual(['free.md']);
    // By Bo's device: as Bo's, who may change free.md.
    expect((await judged(bo.id)).refused).toEqual([]);
  });

  it('keeps each commit’s verdict, and gives the same from it as judging afresh; not across other records (0099)', async () => {
    const r = repo();
    const left = await commit(r, 'notes.md', '# Notes\n\nBo’s.\n', bo.key);
    const p = policy({ t: 'rule', path: 'notes.md', by: [ada.id] });
    const cache = new Map<string, [string, { commit: string; by: string | null } | null][]>();
    const fresh = await gate(r.git, r.base, left, p);
    const first = await gate(r.git, r.base, left, { ...p, cache, cacheKey: 'v1' });
    expect(cache.size).toBe(1);
    // Kept: the verdict comes from the cache (a made-up one shows it is used), and the same as fresh.
    const second = await gate(r.git, r.base, left, { ...p, cache, cacheKey: 'v1' });
    expect(second.refused).toEqual(fresh.refused);
    expect(first.refused).toEqual(fresh.refused);
    cache.set([...cache.keys()][0]!, [['notes.md', null]]);
    expect((await gate(r.git, r.base, left, { ...p, cache, cacheKey: 'v1' })).refused).toEqual([]);
    // Other records (another key): judged afresh.
    expect((await gate(r.git, r.base, left, { ...p, cache, cacheKey: 'v2' })).refused).toEqual(fresh.refused);
  });

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
    const ctx: GateContext = { ...policy({ t: 'rule', path: 'notes.md', by: [ada.id] }), remake: async (a, b) => run(r.dir, 'rev-parse', `${(await mergeCommits(r.git, a, b, { typeFor: (p, h) => registry.resolve(p, h), tmpDir: join(r.dir, '.git', 'tmp') })).commit}^{tree}`), mergeTrailer: String(MERGE_VERSION) };
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
    // A merge made by another git or other types (its trailer's hash differs) is not made again here, where it
    // could come out otherwise: what it changes of its own is what differs from both sides.
    let remade = 0;
    const other: GateContext = { ...ctx, remake: async (a, b) => { remade++; return ctx.remake!(a, b); }, mergeTrailer: mergeTrailerValue('merge@5 git@9.9 pandoc@3') };
    const elsewhere = run(r.dir, 'commit-tree', tree, '-p', left, '-p', right, '-m', `Merge\n\nKuraa-Merge: ${mergeTrailerValue('merge@5 git@1.0 pandoc@3')}`);
    expect((await gate(r.git, r.base, elsewhere, other)).keeps.size).toBe(0);
    expect(remade).toBe(0);
  });

  it('honours a merge’s word that it kept a file only where this device would keep that change out too; a server’s merges are made again whatever version they name (0099)', async () => {
    const r = repo();
    const server = crypto.keyPair();
    const remake = async (a: string, b: string) => run(r.dir, 'rev-parse', `${(await mergeCommits(r.git, a, b, { typeFor: (p, h) => registry.resolve(p, h), tmpDir: join(r.dir, '.git', 'tmp') })).commit}^{tree}`);
    const ctx: GateContext = { ...policy(), servers: new Set([hex(server)]), remake, mergeTrailer: String(MERGE_VERSION) };
    // Ada changes notes.md; Bo, who may, changes free.md, on another side.
    const left = await commit(r, 'notes.md', '# Notes\n\nAda’s.\n', ada.key);
    run(r.dir, 'checkout', '-q', '-b', 'side', r.base);
    const right = await commit(r, 'free.md', 'Bo’s, as he may.\n', bo.key);
    // A merge taking Ada's side whole (Bo's change dropped), saying it kept free.md: Bo may change it, so the word
    // is not taken, and dropping his change is the merge's own change.
    const signedMerge = async (message: string, key: { publicKey: Buffer; secretKey: Buffer }) => {
      run(r.dir, 'checkout', '-q', 'main');
      run(r.dir, 'read-tree', `${left}^{tree}`);
      const tree = run(r.dir, 'write-tree');
      const raw = run(r.dir, 'commit-tree', tree, '-p', left, '-p', right, '-m', message);
      return raw;
      void key;
    };
    const claimed = await signedMerge(`Merge\n\nKept free.md as it was: not Bo to change\n\nKuraa-Merge: ${MERGE_VERSION}`, ada.key);
    // Unsigned, from a server's device: refused.
    expect([...(await gate(r.git, r.base, claimed, { ...ctx, from: hex(server) })).keeps.keys()]).toEqual(['free.md']);
    // Naming another version of merging does not help a server's merge: it is made again here all the same.
    const elsewhere = await signedMerge(`Merge\n\nKuraa-Merge: ${mergeTrailerValue('merge@5 git@1.0 pandoc@3')}`, ada.key);
    expect([...(await gate(r.git, r.base, elsewhere, { ...ctx, from: hex(server) })).keeps.keys()]).toEqual(['free.md']);
    // A person's merge from another version is not made again (0025): dropping Bo's change to free.md is Ada's own
    // change (0112), which she may make, as anyone may change free.md.
    expect((await gate(r.git, r.base, elsewhere, { ...ctx, from: ada.id })).keeps.size).toBe(0);
    // Where only Bo may change free.md, Ada's merge saying it kept his change out is not believed (this device would
    // take his change): dropping it is her change, which she may not make.
    const bosOnly: GateContext = { ...policy({ t: 'rule', path: 'free.md', by: [bo.id] }), servers: new Set(), remake, mergeTrailer: String(MERGE_VERSION) };
    expect([...(await gate(r.git, r.base, claimed, { ...bosOnly, from: ada.id })).keeps.keys()]).toEqual(['free.md']);
  });

  it('takes no merge’s dropping of someone’s change unseen: of more than two parents, or by another version of merging (0112)', async () => {
    const r = repo();
    const remake = async (a: string, b: string) => run(r.dir, 'rev-parse', `${(await mergeCommits(r.git, a, b, { typeFor: (p, h) => registry.resolve(p, h), tmpDir: join(r.dir, '.git', 'tmp') })).commit}^{tree}`);
    // Only Ada changes notes.md. She does; Bo changes free.md on another side, as he may.
    const ctx: GateContext = { ...policy({ t: 'rule', path: 'notes.md', by: [ada.id] }), servers: new Set(), remake, mergeTrailer: String(MERGE_VERSION) };
    const adas = await commit(r, 'notes.md', '# Notes\n\nAda’s, as only she may.\n', ada.key);
    run(r.dir, 'checkout', '-q', '-b', 'side', r.base);
    const bos = await commit(r, 'free.md', 'Bo’s, as he may.\n', bo.key);
    run(r.dir, 'checkout', '-q', 'main');
    // A merge of three, Ada's, the base and Bo's, holding Bo's side's files: notes.md as it was before Ada changed it,
    // which no parent but hers differs from. Brought by Bo: undoing her change is his, and refused.
    const octopus = run(r.dir, 'commit-tree', `${bos}^{tree}`, '-p', adas, '-p', r.base, '-p', bos, '-m', `Merge\n\nKuraa-Merge: ${MERGE_VERSION}`);
    expect([...(await gate(r.git, adas, octopus, { ...ctx, from: bo.id })).keeps.keys()]).toEqual(['notes.md']);
    // A merge of two naming another version of merging (not made again here), taking Bo's side whole: the same.
    const elsewhere = run(r.dir, 'commit-tree', `${bos}^{tree}`, '-p', adas, '-p', bos, '-m', `Merge\n\nKuraa-Merge: ${mergeTrailerValue('merge@5 git@1.0 pandoc@3')}`);
    expect([...(await gate(r.git, adas, elsewhere, { ...ctx, from: bo.id })).keeps.keys()]).toEqual(['notes.md']);
    // The honest merge, from any version, holds both changes: nothing of its own.
    const honest = (await mergeCommits(r.git, adas, bos, { typeFor: (p, h) => registry.resolve(p, h), tmpDir: join(r.dir, '.git', 'tmp') })).commit;
    expect((await gate(r.git, adas, honest, { ...ctx, from: bo.id })).keeps.size).toBe(0);
  });

  it('keeps out the same changes whichever side of a merge a device is on, so both make the same merge (0025)', async () => {
    const r = repo();
    const ctx: GateContext = policy({ t: 'rule', path: 'notes.md', by: [ada.id] });
    // Ada, on her device, changes what anyone may; Bo, on his, what only Ada may.
    const left = await commit(r, 'free.md', 'Ada’s.\n', ada.key);
    run(r.dir, 'checkout', '-q', '-b', 'side', r.base);
    const right = await commit(r, 'notes.md', '# Notes\n\nBo’s tide.\n', bo.key);
    run(r.dir, 'checkout', '-q', 'main');
    const h = await startHost({ dir: r.dir });
    try {
      h.host.gate = (x, y) => gate(h.host.git, x, y, ctx);
      // Ada's device merges Bo's work into hers; Bo's, hers into his.
      const onAdas = await h.host.merge(left, right);
      const onBos = await h.host.merge(right, left);
      expect(onBos.commit).toBe(onAdas.commit);
      expect(run(r.dir, 'show', `${onAdas.commit}:notes.md`)).toBe('# Notes\n\nThe tide was out.');
      expect(run(r.dir, 'show', `${onAdas.commit}:free.md`)).toBe('Ada’s.');
      expect(run(r.dir, 'log', '-1', '--format=%B', onAdas.commit)).toContain(`Kuraa-Refused: ${right} notes.md`);
    } finally {
      await h.close();
    }
  });

  it('takes a merge that kept a file as it was where both sides’ changes to it were kept out', async () => {
    const r = repo();
    const ctx: GateContext = policy({ t: 'rule', path: 'notes.md', by: [ada.id] });
    // Bo changes what only Ada may, on two devices apart.
    const left = await commit(r, 'notes.md', '# Notes\n\nBo’s tide, on the laptop.\n', bo.key);
    run(r.dir, 'checkout', '-q', '-b', 'side', r.base);
    const right = await commit(r, 'notes.md', '# Notes\n\nBo’s tide, on the desktop.\n', bo.key);
    run(r.dir, 'checkout', '-q', 'main');
    const h = await startHost({ dir: r.dir });
    try {
      h.host.gate = (x, y) => gate(h.host.git, x, y, ctx);
      const merged = await h.host.merge(left, right);
      expect(run(r.dir, 'show', `${merged.commit}:notes.md`)).toBe('# Notes\n\nThe tide was out.');
      // Another device judging that merge refuses Bo's two changes, but not the merge itself.
      const remakeCtx: GateContext = { ...ctx, remake: (a, b) => h.host.remakeMergeTree(a, b), mergeTrailer: mergeTrailerValue(h.host.mergeSignature) };
      for (const c of [ctx, remakeCtx]) {
        const g = await gate(r.git, r.base, merged.commit, c);
        expect(g.refused.map((x) => x.commit)).not.toContain(merged.commit);
      }
    } finally {
      await h.close();
    }
  });
});
