// What a second review of the network found, and how it is held to now: a
// workspace from before policies worked out, the one last time (legacy.ts,
// 0078), kept to its own geneses and seal; invite links unlinked, and joins
// counted only where a device in let their holder in; only what shows a device
// to be in kept of what it sends before it is; edits passed on judged by whose they are;
// a stream's window held to; links and look-alike paths refused at the gate;
// what a device says on the local network tied to where it says it from.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { duplexPair, type Duplex } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import Protomux from 'protomux';
import c from 'compact-encoding';
import type { SwarmConnection } from 'hyperswarm';
import { Git } from '../src/git.js';
import { Identity, decodeLink, linkProofFor } from '../src/peers/identity.js';
import { admittedGrantMessage, evaluate, linkGrantMessage, makeOp, type PolicyContext, type PolicyEntry, type PolicyOp } from '../src/peers/policy.js';
import { sign, signRecord, signsMessage, vouchMessage } from '../src/peers/records.js';
import { identityId, incept, type KeyEvent } from '../src/peers/kel.js';
import { evaluateLegacy, type LegacyContext, type LegacySnapshot } from '../src/peers/legacy.js';
import { PeerLink } from '../src/peers/link.js';
import { Rooms, readAwareness, writeAwareness } from '../src/peers/rooms.js';
import { gate, type GateContext } from '../src/peers/gate.js';
import { lanTag, saidBy } from '../src/peers/lan.js';

const WS = 'ab'.repeat(16);
type Key = ReturnType<typeof crypto.keyPair>;
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `kuraa-${name}-`));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** People for the policy alone: each a signing key, and the identity it is (as vouches would say). */
function people() {
  const keys = new Map<string, string>();
  const person = () => {
    const p = { key: crypto.keyPair(), id: crypto.keyPair().publicKey.toString('hex') };
    keys.set(hex(p.key), p.id);
    return p;
  };
  /** Another key of the same person (a fresh computer of theirs). */
  const another = (p: { id: string }) => {
    const key = crypto.keyPair();
    keys.set(hex(key), p.id);
    return key;
  };
  return { person, another, personOf: (k: string) => keys.get(k) ?? null };
}

/** A person's place in a legacy snapshot's workspace. */
const roleIn = (s: LegacySnapshot, id: string) => s.groups.workspace?.[id] ?? null;

