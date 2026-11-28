// A workspace's policy: groups of admins and members, the same on every device (policy.ts, decision 0066).
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { evaluate, grantMessage, hashedPath, makeOp, pathsAbove, permissionPaths, readOp, type PolicyEntry, type PolicyOp, type Role } from '../src/peers/policy.js';

const WS = 'ab'.repeat(16);
type Key = ReturnType<typeof crypto.keyPair>;

/** People: each a signing key, and the identity it is (as vouches would say). */
const person = () => {
  const key = crypto.keyPair();
  return { key, id: crypto.keyPair().publicKey.toString('hex') };
};
const [ada, bo, cy, dee] = [person(), person(), person(), person()];
const people = [ada, bo, cy, dee];
const personOf = (k: string) => people.find((p) => p.key.publicKey.toString('hex') === k)?.id ?? null;

/** A history being made: each operation after all before it. */
function history(pin = true) {
  const entries: PolicyEntry[] = [];
  const ctx = () => ({ workspace: WS, pin: pin ? entries[0]?.id ?? null : null, personOf });
  const now = () => evaluate(entries, ctx());
  const add = (op: PolicyOp, by: { key: Key }, parents = op.t === 'genesis' ? [] : now().heads) => {
    const e = makeOp(WS, op, parents, by.key);
    entries.push(e);
    return e;
  };
  return { entries, ctx, now, add };
}

const grant = (who: { id: string }, role: Role, group = 'workspace'): PolicyOp => ({ t: 'grant', group, who: who.id, role });
const sign = (by: { key: Key }, genesis: string | null, link: string, group: string, role: Role, once: boolean) =>
  crypto.sign(grantMessage(WS, genesis, link, group, role, once), by.key.secretKey).toString('hex');

describe('a workspace’s policy', () => {
  it('lets admins, and only admins, change who is in it; keeps one admin', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    expect(h.now().role(ada.id)).toBe('admin');
    h.add(grant(bo, 'member'), ada);
    expect(h.now().role(bo.id)).toBe('member');
    // A member may not.
    h.add(grant(cy, 'admin'), bo);
    expect(h.now().role(cy.id)).toBeNull();
    // The only admin may not stop being one, nor be taken out.
    h.add(grant(ada, 'member'), ada);
    h.add({ t: 'revoke', group: 'workspace', who: ada.id }, ada);
    expect(h.now().role(ada.id)).toBe('admin');
    // Ada, the owner, may not leave; once she has given Bo the role, she may (0070).
    h.add(grant(bo, 'admin'), ada);
    h.add({ t: 'revoke', group: 'workspace', who: ada.id }, ada);
    expect(h.now().role(ada.id)).toBe('admin');
    h.add({ t: 'owner', who: bo.id }, ada);
    expect(h.now().owner).toBe(bo.id);
    h.add({ t: 'revoke', group: 'workspace', who: ada.id }, ada);
    expect(h.now().role(ada.id)).toBeNull();
    expect(h.now().people()).toEqual([{ id: bo.id, role: 'admin' }]);
  });

  it('has groups the workspace’s admins make, each managed by its own admins too, inside the workspace', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'member'), ada);
    h.add(grant(cy, 'member'), ada);
    // Bo may not make a group; Ada may, and makes him its admin.
    h.add(grant(bo, 'admin', 'editors'), bo);
    expect(h.now().groups.has('editors')).toBe(false);
    h.add(grant(bo, 'admin', 'editors'), ada);
    h.add(grant(cy, 'member', 'editors'), bo);
    expect(h.now().role(cy.id, 'editors')).toBe('member');
    // No one outside the workspace is put in a group.
    h.add(grant(dee, 'member', 'editors'), bo);
    expect(h.now().role(dee.id, 'editors')).toBeNull();
    // A group in a group: its members are members.
    h.add({ t: 'grant', group: 'team', who: 'group:editors', role: 'member' }, ada);
    expect(h.now().role(cy.id, 'team')).toBe('member');
    // Anyone may leave a group; out of the workspace is out of every group.
    h.add({ t: 'revoke', group: 'editors', who: cy.id }, cy);
    expect(h.now().role(cy.id, 'editors')).toBeNull();
    h.add({ t: 'revoke', group: 'workspace', who: bo.id }, ada);
    expect(h.now().groups.get('editors')!.has(bo.id)).toBe(false);
  });

  it('puts whoever an admin’s invite link let in in its group, as it says; a link for one person, once', () => {
    const h = history();
    const g = h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    const link = '0123456789abcdef';
    const join = (who: { key: Key }, by: { key: Key }, role: Role, once: boolean, genesis: string | null = g.id) =>
      h.add({ t: 'join', group: 'workspace', role, link, once, granter: by.key.publicKey.toString('hex'), grant: sign(by, genesis, link, 'workspace', role, once) }, who);
    join(bo, ada, 'member', true);
    expect(h.now().role(bo.id)).toBe('member');
    // Used: no one else comes in by it.
    join(cy, ada, 'member', true);
    expect(h.now().role(cy.id)).toBeNull();
    // A member's grant lets no one in; nor one for another history of the workspace.
    const other = '1123456789abcdef';
    h.add({ t: 'join', group: 'workspace', role: 'admin', link: other, once: false, granter: bo.key.publicKey.toString('hex'), grant: sign(bo, g.id, other, 'workspace', 'admin', false) }, cy);
    expect(h.now().role(cy.id)).toBeNull();
    h.add({ t: 'join', group: 'workspace', role: 'member', link: other, once: false, granter: ada.key.publicKey.toString('hex'), grant: sign(ada, 'cd'.repeat(32), other, 'workspace', 'member', false) }, cy);
    expect(h.now().role(cy.id)).toBeNull();
    // A grant changed after it was signed (member to admin) counts for nothing.
    h.add({ t: 'join', group: 'workspace', role: 'admin', link: other, once: false, granter: ada.key.publicKey.toString('hex'), grant: sign(ada, g.id, other, 'workspace', 'member', false) }, dee);
    expect(h.now().role(dee.id)).toBeNull();
  });

  it('is the same from its operations in any order, and counts only those from the genesis it is pinned to', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'admin'), ada);
    h.add(grant(cy, 'member'), bo);
    h.add(grant(dee, 'member'), cy);
    const want = h.now();
    const shuffled = [...h.entries].reverse();
    const again = evaluate(shuffled, h.ctx());
    expect(again.people()).toEqual(want.people());
    expect(again.heads).toEqual(want.heads);
    expect(again.version).toBe(want.version);
    // A second genesis, by someone who would be its admin, counts for nothing; nor what descends from it.
    const rival = makeOp(WS, { t: 'genesis', admins: [dee.id], legacy: false }, [], dee.key);
    const after = makeOp(WS, grant(cy, 'admin'), [rival.id], dee.key);
    expect(evaluate([...h.entries, rival, after], h.ctx()).people()).toEqual(want.people());
    // Missing an operation's parent: it waits.
    expect(evaluate(h.entries.filter((_, i) => i !== 1), h.ctx()).role(cy.id)).toBeNull();
  });

  it('counts no legacy genesis, seal, verifier, witness or email entry (0078): a workspace from before is founded again first', () => {
    // Unpinned: nothing counts.
    const old = history(false);
    old.add({ t: 'genesis', admins: [ada.id, bo.id], legacy: true }, ada);
    expect(old.now().founded).toBe(false);
    expect(old.now().role(ada.id)).toBeNull();
    // Pinned: operations of kinds retired with 0078 keep the history whole, and count for nothing.
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add({ t: 'seal', geneses: [h.entries[0]!.id] }, ada);
    h.add({ t: 'verifier', key: 'ab'.repeat(32), url: 'https://verify.example.org' }, ada);
    h.add({ t: 'witness', who: bo.id, on: true }, ada);
    h.add({ t: 'grant', group: 'workspace', who: 'email:bo@uni.edu', role: 'member' }, ada);
    h.add({ t: 'rule', path: '', by: ['email:bo@uni.edu'] }, ada);
    // What comes after them still counts.
    h.add(grant(cy, 'member'), ada);
    const p = h.now();
    expect(p.applied).toHaveLength(2);
    expect(p.role(cy.id)).toBe('member');
    expect(p.groups.get('workspace')!.has('email:bo@uni.edu')).toBe(false);
    expect(p.rules.size).toBe(0);
  });

  it('says who may change what: the most specific rule for a file, people, groups or admins; anyone where none', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'member'), ada);
    h.add(grant(cy, 'member'), ada);
    h.add(grant(cy, 'member', 'editors'), ada);
    expect(h.now().mayWrite(bo.id, 'notes.md')).toBe(true);
    expect(h.now().mayWrite(null, 'notes.md')).toBe(true);
    // A member may not make rules; an admin may.
    h.add({ t: 'rule', path: '', by: ['admins'] }, bo);
    expect(h.now().rules.size).toBe(0);
    h.add({ t: 'rule', path: '', by: ['admins'] }, ada);
    h.add({ t: 'rule', path: 'chapters/', by: ['group:editors'] }, ada);
    h.add({ t: 'rule', path: 'chapters/bo.md', by: [bo.id] }, ada);
    const p = h.now();
    expect(p.mayWrite(ada.id, 'notes.md')).toBe(true);
    expect(p.mayWrite(bo.id, 'notes.md')).toBe(false);
    expect(p.mayWrite(null, 'notes.md')).toBe(false);
    expect(p.mayWrite(cy.id, 'chapters/one.md')).toBe(true);
    // The folder's rule counts in it, not the whole workspace's: Ada is no editor.
    expect(p.mayWrite(ada.id, 'chapters/one.md')).toBe(false);
    expect(p.mayWrite(bo.id, 'chapters/bo.md')).toBe(true);
    expect(p.mayWrite(cy.id, 'chapters/bo.md')).toBe(false);
    expect(p.ruleFor('chapters/sub/x.md')).toMatchObject({ path: 'chapters/', by: ['group:editors'] });
    // A rule naming no one is taken away.
    h.add({ t: 'rule', path: 'chapters/', by: [] }, ada);
    expect(h.now().ruleFor('chapters/one.md')).toMatchObject({ path: '', by: ['admins'] });
  });

  describe('changes made at the same time (step 4)', () => {
    /** A workspace whose admins are Ada and Bo, Cy a member: the point both branches start from. */
    const start = () => {
      const h = history();
      h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
      h.add(grant(bo, 'admin'), ada);
      h.add(grant(cy, 'member'), ada);
      return { h, base: h.now().heads };
    };

    it('removal wins over putting the same person in at once', () => {
      const { h, base } = start();
      h.add({ t: 'revoke', group: 'workspace', who: cy.id }, ada, base);
      h.add(grant(cy, 'admin'), bo, base);
      expect(h.now().role(cy.id)).toBeNull();
    });

    it('what someone taken out does at the same time counts for nothing (their cutoff)', () => {
      const { h, base } = start();
      h.add({ t: 'revoke', group: 'workspace', who: bo.id }, ada, base);
      // Bo, at the same time, makes Dee an admin and a rule: neither counts.
      h.add(grant(dee, 'admin'), bo, base);
      h.add({ t: 'rule', path: '', by: [bo.id] }, bo, base);
      const p = h.now();
      expect(p.role(bo.id)).toBeNull();
      expect(p.role(dee.id)).toBeNull();
      expect(p.rules.size).toBe(0);
      // What he did before (in the remover's past) still counts: Cy, whom Ada put in, stays.
      expect(p.role(cy.id)).toBe('member');
    });

    // Settled by what gives less (0078), never by rank.
    it('of two taking each other out at once, both are out (a ring of removals all count)', () => {
      const { h } = start();
      // Bo (an admin) and Cy (a member) are both admins of the team.
      h.add(grant(bo, 'admin', 'team'), ada);
      h.add(grant(cy, 'admin', 'team'), ada);
      const base = h.now().heads;
      h.add({ t: 'revoke', group: 'team', who: cy.id }, bo, base);
      h.add({ t: 'revoke', group: 'team', who: bo.id }, cy, base);
      const p = h.now();
      expect(p.role(bo.id, 'team')).toBeNull();
      expect(p.role(cy.id, 'team')).toBeNull();
      expect(evaluate([...h.entries].reverse(), h.ctx()).groups).toEqual(p.groups);
    });

    it('a removal stands over what the one taken out did at the same time, however it hashes (no rank, no tie by ID)', () => {
      const { h } = start();
      h.add(grant(bo, 'admin', 'team'), ada);
      h.add(grant(cy, 'admin', 'team'), ada);
      h.add(grant(dee, 'member'), ada);
      h.add(grant(dee, 'member', 'team'), ada);
      const base = h.now().heads;
      // Bo takes Cy out of the team; Cy, at the same time, takes Dee out: Cy's does not count.
      const r = h.add({ t: 'revoke', group: 'team', who: cy.id }, bo, base);
      const late = h.add({ t: 'revoke', group: 'team', who: dee.id }, cy, base);
      const p = h.now();
      expect(p.role(dee.id, 'team')).toBe('member');
      expect(p.clashes).toContainEqual({ lost: late.id, won: r.id, why: 'removed' });
    });

    it('what gives less counts on where someone is, whoever made it: an admin taking someone out as the owner makes them an admin', () => {
      const { h, base } = start();
      const out = h.add({ t: 'revoke', group: 'workspace', who: cy.id }, bo, base);
      const up = h.add(grant(cy, 'admin'), ada, base);
      const p = h.now();
      expect(p.role(cy.id)).toBeNull();
      // On record, the one that lost and why.
      expect(p.clashes).toEqual([{ lost: up.id, won: out.id, why: 'less' }]);
      // Made again on purpose, after both: it counts.
      h.add(grant(cy, 'admin'), ada);
      expect(h.now().role(cy.id)).toBe('admin');
    });

    it('of two handovers of the owner’s role at once (two of the owner’s computers), the one with the lower ID: one owner', () => {
      const { h, base } = start();
      h.add(grant(dee, 'member'), ada, base);
      const after = h.now().heads;
      const a = h.add({ t: 'owner', who: bo.id }, ada, after);
      const b = h.add({ t: 'owner', who: dee.id }, ada, after);
      const [won, lost] = a.id < b.id ? [a, b] : [b, a];
      const p = h.now();
      expect(p.owner).toBe(won.op.t === 'owner' ? won.op.who : null);
      expect(p.clashes).toContainEqual({ lost: lost.id, won: won.id, why: 'owner' });
      expect(p.role(ada.id)).toBe('admin');
    });

    it('rules made at the same time: the narrower counts; neither narrower, what both name; none in common, the admins', () => {
      const { h, base } = start();
      const wide = h.add({ t: 'rule', path: 'notes/', by: [bo.id, cy.id].sort() }, ada, base);
      const narrow = h.add({ t: 'rule', path: 'notes/', by: [cy.id] }, bo, base);
      let p = h.now();
      expect(p.ruleFor('notes/a.md')?.by).toEqual([cy.id]);
      expect(p.clashes).toEqual([{ lost: wide.id, won: narrow.id, why: 'narrower' }]);
      // Who reads a folder, likewise; and two that share no one: the admins.
      const now = h.now().heads;
      const x = h.add({ t: 'perm', path: 'secret/', read: [bo.id] }, ada, now);
      const y = h.add({ t: 'perm', path: 'secret/', read: [cy.id] }, bo, now);
      p = h.now();
      expect(p.readFor('secret/x.md')?.audience).toEqual(['admins']);
      expect(p.clashes.filter((c) => c.why === 'narrower' && (c.lost === x.id || c.lost === y.id))).toHaveLength(2);
      // A rule taken away at the same time as one is made: the one made counts (no rule is everyone).
      const then = h.now().heads;
      h.add({ t: 'rule', path: 'notes/', by: [] }, ada, then);
      h.add({ t: 'rule', path: 'notes/', by: [bo.id] }, bo, then);
      expect(h.now().ruleFor('notes/a.md')?.by).toEqual([bo.id]);
      expect(evaluate([...h.entries].reverse(), h.ctx()).perms).toEqual(h.now().perms);
    });

    it('leaving oneself always counts, over anything said of one at the same time', () => {
      const { h, base } = start();
      h.add({ t: 'revoke', group: 'workspace', who: cy.id }, cy, base);
      h.add(grant(cy, 'admin'), ada, base);
      expect(h.now().role(cy.id)).toBeNull();
    });

    it('giving someone the workspace as they leave it: the owner stays the owner', () => {
      const { h, base } = start();
      h.add({ t: 'owner', who: bo.id }, ada, base);
      h.add({ t: 'revoke', group: 'workspace', who: bo.id }, bo, base);
      const p = h.now();
      expect(p.owner).toBe(ada.id);
      expect(p.role(ada.id)).toBe('admin');
      expect(p.role(bo.id)).toBeNull();
    });

    it('of one person’s own changes at once (two computers), the one that gives less', () => {
      const { h, base } = start();
      h.add(grant(cy, 'admin', 'team'), ada, base);
      h.add(grant(cy, 'member', 'team'), ada, base);
      expect(h.now().role(cy.id, 'team')).toBe('member');
    });

    it('with an owner there is always an admin: every other admin leaving at once leaves the owner', () => {
      const { h, base } = start();
      h.add({ t: 'revoke', group: 'workspace', who: bo.id }, bo, base);
      h.add({ t: 'revoke', group: 'workspace', who: ada.id }, ada, base);
      const p = h.now();
      expect(p.people().filter((x) => x.role === 'admin').map((x) => x.id)).toEqual([ada.id]);
      expect(p.owner).toBe(ada.id);
    });

    // Found over histories made at random (0072): what counts must be allowed by what counts of its past.
    it('the owner leaving after a handover that did not count (its taker left at once): not counted', () => {
      const { h, base } = start();
      const handover = h.add({ t: 'owner', who: bo.id }, ada, base);
      h.add({ t: 'revoke', group: 'workspace', who: bo.id }, bo, base);
      h.add({ t: 'revoke', group: 'workspace', who: ada.id }, ada, [handover.id]);
      const p = h.now();
      expect(p.owner).toBe(ada.id);
      expect(p.role(ada.id)).toBe('admin');
    });

    it('what someone did, let in by a grant that was cut off: not counted', () => {
      const { h, base } = start();
      // Bo (an admin) lets Dee in, as Ada (the owner) takes Bo out; Dee then makes a space.
      const made = h.add(grant(dee, 'member'), bo, base);
      const out = h.add({ t: 'revoke', group: 'workspace', who: bo.id }, ada, base);
      const space = h.add({ t: 'space', id: '44'.repeat(16), audience: [dee.id] }, dee, [made.id]);
      const p = h.now();
      expect(p.role(bo.id)).toBeNull();
      expect(p.role(dee.id)).toBeNull();
      expect(p.spaces.size).toBe(0);
      // Both on record: Bo's grant lost to his removal; Dee's space, made on it, did not count either.
      expect(p.clashes).toEqual(expect.arrayContaining([{ lost: made.id, won: out.id, why: 'removed' }, { lost: space.id, won: null, why: 'unfounded' }]));
    });

    it('keeps a removal’s cutoff: the commits the person had made that still count', () => {
      const { h } = start();
      h.add({ t: 'revoke', group: 'workspace', who: cy.id, cutoff: ['ab'.repeat(20)] }, ada);
      expect(h.now().cutoffs.get(cy.id)).toEqual(['ab'.repeat(20)]);
      h.add(grant(cy, 'member'), ada);
      expect(h.now().cutoffs.has(cy.id)).toBe(false);
    });
  });

  it('has permissions on files and folders: who may change, who reads what is made there; nearest first; private paths by their hash (0069)', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'member'), ada);
    h.add(grant(cy, 'member'), ada);
    // A member may not; an admin may.
    h.add({ t: 'perm', path: 'plans/', write: [bo.id] }, bo);
    expect(h.now().perms.size).toBe(0);
    h.add({ t: 'perm', path: 'plans/', write: [ada.id], read: [ada.id, bo.id] }, ada);
    // A private file's permission, by its hash.
    const secret = hashedPath(WS, 'plans/party.md');
    h.add({ t: 'perm', path: secret, write: [bo.id] }, ada);
    const p = h.now();
    expect(p.ruleFor('plans/budget.md')).toMatchObject({ path: 'plans/', by: [ada.id] });
    expect(p.ruleFor('plans/party.md')).toMatchObject({ path: 'plans/party.md', by: [bo.id], key: secret });
    expect(p.mayWrite(bo.id, 'plans/party.md')).toBe(true);
    expect(p.mayWrite(bo.id, 'plans/budget.md')).toBe(false);
    // Who reads what is made there: the folder's audience, for its files and folders (and its own).
    expect(p.readFor('plans/new.md')).toMatchObject({ path: 'plans/', audience: [ada.id, bo.id] });
    expect(p.readFor('plans/sub/new.md')?.path).toBe('plans/');
    expect(p.readFor('plans/')?.path).toBe('plans/');
    expect(p.readFor('notes.md')).toBeNull();
    // A rule made as before is the same as a perm's write, keeping what the perm says of reading.
    h.add({ t: 'rule', path: 'plans/', by: [cy.id] }, ada);
    expect(h.now().permAt('plans/')?.perm).toEqual({ write: [cy.id], read: [ada.id, bo.id] });
    h.add({ t: 'perm', path: 'plans/' }, ada);
    expect(h.now().permAt('plans/')).toBeNull();
    expect(pathsAbove('a/b/c.md')).toEqual(['a/b/c.md', 'a/b/', 'a/', '']);
  });

  it('has folders that hold a space of their own: who reads them is that space’s audience, changed in place (0072)', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'member'), ada);
    const space = '33'.repeat(16);
    h.add({ t: 'space', id: space, audience: [ada.id] }, ada);
    h.add({ t: 'perm', path: 'private/', read: [ada.id], space }, ada);
    expect(h.now().readFor('private/notes.md')).toMatchObject({ path: 'private/', audience: [ada.id], space });
    expect(h.now().isFolderSpace(space)).toBe(true);
    // Bo let read it: the space's audience changes; the folder's permission is the same space.
    h.add({ t: 'space', id: space, audience: [ada.id, bo.id].sort() }, ada);
    expect(h.now().readFor('private/notes.md')).toMatchObject({ audience: [ada.id, bo.id].sort(), space });
    expect(h.now().mayRead(bo.id, space)).toBe(true);
    // A space only with who reads: not on its own.
    expect(readOp({ t: 'perm', path: 'x/', space })).toBeNull();
  });

  it('has an owner above the admins: only the owner makes and unmakes admins, and gives the role away (0070)', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    expect(h.now().owner).toBe(ada.id);
    h.add(grant(bo, 'admin'), ada);
    h.add(grant(cy, 'member'), ada);
    // Bo, an admin, may put people in and take members out, but not make or unmake admins.
    h.add(grant(dee, 'member'), bo);
    expect(h.now().role(dee.id)).toBe('member');
    h.add(grant(cy, 'admin'), bo);
    expect(h.now().role(cy.id)).toBe('member');
    h.add(grant(ada, 'member'), bo);
    h.add({ t: 'revoke', group: 'workspace', who: ada.id }, bo);
    expect(h.now().role(ada.id)).toBe('admin');
    h.add({ t: 'revoke', group: 'workspace', who: dee.id }, bo);
    expect(h.now().role(dee.id)).toBeNull();
    // Nor give the owner's role, which is not his.
    h.add({ t: 'owner', who: bo.id }, bo);
    expect(h.now().owner).toBe(ada.id);
    // Ada makes Cy an admin, and Bo a member.
    h.add(grant(cy, 'admin'), ada);
    h.add(grant(bo, 'member'), ada);
    expect(h.now().role(cy.id)).toBe('admin');
    expect(h.now().role(bo.id)).toBe('member');
    // She gives the role to Bo (a member): he is the owner and an admin; she stays an admin.
    h.add({ t: 'owner', who: bo.id }, ada);
    const p = h.now();
    expect(p.owner).toBe(bo.id);
    expect(p.role(bo.id)).toBe('admin');
    expect(p.role(ada.id)).toBe('admin');
    expect(p.mayAssignAdmins(ada.id)).toBe(false);
    expect(p.mayAssignAdmins(bo.id)).toBe(true);
  });

  });