describe('a workspace from before policies, worked out the one last time (its legacy geneses: legacy.ts)', () => {
  /** Ada's device wrote a legacy genesis naming Ada and Bo; Ada sealed it, then made a rule. As legacy.ts in the review. */
  function sealed() {
    const p = people();
    const [ada, bo, eve] = [p.person(), p.person(), p.person()];
    const entries: PolicyEntry[] = [];
    const add = (op: PolicyOp, key: Key, parents: string[]) => {
      const e = makeOp(WS, op, parents, key);
      entries.push(e);
      return e;
    };
    const g = add({ t: 'genesis', admins: [ada.id, bo.id].sort(), legacy: true }, ada.key, []);
    const seal = add({ t: 'seal', geneses: [g.id] }, ada.key, [g.id]);
    add({ t: 'rule', path: 'secret/', by: ['admins'] }, ada.key, [seal.id]);
    return { ...p, ada, bo, eve, entries, g, seal, add };
  }

  it('takes no legacy genesis a stranger brings, nor a seal of it, however its hash falls (the takeover the review showed)', () => {
    const w = sealed();
    // Ada's device: its own genesis, the seal it keeps to.
    const kept: LegacyContext = { workspace: WS, personOf: w.personOf, legacy: [w.g.id], seal: w.seal.id };
    // One that has not kept to the seal yet (it has its own geneses only).
    const unsealed: LegacyContext = { ...kept, seal: null };
    // Eve, never in: a legacy genesis naming her and a seal naming it alone, signed by many keys (some hashing below Ada's seal).
    for (let i = 0; i < 24; i++) {
      const key = w.another(w.eve);
      const g = makeOp(WS, { t: 'genesis', admins: [w.eve.id], legacy: true }, [], key);
      const s = makeOp(WS, { t: 'seal', geneses: [g.id] }, [g.id], key);
      for (const ctx of [kept, unsealed]) {
        const p = evaluateLegacy([...w.entries, g, s], ctx);
        expect(p.owner).toBe(w.ada.id);
        expect(roleIn(p, w.eve.id)).toBeNull();
        expect(roleIn(p, w.ada.id)).toBe('admin');
        expect(roleIn(p, w.bo.id)).toBe('admin');
        expect(p.perms['secret/']?.write).toEqual(['admins']);
      }
    }
  });

  it('keeps to its seal: one an admin from before makes later, beside it, counts for nothing', () => {
    const w = sealed();
    // Bo, an admin there, seals the same geneses again, as if he had not seen Ada's seal (to be the owner).
    const late = makeOp(WS, { t: 'seal', geneses: [w.g.id] }, [w.g.id], w.bo.key);
    const p = evaluateLegacy([...w.entries, late], { workspace: WS, personOf: w.personOf, legacy: [w.g.id], seal: w.seal.id });
    expect(p.owner).toBe(w.ada.id);
  });

  it('of seals made at the same time, counts the one taking the fewest out, wherever it is worked out', () => {
    const p = people();
    const [ada, bo, cy] = [p.person(), p.person(), p.person()];
    const g1 = makeOp(WS, { t: 'genesis', admins: [ada.id, bo.id].sort(), legacy: true }, [], ada.key);
    const g2 = makeOp(WS, { t: 'genesis', admins: [bo.id, cy.id].sort(), legacy: true }, [], bo.key);
    // Bo seals his own alone (Ada out); Ada, at the same time, both.
    const narrow = makeOp(WS, { t: 'seal', geneses: [g2.id] }, [g1.id, g2.id], bo.key);
    const wide = makeOp(WS, { t: 'seal', geneses: [g1.id, g2.id].sort() }, [g1.id, g2.id], ada.key);
    const ctx: LegacyContext = { workspace: WS, personOf: p.personOf, legacy: [g1.id, g2.id] };
    for (const order of [[g1, g2, narrow, wide], [wide, narrow, g2, g1]]) {
      const policy = evaluateLegacy(order, ctx);
      expect(policy.owner).toBe(ada.id);
      expect(roleIn(policy, ada.id)).toBe('admin');
    }
  });

  it('counts a genesis a device of the workspace wrote and had not passed on, signed by someone the others name', () => {
    const p = people();
    const [ada, cy, dee, eve] = [p.person(), p.person(), p.person(), p.person()];
    const g1 = makeOp(WS, { t: 'genesis', admins: [ada.id, cy.id].sort(), legacy: true }, [], ada.key);
    // Cy's device, offline when the others wrote theirs: its own, naming Dee too.
    const g3 = makeOp(WS, { t: 'genesis', admins: [cy.id, dee.id].sort(), legacy: true }, [], cy.key);
    const ge = makeOp(WS, { t: 'genesis', admins: [eve.id], legacy: true }, [], eve.key);
    const all = [g1, g3, ge];
    // Ada's device (g1 its own) and Cy's (g3) come to the same: Eve, whom no one there names, is not in.
    const onAda = evaluateLegacy(all, { workspace: WS, personOf: p.personOf, legacy: [g1.id] });
    const onCy = evaluateLegacy(all, { workspace: WS, personOf: p.personOf, legacy: [g3.id, g1.id] });
    for (const policy of [onAda, onCy]) {
      expect(policy.geneses.sort()).toEqual([g1.id, g3.id].sort());
      expect(roleIn(policy, dee.id)).toBe('admin');
      expect(roleIn(policy, eve.id)).toBeNull();
    }
  });
});

describe('invite links in the policy', () => {
  /** Ada's pinned workspace; a link for anyone, its grant signed long ago (expired), with Mal let in by it. As join.ts in the review. */
  function workspace(grantOf: typeof linkGrantMessage = linkGrantMessage) {
    const p = people();
    const [ada, bo, mal, mal2] = [p.person(), p.person(), p.person(), p.person()];
    const entries: PolicyEntry[] = [];
    const ctx = (): PolicyContext => ({ workspace: WS, pin: entries[0]?.id ?? null, personOf: p.personOf });
    const now = () => evaluate(entries, ctx());
    const add = (op: PolicyOp, by: { key: Key }, parents = op.t === 'genesis' ? [] : now().heads) => {
      const e = makeOp(WS, op, parents, by.key);
      entries.push(e);
      return e;
    };
    const g = add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    add({ t: 'grant', group: 'workspace', who: bo.id, role: 'member' }, ada);
    const link = '0123456789abcdef';
    const expires = Date.now() - 30 * 86_400_000;
    const issuer = 'cd'.repeat(32);
    const grant = crypto.sign(grantOf(WS, g.id, link, 'workspace', 'member', false, expires, issuer), ada.key.secretKey).toString('hex');
    const join: PolicyOp = { t: 'join', group: 'workspace', role: 'member', link, once: false, granter: hex(ada.key), grant, expires, issuer };
    return { ada, bo, mal, mal2, entries, now, add, g, link, join };
  }

  it('lets no one in by a link unlinked: not someone taken out coming back as another, nor anyone at the same time', () => {
    const w = workspace();
    w.add(w.join, w.mal);
    expect(w.now().role(w.mal.id)).toBe('member');
    w.add({ t: 'revoke', group: 'workspace', who: w.mal.id }, w.ada);
    w.add({ t: 'unlink', link: w.link, group: 'workspace' }, w.ada);
    expect(w.now().unlinked.has(w.link)).toBe(true);
    // Mal, as someone new, the same grant, after the genesis (all the link says): at the same time as the unlink, so not in.
    w.add(w.join, w.mal2, [w.g.id]);
    expect(w.now().role(w.mal2.id)).toBeNull();
    // Nor after it.
    w.add(w.join, w.mal2);
    expect(w.now().role(w.mal2.id)).toBeNull();
  });

  it('keeps those who came in by a link before it was unlinked; an unlink is an admin’s of its group', () => {
    const w = workspace();
    w.add(w.join, w.mal);
    // Bo, a member, may not unlink it.
    w.add({ t: 'unlink', link: w.link, group: 'workspace' }, w.bo);
    expect(w.now().unlinked.size).toBe(0);
    w.add({ t: 'unlink', link: w.link, group: 'workspace' }, w.ada);
    expect(w.now().role(w.mal.id)).toBe('member');
  });

  it('counts a join by a grant made since only for whom a device in let in by its link (it checked the link had not expired)', () => {
    const w = workspace(admittedGrantMessage);
    // The expired link's grant, alone: no one is let in by it.
    w.add(w.join, w.mal2, [w.g.id]);
    expect(w.now().role(w.mal2.id)).toBeNull();
    // A stranger saying they let someone in does not count.
    const p = people();
    const stranger = p.person();
    w.add({ t: 'admit', link: w.link, key: hex(w.mal2.key) }, stranger);
    w.add(w.join, w.mal2);
    expect(w.now().role(w.mal2.id)).toBeNull();
    // Bo's device let Mal in by it: Mal's join counts; Mal2's, whom it did not, still does not.
    w.add({ t: 'admit', link: w.link, key: hex(w.mal.key) }, w.bo);
    w.add(w.join, w.mal);
    expect(w.now().role(w.mal.id)).toBe('member');
    expect(w.now().role(w.mal2.id)).toBeNull();
  });
});

interface TestIdentity { id: string; key: Key; events: KeyEvent[] }
function identity(): TestIdentity {
  const key = crypto.keyPair();
  const icp = incept(key, crypto.keyPair());
  return { id: identityId(icp), key, events: [icp] };
}