describe('a document’s own files (0109)', () => {
  it('count their document between their folder and the folder the two are in', () => {
    expect(permissionPaths('ch/report.md.files/bay.jpg')).toEqual(['ch/report.md.files/bay.jpg', 'ch/report.md.files/', 'ch/report.md', 'ch/', '']);
    expect(permissionPaths('report.md.files/raw/a.csv')).toEqual(['report.md.files/raw/a.csv', 'report.md.files/raw/', 'report.md.files/', 'report.md', '']);
    expect(permissionPaths('ch/notes.md')).toEqual(pathsAbove('ch/notes.md'));
  });

  it('are changed by whoever may change their document, its own permission theirs, in the clear or private', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'member'), ada);
    h.add(grant(cy, 'member'), ada);
    h.add({ t: 'perm', path: 'ch/', write: [cy.id] }, ada);
    h.add({ t: 'perm', path: 'ch/report.md', write: [bo.id] }, ada);
    h.add({ t: 'perm', path: hashedPath(WS, 'ch/party.md'), write: [ada.id] }, ada);
    const p = h.now();
    expect(p.ruleFor('ch/report.md.files/bay.jpg')).toMatchObject({ path: 'ch/report.md', by: [bo.id] });
    expect(p.mayWrite(bo.id, 'ch/report.md.files/bay.jpg')).toBe(true);
    expect(p.mayWrite(cy.id, 'ch/report.md.files/bay.jpg')).toBe(false);
    expect(p.mayWrite(ada.id, 'ch/party.md.files/cake.png')).toBe(true);
    expect(p.mayWrite(bo.id, 'ch/party.md.files/cake.png')).toBe(false);
    // A document with no permission of its own: its folder's, as before.
    expect(p.mayWrite(cy.id, 'ch/notes.md.files/a.png')).toBe(true);
    expect(p.mayWrite(bo.id, 'ch/notes.md.files/a.png')).toBe(false);
    // Reading is its space's, not a permission's: a file's permission says nothing of it.
    expect(p.readFor('ch/report.md.files/bay.jpg')).toBeNull();
  });
});