/** A device's records of itself and its person: its key events, the key it signs with, and that key vouched for. */
function deviceOf(ws: string, person: TestIdentity, name: string) {
  const device = crypto.keyPair();
  const signing = crypto.keyPair();
  const m = vouchMessage(hex(signing), person.id, name);
  return {
    device,
    signing,
    records: [
      ...person.events.map((e) => signRecord({ kind: 'key-event', workspace: ws, subject: person.id, event: e }, device)),
      signRecord({ kind: 'signs', workspace: ws, subject: hex(signing), proof: sign(signsMessage(hex(device)), signing) }, device),
      signRecord({ kind: 'vouch', workspace: ws, subject: hex(signing), person: person.id, personKey: hex(person.key), name, proof: sign(m, person.key), keyProof: sign(m, signing) }, device),
    ],
  };
}

const policyRecord = (ws: string, e: PolicyEntry, by: Key) => signRecord({ kind: 'policy', workspace: ws, subject: e.id, op: e.op, parents: e.parents, signer: e.signer, proof: e.proof }, by);

/** A workspace on a device of Ada's: pinned (made now), or one from before (her legacy genesis, naming her, written as it was then). */
async function workspace(fresh = true) {
  const dir = tmp('review');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const id = new Identity(new Git(dir), join(dir, '.git', 'kuraa'));
  const ws = await id.found();
  const ada = identity();
  const adaKey = crypto.keyPair();
  await id.signsWith(adaKey);
  await id.vouch({ name: 'Ada', ...ada.key, id: ada.id, events: ada.events }, adaKey);
  if (fresh) await id.ensureGenesis(ada.id, adaKey, true);
  else {
    const g = makeOp(ws.id, { t: 'genesis', admins: [ada.id], legacy: true }, [], adaKey);
    await id.decide('policy', g.id, { op: g.op, parents: g.parents, signer: g.signer, proof: g.proof });
    // As if written by a kuraa from before: this one works the legacy policy out first now, from what it holds.
    rmSync(join(dir, '.git', 'kuraa', 'legacy-last.json'), { force: true });
  }
  return { id, ws, ada, adaKey, dir };
}

describe('what a device not known to be in sends', () => {
  it('a stranger’s legacy genesis and seal, in its hello’s proof: nothing kept, the workspace still Ada’s', async () => {
    const { id, ws, ada, dir } = await workspace(false);
    expect((await id.policy()).isAdmin(ada.id)).toBe(true);
    const eve = deviceOf(ws.id, identity(), 'Eve');
    const eveId = (eve.records.find((r) => r.kind === 'vouch')!).person!;
    const g = makeOp(ws.id, { t: 'genesis', admins: [eveId], legacy: true }, [], eve.signing);
    const s = makeOp(ws.id, { t: 'seal', geneses: [g.id] }, [g.id], eve.signing);
    const proof = [...eve.records, policyRecord(ws.id, g, eve.device), policyRecord(ws.id, s, eve.device)];
    const before = readFileSync(join(dir, '.git', 'kuraa', 'records.json'), 'utf8');
    expect(await id.proven(hex(eve.device), proof)).toEqual([]);
    expect(readFileSync(join(dir, '.git', 'kuraa', 'records.json'), 'utf8')).toBe(before);
    // Even taken as a member would pass them on: her genesis is not this workspace's.
    await id.takeRecords(proof);
    const p = await id.policy();
    expect(p.isAdmin(ada.id)).toBe(true);
    expect(p.role(eveId)).toBeNull();
    expect((await id.members()).map((m) => m.key)).not.toContain(hex(eve.device));
  });

  it('of one whose join counts, only what is about it and counts', async () => {
    const { id, ws, adaKey } = await workspace();
    const dee = deviceOf(ws.id, identity(), 'Dee');
    const deeId = dee.records.find((r) => r.kind === 'vouch')!.person!;
    const l = decodeLink(await id.createLink(1, false, { relays: [], tcp: [] }, { key: adaKey }));
    const g = l.grant!;
    await id.admit(l.id, hex(dee.signing), adaKey);
    const join = makeOp(ws.id, { t: 'join', group: g.group, role: g.role, link: l.id, once: l.once, granter: g.granter, grant: g.signature, expires: l.expires, issuer: l.issuer.key, linkKey: g.linkKey!, linkProof: linkProofFor(l, hex(dee.signing))! }, (await id.policy()).heads, dee.signing);
    // With her proof: an operation of hers that counts for nothing, and someone else's records.
    const junk = makeOp(ws.id, { t: 'rule', path: '', by: [deeId] }, [join.id], dee.signing);
    const other = deviceOf(ws.id, identity(), 'Other');
    const proof = [...dee.records, policyRecord(ws.id, join, dee.device), policyRecord(ws.id, junk, dee.device), ...other.records];
    const kept = await id.proven(hex(dee.device), proof);
    expect(kept.map((r) => r.subject)).toContain(join.id);
    expect(kept.map((r) => r.subject)).not.toContain(junk.id);
    expect(kept.some((r) => other.records.some((o) => o.sig === r.sig))).toBe(false);
    await id.takeRecords(kept);
    expect((await id.members()).map((m) => m.key)).toContain(hex(dee.device));
  });

  it('revoking a link unlinks it in the policy, so its grant lets no one in, wherever it is checked', async () => {
    const { id, adaKey } = await workspace();
    const l = decodeLink(await id.createLink(null, false, { relays: [], tcp: [] }, { key: adaKey }));
    expect(await id.refuseGrant(l)).toBeNull();
    await id.revokeLink(l.id, adaKey);
    expect((await id.policy()).unlinked.has(l.id)).toBe(true);
    expect(await id.refuseGrant(l)).toBe('the link was revoked');
  });
});

describe('edits passed on in a room', () => {
  const KEY = 'main\0notes.md\0pandoc@1';
  const device = (n: number) => String(n).repeat(64).slice(0, 64);
  const [ME, ALLOWED, BARRED, FORWARDER, OTHER] = [device(1), device(2), device(3), device(4), device(5)];

  function rooms() {
    const applied: { peer: string; user: unknown }[] = [];
    const awareness: Uint8Array[] = [];
    // This device's own client in the room: id 1.
    const local = writeAwareness([{ id: 1, clock: 1, state: JSON.stringify({ user: { name: 'Ada' } }) }]);
    const room = { name: 'r', key: KEY, seed: 's', path: 'notes.md', branch: 'main' };
    const relay = {
      onUpdate: () => () => undefined,
      onAwareness: () => () => undefined,
      stateVector: () => new Uint8Array(),
      diff: () => null,
      awarenessState: () => local,
      applyPeerUpdate: (_name: string, _update: Uint8Array, peer: string, user: unknown) => applied.push({ peer, user }),
      applyPeerAwareness: (_name: string, update: Uint8Array) => awareness.push(update),
      removePeerAwareness: () => undefined,
    };
    // No feature keeps state in rooms here (0082): edits are taken as they always were.
    const host = { sessionRelay: relay, roomView: () => room, liveRoom: () => room, liveRooms: () => [room], spaceOf: () => null, roomContributors: () => [], addContributors: () => undefined, commitSoon: () => undefined, features: { keepsRoomState: () => false, person: () => null } };
    const links = new Map<string, PeerLink>();
    const link = (key: string) => {
      const l = { key, accepted: true, remote: key.slice(0, 4), hello: { workspace: WS }, sendRoom: () => true } as unknown as PeerLink;
      links.set(key, l);
      return l;
    };
    const node = {
      links,
      ws: { id: WS },
      myKey: ME,
      mayWrite: (k: string) => k !== BARRED,
      mayReadSpace: () => true,
      identity: { personOf: async (k: string) => ({ key: k, name: `person of ${k.slice(0, 1)}` }) },
    };
    const r = new Rooms(host as never, node as never);
    const forwarder = link(FORWARDER);
    r.message(forwarder, { type: 'room', op: 'open', key: KEY, seed: 's', sv: new Uint8Array() });
    return { r, applied, awareness, forwarder, link };
  }

  it('takes an edit passed on only if the device it was made on may change the document too; credits whom the records say', async () => {
    const { r, applied, forwarder } = rooms();
    r.message(forwarder, { type: 'room', op: 'update', key: KEY, update: new Uint8Array([1]), origin: BARRED });
    expect(applied).toEqual([]);
    r.message(forwarder, { type: 'room', op: 'update', key: KEY, update: new Uint8Array([1]), origin: ALLOWED, by: { name: 'The Queen', email: 'queen@example.org', color: '#f00' } });
    expect(applied).toHaveLength(1);
    expect(applied[0]!.peer).toBe(`${FORWARDER}>${ALLOWED}`);
    expect(applied[0]!.user).not.toMatchObject({ name: 'The Queen' });
    expect(applied[0]!.user).not.toMatchObject({ email: 'queen@example.org' });
    // Once the records are read: the person whose device it was made on.
    await new Promise((res) => setTimeout(res, 10));
    r.message(forwarder, { type: 'room', op: 'update', key: KEY, update: new Uint8Array([2]), origin: ALLOWED, by: { name: 'The Queen', email: 'queen@example.org', color: '#f00' } });
    expect(applied[1]!.user).toMatchObject({ name: 'person of 2', email: '' });
  });

  it('lets a device set where people are only for clients it brought, not this device’s own or another’s', () => {
    const { r, awareness, forwarder, link } = rooms();
    const update = writeAwareness([{ id: 1, clock: 9, state: JSON.stringify({ user: { name: 'Not Ada' } }) }, { id: 7, clock: 1, state: JSON.stringify({ user: { name: 'Bo' } }) }]);
    r.message(forwarder, { type: 'room', op: 'awareness', key: KEY, update });
    expect(awareness.map((u) => readAwareness(u)!.map((e) => e.id))).toEqual([[7]]);
    const other = link(OTHER);
    r.message(other, { type: 'room', op: 'open', key: KEY, seed: 's', sv: new Uint8Array() });
    r.message(other, { type: 'room', op: 'awareness', key: KEY, update: writeAwareness([{ id: 7, clock: 2, state: 'null' }]) });
    expect(awareness).toHaveLength(1);
  });
});

describe('a stream between devices', () => {
  it('is closed when the other end sends past its window, not piled up here', async () => {
    const [x, y] = duplexPair();
    const a = new PeerLink(Object.assign(x, { remotePublicKey: Buffer.alloc(32, 1), publicKey: Buffer.alloc(32, 2) }) as unknown as SwarmConnection, () => undefined);
    let served: Duplex | null = null;
    a.onGit((_service, _protocol, stream) => (served = stream));
    // The other end, by hand: it asks for a stream, then sends 4 MiB without waiting for what it is told was taken.
    const mux = Protomux.from(y);
    const channel = mux.createChannel({ protocol: 'kuraa/git/1', id: Buffer.alloc(16, 3) })!;
    const request = channel.addMessage({ encoding: c.json, onmessage: () => undefined });
    const data = channel.addMessage({ encoding: c.buffer, onmessage: () => undefined });
    channel.addMessage({ encoding: c.buffer, onmessage: () => undefined });
    // What it is told was taken: not waited for.
    channel.addMessage({ encoding: c.uint, onmessage: () => undefined });
    channel.open();
    request.send({ service: 'git-upload-pack', protocol: '' });
    for (let i = 0; i < 100 && !served; i++) await new Promise((r) => setTimeout(r, 10));
    expect(served).not.toBeNull();
    const stream = served as unknown as Duplex;
    for (let i = 0; i < 64; i++) data.send(Buffer.alloc(64 * 1024, 7));
    for (let i = 0; i < 200 && !stream.destroyed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(stream.destroyed).toBe(true);
    // Taken here meanwhile: about the window, not all it sent.
    expect(stream.readableLength).toBeLessThan(3 * 1024 * 1024);
    a.close();
    y.destroy();
  });
});

describe('the gate, on what a commit brings', () => {
  function repo() {
    const dir = tmp('gate');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.org');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Base');
    return { dir, git: new Git(dir), base: git(dir, 'rev-parse', 'HEAD') };
  }

  /** A commit on `parent` with these entries added (mode, path, text), made with git's plumbing (as any device could). */
  function commitOf(dir: string, parent: string, entries: [string, string, string][]): string {
    const index = join(dir, '.git', `index-${Math.random().toString(16).slice(2)}`);
    // Paths as given, in whichever Unicode form (git on a Mac would otherwise compose them).
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.precomposeunicode', GIT_CONFIG_VALUE_0: 'false' };
    execFileSync('git', ['read-tree', parent], { cwd: dir, env });
    for (const [mode, path, text] of entries) {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { cwd: dir, env });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: dir, env, encoding: 'utf8' }).trim();
    return execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', 'Theirs'], { cwd: dir, encoding: 'utf8' }).trim();
  }

  function ctx(...ops: PolicyOp[]): GateContext {
    const p = people();
    const ada = p.person();
    const entries: PolicyEntry[] = [makeOp(WS, { t: 'genesis', admins: [ada.id], legacy: false }, [], ada.key)];
    for (const op of ops) entries.push(makeOp(WS, op, [entries.at(-1)!.id], ada.key));
    return { policy: evaluate(entries, { workspace: WS, pin: entries[0]!.id, personOf: p.personOf }), known: new Set(entries.map((e) => e.id)), personOf: p.personOf, nameOf: () => null };
  }

  it('refuses a link (a symlink) a commit brings, whatever the rules, keeping the rest', async () => {
    const r = repo();
    const theirs = commitOf(r.dir, r.base, [['120000', 'escape.md', '/etc/passwd'], ['100644', 'ok.md', 'fine\n']]);
    for (const c of [ctx(), ctx({ t: 'rule', path: 'notes.md', by: ['admins'] })]) {
      const g = await gate(r.git, r.base, theirs, c);
      expect([...g.keeps]).toEqual([['escape.md', null]]);
      expect(g.refused.map((x) => x.path)).toEqual(['escape.md']);
    }
  });

  it('refuses a path that is another, or one a rule names, but for case or Unicode form', async () => {
    const r = repo();
    // notes.md is here: NOTES.md is the same file on most Macs' disks.
    const upper = commitOf(r.dir, r.base, [['100644', 'NOTES.md', 'Mine now.\n']]);
    expect([...(await gate(r.git, r.base, upper, ctx())).keeps.keys()]).toEqual(['NOTES.md']);
    // A rule on secret/ (nothing in it yet): Secret/ is the same folder there, round the rule.
    const round = commitOf(r.dir, r.base, [['100644', 'Secret/plan.md', 'Mine.\n']]);
    expect([...(await gate(r.git, r.base, round, ctx({ t: 'rule', path: 'secret/', by: ['admins'] }))).keeps.keys()]).toEqual(['Secret/plan.md']);
    // One spelt in another Unicode form (é as e and a combining accent).
    const base2 = commitOf(r.dir, r.base, [['100644', 'café.md', 'One.\n']]);
    const nfd = commitOf(r.dir, base2, [['100644', 'café.md', 'Two.\n']]);
    expect([...(await gate(r.git, base2, nfd, ctx())).keeps.keys()]).toEqual(['café.md']);
    // An ordinary new file: taken.
    const plain = commitOf(r.dir, r.base, [['100644', 'other.md', 'Fine.\n']]);
    expect((await gate(r.git, r.base, plain, ctx())).keeps.size).toBe(0);
  });
});

describe('a device on the local network', () => {
  it('is taken to be where it said it was only from the address it said it from', () => {
    const key = Buffer.alloc(32, 5);
    const device = 'ab'.repeat(32);
    const tags = new Set([lanTag(key, device, 4000, '192.168.1.20')]);
    expect(saidBy(tags, key, device, 4000, '192.168.1.20')).toBe(true);
    // The same, said again by another computer on the network.
    expect(saidBy(tags, key, device, 4000, '192.168.1.66')).toBe(false);
    // Said from an address it could not tell: only from this computer itself.
    const unaddressed = new Set([lanTag(key, device, 4000, '')]);
    expect(saidBy(unaddressed, key, device, 4000, '127.0.0.1')).toBe(true);
    expect(saidBy(unaddressed, key, device, 4000, '192.168.1.66')).toBe(false);
  });
});
