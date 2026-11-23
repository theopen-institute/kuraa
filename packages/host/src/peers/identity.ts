// Who a workspace is, which device this is, and which devices it is paired
// with: all kept on the device, never in the files people commit, as git keeps
// its remotes (see docs/decisions/0028-peers.md).
//
// - The workspace's id and secret, and this device's name: git config (`kuraa.*`).
// - This device's key pair: .git/kuraa/device.json, readable only by its owner.
// - The devices in the workspace (0072): those that sign with a key a person
//   vouched for, whose person the policy has in it, the key neither dropped nor
//   revoked. Each is a git remote whose URL is `kuraa://<device key>`, so
//   `git fetch laptop` works and their branches are `laptop/main`; the remotes
//   follow the records (syncRemotes).
// - Devices removed before (0072: no longer made): `kuraa.removed`, never accepted again.
// - Invite links this device made: .git/kuraa/links.json; revoked or used ones,
//   `kuraa.revokedlinks` (shared with the other devices, as removals are). The
//   link this device joined by: .git/kuraa/joined-link.
// - Every record, signed by the device that made it: .git/kuraa/records.json
//   (records.ts). The config above is what the records this device took say, applied.
// - A workspace from before policies: the legacy geneses this device holds as its
//   own, and the seal it keeps to (policy.ts): .git/kuraa/legacy.json.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import type { Git } from '../git.js';
import { serialQueue } from '../serial.js';
import { reservedName } from '../files.js';
import { aboutItself, byPerson, judge, policyEntry, readRecord, sign, signRecord, signsMessage, vouchMessage, type MemberRecord, type RecordKind, type Standing } from './records.js';
import type { Attestation } from './attest.js';
import { admittedGrantMessage, evaluate, grantMessage, isGroupName, linkGrantMessage, makeOp, WORKSPACE, type Policy, type PolicyOp, type Role } from './policy.js';
import { eventHash, resolve, revocationCounts, vouchCounts, type IdentityState, type KeyEvent } from './kel.js';
import type { Person } from './person.js';
import { keptKey, type KeyPair } from '../keys.js';

export interface Member {
  /** The remote's name: `laptop`. */
  name: string;
  /** The device's public key, hex. */
  key: string;
}

export interface WorkspaceIdentity {
  /** The workspace's id, hex: names it to people and peers; not a secret. */
  id: string;
  /** The workspace's secret, hex: devices find each other by it. */
  secret: string;
  /** The workspace this one was forked from (`<id>@<commit>`), if any. */
  forkedFrom: string | null;
}

export const KURAA_SCHEME = 'kuraa://';

/** At most this many records prove a device to be in (Identity.proof). */
export const MAX_PROOF = 200;

/** The ID of the identity whose log this is (its inception's hash). */
const person0 = (events: KeyEvent[]) => resolve(events)!.id;

const hex = /^[0-9a-f]+$/;

/** How long a workspace's topic lasts before the next (topicsFor). */
export const TOPIC_WEEK = 7 * 24 * 3600_000;

/**
 * The swarm topics for a workspace: derived from its secret, so only devices
 * that know it find each other, and from the week, so the DHT nodes that keep
 * who announces a topic cannot tell from it that the same workspace is still
 * there weeks later. This week's and last week's: two devices whose clocks are
 * apart by less than a week always share one.
 */
export function topicsFor(secret: string, now = Date.now()): Buffer[] {
  const week = Math.floor(now / TOPIC_WEEK);
  return [week, week - 1].map((w) => createHash('sha256').update(`kuraa workspace topic\0${secret}\0${w}`).digest());
}

/** The key a device's announcements on the local network are made with (lan.ts): from the secret, so only devices that know it can tell them. */
export function lanKeyFor(secret: string): Buffer {
  return createHash('sha256').update(`kuraa local network\0${secret}`).digest();
}

/** A name a git remote can have: letters, digits, dots, dashes; not empty. */
export function remoteName(name: string): string {
  const clean = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  // Remotes are folders under .git/refs/remotes: none Windows could not make (con, nul, …).
  return !clean ? 'device' : reservedName(clean) ? `${clean}-device` : clean;
}

/** A workspace from before policies (policy.ts): the legacy geneses a device holds as its own, and the seal it keeps to. */
interface LegacyState { geneses: string[]; seal: string | null }

/** The legacy geneses among records. */
const legacyGeneses = (list: MemberRecord[]) => list.filter((r) => r.kind === 'policy' && r.op?.t === 'genesis' && r.op.legacy).map((r) => r.subject);

export class Identity {
  /** Changes to the members, one at a time (a device may be paired by two routes at once). */
  private readonly serial = serialQueue();

  constructor(private readonly git: Git, private readonly stateDir: string) {}

  private async get(key: string): Promise<string | null> {
    return (await this.config()).get(key.toLowerCase())?.at(-1) ?? null;
  }

  private async getAll(key: string): Promise<string[]> {
    return [...((await this.config()).get(key.toLowerCase()) ?? [])];
  }

  /**
   * The repository's own git config (`kuraa.*`, its remotes), read again only
   * when the file has changed (0072): asked for at every turn, as records are,
   * and each read a git process.
   */
  private async config(): Promise<Map<string, string[]>> {
    const file = join(this.stateDir, '..', 'config');
    const stamp = await this.stamp(file);
    if (stamp && this.configCache?.stamp === stamp) return this.configCache.values;
    const r = await this.git.run(['config', '--local', '--list', '-z'], { allowFail: true });
    const values = new Map<string, string[]>();
    for (const entry of r.code === 0 ? r.stdout.split('\0') : []) {
      if (!entry) continue;
      const at = entry.indexOf('\n');
      const key = (at < 0 ? entry : entry.slice(0, at)).toLowerCase();
      const value = at < 0 ? '' : entry.slice(at + 1).trim();
      values.set(key, [...(values.get(key) ?? []), value]);
    }
    this.configCache = stamp ? { stamp, values } : null;
    return values;
  }

  private configCache: { stamp: string; values: Map<string, string[]> } | null = null;

  /** A git command that writes the config (a setting, a remote): what is cached of it is read again after. */
  private async write(args: string[], o?: { allowFail?: boolean }): Promise<unknown> {
    try {
      return await this.git.run(args, o);
    } finally {
      this.configCache = null;
    }
  }

  /** The workspace's identity, or null if this repository is not yet a peer workspace. */
  async workspace(): Promise<WorkspaceIdentity | null> {
    const id = await this.get('kuraa.workspace');
    const secret = await this.get('kuraa.secret');
    if (!id || !secret) return null;
    return { id, secret, forkedFrom: await this.get('kuraa.forkedfrom') };
  }

  /** Make this repository a workspace of its own (the first device): a new id and secret. */
  async found(): Promise<WorkspaceIdentity> {
    const ws = { id: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), forkedFrom: null };
    await this.adopt(ws);
    return ws;
  }

  /**
   * Make this copy a workspace of its own, forked from the one it was: a new id
   * and secret, the original's id and the commit it was forked at kept, and its
   * devices kept as remotes to fetch from (never merged from on their own).
   */
  async fork(commit: string): Promise<WorkspaceIdentity> {
    const old = await this.workspace();
    if (!old) throw new Error('This repository is not a workspace shared between devices, so there is nothing to fork from');
    const ws = { id: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), forkedFrom: `${old.id}@${commit}` };
    await this.adopt(ws);
    await this.write(['config', 'kuraa.originsecret', old.secret]);
    return ws;
  }

  /** The secret of the workspace this one was forked from, to meet its devices. */
  async originSecret(): Promise<string | null> {
    return this.get('kuraa.originsecret');
  }

  /** Take on a workspace's identity (a device joining it). */
  async adopt(ws: WorkspaceIdentity): Promise<void> {
    if (!hex.test(ws.id) || !hex.test(ws.secret)) throw new Error('Not a workspace identity');
    await this.write(['config', 'kuraa.workspace', ws.id]);
    await this.write(['config', 'kuraa.secret', ws.secret]);
    if (ws.forkedFrom) await this.write(['config', 'kuraa.forkedfrom', ws.forkedFrom]);
    else await this.write(['config', '--unset', 'kuraa.forkedfrom'], { allowFail: true });
  }

  /**
   * What this device is called to its peers: the name it was given, or else
   * KURAA_DEVICE_NAME (pnpm dev sets it, so a development copy on the same
   * computer as the app is told apart), or else the computer's name.
   */
  async deviceName(): Promise<string> {
    return (await this.get('kuraa.devicename')) ?? remoteName(process.env.KURAA_DEVICE_NAME || hostname().replace(/\.local$/, ''));
  }

  async setDeviceName(name: string): Promise<void> {
    await this.write(['config', 'kuraa.devicename', remoteName(name)]);
  }

  /** This device's key pair, made the first time it is asked for (keys.ts). */
  deviceKey(): Promise<KeyPair> {
    return keptKey(join(this.stateDir, 'device.json'));
  }

  /** The devices in the workspace, this one aside (0072): as the records say, each by its remote's name. */
  async members(): Promise<Member[]> {
    const { in: inside } = await this.devices();
    return (await this.remotes()).filter((m) => inside.has(m.key));
  }

  /**
   * The devices this one syncs or fetches with: those in the workspace, and, for
   * a fork, those of the workspace it came from (0072: as the records of that
   * one here say), each by its remote's name.
   */
  async devicesToMeet(): Promise<Member[]> {
    const members = await this.members();
    const ws = await this.workspace();
    const origin = ws?.forkedFrom?.split('@')[0];
    if (!origin) return members;
    const theirs = await this.devicesOf(origin);
    return [...members, ...(await this.remotes()).filter((r) => theirs.has(r.key) && !members.some((m) => m.key === r.key))];
  }

  /** The kuraa:// remotes: the devices git fetches from. */
  async remotes(): Promise<Member[]> {
    const out: Member[] = [];
    for (const [k, values] of await this.config()) {
      const m = /^remote\.(.+)\.url$/.exec(k);
      const url = values.at(-1) ?? '';
      if (m && url.startsWith(KURAA_SCHEME)) {
        const key = url.slice(KURAA_SCHEME.length).replace(/\/$/, '');
        if (hex.test(key) && key.length === 64) out.push({ name: m[1]!, key });
      }
    }
    return out;
  }

  /**
   * A remote for a device to fetch from (under a free name), unless it is out;
   * its name. Says nothing of whether it is in: a device joining fetches from the
   * device that lets it in before it holds the records that say so.
   */
  addRemote(key: string, name: string): Promise<string | null> {
    return this.serial(() => this.addRemoteNow(key, name));
  }

  private async addRemoteNow(key: string, name: string): Promise<string | null> {
    if (!hex.test(key) || key.length !== 64) throw new Error('Not a device key');
    if ((await this.removed()).includes(key)) return null;
    const remotes = await this.remotes();
    const known = remotes.find((m) => m.key === key);
    if (known) return known.name;
    const names = (await this.git.out(['remote'])).split('\n').filter(Boolean);
    const base = remoteName(name);
    let pick = base;
    for (let i = 2; names.includes(pick); i++) pick = `${base}-${i}`;
    await this.write(['remote', 'add', pick, `${KURAA_SCHEME}${key}`]);
    return pick;
  }

  /** A removal from before (0072: none made now), applied: never accepted again. */
  private async removeMemberNow(key: string): Promise<void> {
    // Recorded as removed before it is forgotten: stopped in between, the device is still never
    // accepted again, and whoever sees its remote gone can rely on the record being there.
    if (!(await this.getAll('kuraa.removed')).includes(key)) await this.write(['config', '--add', 'kuraa.removed', key]);
    const m = (await this.remotes()).find((x) => x.key === key);
    if (m) await this.write(['remote', 'remove', m.name]);
  }

  /**
   * Which devices are in the workspace, and which out, as records (`list`, or
   * those this device holds) say (0072). In: signs with a key a person vouched
   * for, whose person the policy has in the workspace (where there is no policy
   * yet: any person), the key neither dropped nor revoked. Out: its key dropped
   * or revoked, or its person taken out (or left); or removed before. A device
   * whose person is not known yet, or not in yet, is neither.
   */
  async devices(list?: MemberRecord[]): Promise<{ in: Map<string, { person: string; name: string }>; out: Set<string> }> {
    const records = list ?? (await this.records());
    const ws = await this.workspace();
    const before = await this.getAll('kuraa.removed');
    // Worked out once for the same records: asked for at every hello.
    const key = createHash('sha256').update(`${ws?.id ?? ''}\0${(await this.pin()) ?? ''}\0${JSON.stringify(await this.legacy())}\0${before.join(',')}\0`).update(records.map((r) => r.sig).join('\n')).digest('hex');
    if (this.devicesMemo?.key === key) return this.devicesMemo.value;
    const value = this.devicesBy(records, await this.policy(records), ws?.id ?? '', new Set(before));
    this.devicesMemo = { key, value };
    return value;
  }

  private devicesMemo: { key: string; value: { in: Map<string, { person: string; name: string }>; out: Set<string> } } | null = null;

  private devicesBy(records: MemberRecord[], policy: Policy, workspace: string, removedBefore: Set<string>): { in: Map<string, { person: string; name: string }>; out: Set<string> } {
    const w = this.who(records.filter((r) => r.workspace === workspace));
    const inside = new Map<string, { person: string; name: string }>();
    const out = new Set(removedBefore);
    for (const [device, key] of w.signsWith) {
      if (out.has(device)) continue;
      if (w.cut.has(key) || policy.dropped.has(key)) {
        out.add(device);
        continue;
      }
      const p = w.personOf.get(key);
      if (!p) continue;
      if (!policy.founded || policy.role(p.key)) inside.set(device, { person: p.key, name: w.names.get(device) ?? '' });
      else if (policy.cutoffs.has(p.key)) out.add(device);
    }
    return { in: inside, out };
  }

  /**
   * The devices records sent by another device say are in a workspace (0072): for
   * a device joining, which holds none yet, to tell whether the device letting
   * it in is one, under the genesis its link names.
   */
  async devicesIn(list: unknown[], workspace: string, issuer?: string): Promise<Set<string>> {
    const records = list.map(readRecord).filter((r): r is MemberRecord => !!r && r.workspace === workspace);
    // A workspace from before: the legacy geneses its link's maker's person signed are where the joining device
    // starts from (with those their admins signed); where it signed none, all of them, as before.
    const w = this.who(records);
    const by = issuer ? w.personOf.get(w.signsWith.get(issuer) ?? '')?.key : undefined;
    const legacy = records.filter((r) => r.kind === 'policy' && r.op?.t === 'genesis' && r.op.legacy && !!by && w.personOf.get(r.signer!)?.key === by).map((r) => r.subject);
    const policy = await this.evaluatePolicy(records, workspace, await this.pin(), legacy.length ? { geneses: legacy, seal: null } : null);
    if (!policy.founded) return new Set();
    return new Set(this.devicesBy(records, policy, workspace, new Set()).in.keys());
  }

  /**
   * The records about one device (0072): the key it signs with, that key
   * vouched for, its person's key events and attestations, and the policy
   * operations that key signed. What a device not known to be in shows, and all
   * that is taken of it.
   */
  private about(device: string, list: MemberRecord[]): MemberRecord[] {
    const signs = this.latest('signs', device, list);
    if (!signs) return [];
    const key = signs.subject;
    const vouches = list.filter((r) => r.kind === 'vouch' && r.subject === key);
    const persons = new Set(vouches.map((r) => r.person));
    const events = list.filter((r) => r.kind === 'key-event' && persons.has(r.subject));
    const attestations = list.filter((r) => r.kind === 'attest' && persons.has(r.subject));
    const ops = list.filter((r) => r.kind === 'policy' && r.signer === key);
    return [signs, ...vouches, ...events, ...attestations, ...ops];
  }

  /** The records that show this device to be in (0072), for a device that may not know yet. */
  async proof(): Promise<MemberRecord[]> {
    return this.about((await this.deviceKey()).publicKey.toString('hex'), await this.records()).slice(0, MAX_PROOF);
  }

  /**
   * Of the records a device not known to be in sends to show it is (its hello's
   * proof), those to keep: only those about it (about), and only if with them it
   * is in; of its policy operations, only those that count. None (empty) if it
   * is not in with them: nothing of a stranger's is kept, or passed on.
   */
  async proven(device: string, list: unknown[]): Promise<MemberRecord[]> {
    const ws = await this.workspace();
    if (!ws) return [];
    const have = await this.records();
    const known = new Set(have.map((r) => r.sig));
    const sent = list.slice(0, MAX_PROOF).map(readRecord).filter((r): r is MemberRecord => !!r && r.workspace === ws.id && !known.has(r.sig));
    const mine = this.about(device, [...have, ...sent]).filter((r) => !known.has(r.sig));
    if (!mine.length) return [];
    const all = [...have, ...mine];
    const policy = await this.evaluatePolicy(all, ws.id, await this.pin(), await this.legacy());
    if (!this.devicesBy(all, policy, ws.id, new Set(await this.getAll('kuraa.removed'))).in.has(device)) return [];
    const counted = new Set(policy.applied);
    return mine.filter((r) => r.kind !== 'policy' || counted.has(r.subject));
  }

  /**
   * The devices in another workspace, as the records this device holds of it
   * say (0072): for a fork, those of the workspace it was forked from, which it
   * may fetch from.
   */
  async devicesOf(workspace: string): Promise<Set<string>> {
    const records = (await this.records()).filter((r) => r.workspace === workspace);
    const policy = await this.evaluatePolicy(records, workspace, await this.pin(), null);
    return new Set(this.devicesBy(records, policy, workspace, new Set(await this.getAll('kuraa.removed'))).in.keys());
  }

  /** Make the remotes what the records say (0072): one for each device in, none for a device out. */
  private async syncRemotesNow(): Promise<void> {
    if (!(await this.workspace())) return;
    const self = (await this.deviceKey()).publicKey.toString('hex');
    const { in: inside, out } = await this.devices();
    const remotes = await this.remotes();
    for (const r of remotes) if (out.has(r.key)) await this.write(['remote', 'remove', r.name]);
    const have = new Set(remotes.map((r) => r.key));
    for (const [key, d] of inside) if (key !== self && !have.has(key)) await this.addRemoteNow(key, d.name || 'device');
  }

  /** The remotes made what the records say; if they cannot be now (git config held by another writer), before the next change (reconcile). */
  private async syncRemotesOrLater(): Promise<void> {
    try {
      await this.syncRemotesNow();
    } catch {
      this.unapplied = true;
    }
  }

  /** Devices out of the workspace (0072): never accepted, never sent the secret. */
  async removed(): Promise<string[]> {
    return [...(await this.devices()).out];
  }

  // Signed records (records.ts) --------------------------------------------

  private get recordsFile(): string {
    return join(this.stateDir, 'records.json');
  }

  private recordsCache: { stamp: string; value: MemberRecord[] } | null = null;

  private async stamp(file: string): Promise<string> {
    try {
      const st = await stat(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  }

  /** A cached value, if the file it was read from has not changed since (another process may change it: the CLI). */
  private async fresh<T>(file: string, cache: { stamp: string; value: T } | null): Promise<{ value: T } | null> {
    return cache && cache.stamp && cache.stamp === (await this.stamp(file)) ? cache : null;
  }

  /** Records kept while others are being taken (batch): written once, after, not the whole file again for each. */
  private pending: { list: MemberRecord[]; changed: boolean } | null = null;

  /** Keep the records `fn` keeps, and write them down once, after it. */
  private async batch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending) return fn();
    this.pending = { list: await this.records(), changed: false };
    try {
      return await fn();
    } finally {
      const { list, changed } = this.pending;
      this.pending = null;
      if (changed) await this.writeRecords(list);
    }
  }

  private async writeRecords(list: MemberRecord[]): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    // Readable only by this computer's user: they hold the workspace's secret (records.ts, secret).
    await writeFile(this.recordsFile, JSON.stringify(list, null, 1), { mode: 0o600 });
    // As written: not read again (each record's signatures checked) until another process changes the file.
    const stamp = await this.stamp(this.recordsFile);
    this.recordsCache = stamp ? { stamp, value: list } : null;
  }

  /** The records this device has made or accepted. */
  async records(): Promise<MemberRecord[]> {
    if (this.pending) return [...this.pending.list];
    const cached = await this.fresh(this.recordsFile, this.recordsCache);
    if (cached) return [...cached.value];
    try {
      const stamp = await this.stamp(this.recordsFile);
      const list = (JSON.parse(await readFile(this.recordsFile, 'utf8')) as unknown[]).map(readRecord).filter((r): r is MemberRecord => !!r);
      this.recordsCache = { stamp, value: list };
      return [...list];
    } catch {
      return [];
    }
  }

  /** The latest record of a kind a device made about itself (signs). */
  private latest(kind: RecordKind, by: string, list: MemberRecord[]): MemberRecord | undefined {
    let best: MemberRecord | undefined;
    for (const r of list) if (r.kind === kind && r.by === by && (!best || r.at > best.at || (r.at === best.at && r.sig > best.sig))) best = r;
    return best;
  }

  /** Keep a record; false if it is not kept (had already, or one that says the same is newer). */
  private async keepRecord(r: MemberRecord): Promise<boolean> {
    let list = await this.records();
    if (list.some((x) => x.sig === r.sig)) return false;
    if (aboutItself(r.kind)) {
      // Only the latest of what a device says about itself is kept.
      const now = this.latest(r.kind, r.by, list);
      if (now && (now.at > r.at || (now.at === r.at && now.sig > r.sig))) return false;
      list = list.filter((x) => !(x.kind === r.kind && x.by === r.by));
    }
    // An event of a person's identity, or a policy operation, once, whoever passed it on.
    if (r.kind === 'key-event' && list.some((x) => x.kind === r.kind && x.event && eventHash(x.event) === eventHash(r.event!))) return false;
    if (r.kind === 'policy' && list.some((x) => x.kind === r.kind && x.subject === r.subject)) return false;
    if (r.kind === 'attest' && list.some((x) => x.kind === r.kind && x.attestation?.sig === r.attestation?.sig)) return false;
    // What a person says about a key, once, whoever passed it on (a vouch: the latest): once for
    // each of their identity's keys, so what a key no longer theirs signs never pushes out what theirs did.
    if (byPerson(r.kind)) {
      const same = list.filter((x) => x.kind === r.kind && x.person === r.person && x.subject === r.subject && x.personKey === r.personKey);
      // A revocation, once from each of the person's devices (0071): each says the commits it had, and every
      // device keeps them all (cutKeys takes them together), so all judge the key's commits alike.
      if (r.kind === 'revoke-key') {
        if (same.some((x) => x.by === r.by)) return false;
      } else {
        if (same.some((x) => x.at > r.at || (x.at === r.at && x.sig > r.sig))) return false;
        list = list.filter((x) => !same.includes(x));
      }
    }
    list = [...list, r];
    if (this.pending) this.pending = { list, changed: true };
    else await this.writeRecords(list);
    return true;
  }

  /** Each identity's log, as the events on record show it (kel.ts), by ID: worked out once for the same records. */
  private identities(list: MemberRecord[]): Map<string, IdentityState> {
    const key = list.map((r) => r.sig).join();
    if (this.identitiesMemo?.key === key) return this.identitiesMemo.value;
    const value = this.identitiesOf(list);
    this.identitiesMemo = { key, value };
    return value;
  }

  private identitiesMemo: { key: string; value: Map<string, IdentityState> } | null = null;

  private identitiesOf(list: MemberRecord[]): Map<string, IdentityState> {
    const events = list.filter((r) => r.kind === 'key-event').map((r) => r.event!);
    const ids = new Set(list.filter((r) => r.kind === 'key-event').map((r) => r.subject));
    // First each log by its own keys; then again, a trustee rotation judged by its trustees' keys as those say (step 6).
    const plain = new Map<string, IdentityState>();
    for (const id of ids) {
      const state = resolve(events, id);
      if (state) plain.set(id, state);
    }
    const trusteeKey = (id: string) => {
      const t = plain.get(id);
      return t && !t.disputed ? t.current : null;
    };
    const out = new Map<string, IdentityState>();
    for (const id of ids) {
      const state = resolve(events, id, { trusteeKey });
      if (state) out.set(id, state);
    }
    return out;
  }

  /** An identity's log as this workspace knows it; null if it knows none. */
  async identityState(id: string): Promise<IdentityState | null> {
    return this.identities(await this.records()).get(id) ?? null;
  }

  /**
   * Who is who, from the records (0035, 0066): the signing key each device signs
   * with, and the person whose each signing key is: the one identity that
   * vouched for it (with a key that counts for it, by its log), with the key's
   * own signature too. A key more than one identity vouched for (only whoever
   * holds it could make that so) is no one's, as is one its person revoked.
   */
  private who(list: MemberRecord[]): ReturnType<Identity['whoOf']> {
    // Worked out once for the same records (0072): asked for at every turn, and each identity's log is checked by its signatures.
    const key = list.map((r) => r.sig).join();
    if (this.whoMemo?.key === key) return this.whoMemo.value;
    const value = this.whoOf(list);
    this.whoMemo = { key, value };
    return value;
  }

  private whoMemo: { key: string; value: ReturnType<Identity['whoOf']> } | null = null;

  private whoOf(list: MemberRecord[]): {
    signsWith: Map<string, string>;
    /** Each device's name, as it said with the key it signs with. */
    names: Map<string, string>;
    personOf: Map<string, { key: string; name: string }>;
    /** Keys once a person's that no longer are (revoked, or left behind when their identity was recovered): whose, for their past word (0072). */
    formerly: Map<string, { key: string; name: string }>;
    /** Keys revoked or left behind, and the policy operations their revokers had (null: none said, a revocation from before or none yet). */
    cut: Map<string, string[] | null>;
  } {
    const signsWith = new Map<string, string>();
    const names = new Map<string, string>();
    for (const by of new Set(list.filter((r) => r.kind === 'signs').map((r) => r.by))) {
      const latest = this.latest('signs', by, list)!;
      signsWith.set(by, latest.subject);
      if (latest.name) names.set(by, latest.name);
    }
    const ids = this.identities(list);
    const counts = (r: MemberRecord, test: typeof vouchCounts) => {
      const state = ids.get(r.person!);
      return !!state && test(state, r.personKey!, r.subject);
    };
    const revocations = list.filter((r) => r.kind === 'revoke-key' && counts(r, revocationCounts));
    const revoked = new Set(revocations.map((r) => `${r.person}\0${r.subject}`));
    // Vouched for by a key that was ever the identity's: the person's once, if not now.
    const ever = (r: MemberRecord) => {
      const state = ids.get(r.person!);
      return !!state && !state.disputed && state.events.some((e) => e.key === r.personKey);
    };
    const vouches = new Map<string, MemberRecord[]>();
    const once = new Map<string, MemberRecord[]>();
    for (const r of list) {
      if (r.kind !== 'vouch') continue;
      if (counts(r, vouchCounts)) vouches.set(r.subject, [...(vouches.get(r.subject) ?? []), r]);
      if (ever(r)) once.set(r.subject, [...(once.get(r.subject) ?? []), r]);
    }
    // Their latest name: said with the identity's latest key, then the latest said.
    const latestOf = (vs: MemberRecord[]) => {
      const place = (v: MemberRecord) => ids.get(v.person!)!.events.findIndex((e) => e.key === v.personKey);
      return vs.reduce((a, b) => (place(b) > place(a) || (place(b) === place(a) && (b.at > a.at || (b.at === a.at && b.sig > a.sig))) ? b : a));
    };
    const personOf = new Map<string, { key: string; name: string }>();
    for (const [key, vs] of vouches) {
      if (new Set(vs.map((v) => v.person)).size !== 1) continue;
      const v = latestOf(vs);
      if (!revoked.has(`${v.person}\0${key}`)) personOf.set(key, { key: v.person!, name: v.name ?? '' });
    }
    const formerly = new Map<string, { key: string; name: string }>();
    const cut = new Map<string, string[] | null>();
    for (const [key, vs] of once) {
      if (personOf.has(key) || new Set(vs.map((v) => v.person)).size !== 1) continue;
      const v = latestOf(vs);
      formerly.set(key, { key: v.person!, name: v.name ?? '' });
      // What its revokers had seen of the policy, together; none said: null.
      let heads: string[] | null = null;
      for (const r of revocations) if (r.subject === key && r.person === v.person && r.policyHeads) heads = [...new Set([...(heads ?? []), ...r.policyHeads])].sort();
      cut.set(key, heads);
    }
    return { signsWith, names, personOf, formerly, cut };
  }

  /** The signing key a device's commits are signed with, as it says (with that key's signature); null if it has not said. */
  async signingKeyOf(device: string): Promise<string | null> {
    return this.who(await this.records()).signsWith.get(device) ?? null;
  }

  /** The person a device (or a signing key) is, as their identity vouched for its signing key; null if none (or revoked). */
  async personOf(deviceOrKey: string): Promise<{ key: string; name: string } | null> {
    const w = this.who(await this.records());
    return w.personOf.get(w.signsWith.get(deviceOrKey) ?? deviceOrKey) ?? null;
  }

  /** The people whose identities vouched for signing keys in this workspace: their keys, and the devices that sign with them. */
  async people(): Promise<{ key: string; name: string; keys: string[]; devices: string[] }[]> {
    const w = this.who(await this.records());
    const out = new Map<string, { key: string; name: string; keys: string[]; devices: string[] }>();
    for (const [key, p] of w.personOf) {
      const e = out.get(p.key) ?? { key: p.key, name: p.name, keys: [], devices: [] };
      e.keys.push(key);
      out.set(p.key, e);
    }
    for (const [device, key] of w.signsWith) {
      const p = w.personOf.get(key);
      if (p) out.get(p.key)!.devices.push(device);
    }
    return [...out.values()];
  }

  /** Say, in this workspace, that this device's commits are signed with this key (with its signature). */
  async signsWith(key: KeyPair): Promise<void> {
    if (!(await this.workspace())) return;
    const self = (await this.deviceKey()).publicKey.toString('hex');
    const hex = key.publicKey.toString('hex');
    const name = await this.deviceName();
    const latest = this.latest('signs', self, await this.records());
    if (latest?.subject === hex && latest.name === name) return;
    // With this device's name (0072): what the others call it.
    await this.decide('signs', hex, { proof: sign(signsMessage(self), key), name });
  }

  /** Put an identity's events on record in this workspace (those not yet), so every device can follow its keys. */
  async publishIdentity(events: KeyEvent[]): Promise<void> {
    if (!(await this.workspace())) return;
    const have = new Set((await this.records()).filter((r) => r.kind === 'key-event').map((r) => eventHash(r.event!)));
    for (const e of events) {
      if (have.has(eventHash(e))) continue;
      await this.decide('key-event', e.t === 'icp' ? person0(events) : e.id, { event: e });
    }
  }

  /** Say, in this workspace, that a signing key is a person's: with their identity's signature (its key now) and the key's own; its log first. */
  async vouch(person: Person, key: KeyPair): Promise<void> {
    if (!(await this.workspace())) return;
    await this.publishIdentity(person.events);
    const pk = person.publicKey.toString('hex');
    const k = key.publicKey.toString('hex');
    if ((await this.records()).some((r) => r.kind === 'vouch' && r.person === person.id && r.personKey === pk && r.subject === k && r.name === person.name)) return;
    const m = vouchMessage(k, person.id, person.name);
    await this.decide('vouch', k, { person: person.id, personKey: pk, name: person.name, proof: sign(m, person), keyProof: sign(m, key) });
  }

  /**
   * Pass on a person's revocation of one of their signing keys (signed by
   * `personKey`, one of their identity's keys), in this workspace, with the
   * commits this device has (`heads`): what the key signed among them still
   * counts, and nothing else it signs (its cutoff, 0066).
   */
  async revokeKey(person: string, personKey: string, key: string, proof: string, heads: string[] = []): Promise<void> {
    if (!(await this.workspace())) return;
    if ((await this.records()).some((r) => r.kind === 'revoke-key' && r.person === person && r.subject === key && r.personKey === personKey)) return;
    // With the policy as this device has it: what the key signed of it still counts, and nothing after (0072).
    await this.decide('revoke-key', key, { person, personKey, proof, heads: [...new Set(heads)].sort(), policyHeads: (await this.policy()).heads });
  }

  /**
   * Signing keys whose word no longer counts here (revoked by their person, or
   * no longer theirs since their identity was recovered), with whose they were
   * and the commits that still count as theirs (every cutoff said of them,
   * together); for judging commits (gate.ts).
   */
  async cutKeys(): Promise<Map<string, { person: string; heads: string[] }>> {
    const list = await this.records();
    const ids = this.identities(list);
    const w = this.who(list);
    const now = w.personOf;
    const out = new Map<string, { person: string; heads: string[] }>();
    // Dropped here (0072): its cutoff the commits the dropper had.
    for (const [key, heads] of (await this.policy(list)).dropped) {
      const p = now.get(key) ?? w.formerly.get(key);
      if (p) out.set(key, { person: p.key, heads: [...heads].sort() });
    }
    for (const r of list) {
      if (r.kind !== 'revoke-key') continue;
      const state = ids.get(r.person!);
      if (!state || !revocationCounts(state, r.personKey!, r.subject) || now.has(r.subject)) continue;
      const had = out.get(r.subject);
      out.set(r.subject, { person: r.person!, heads: [...new Set([...(had?.heads ?? []), ...(r.heads ?? [])])].sort() });
    }
    return out;
  }

  /** Signing keys an identity vouched for here whose vouches no longer count (dropped when it was recovered): to revoke, with a cutoff. */
  async droppedKeys(person: string): Promise<string[]> {
    const list = await this.records();
    const counting = this.who(list).personOf;
    const revoked = new Set(list.filter((r) => r.kind === 'revoke-key' && r.person === person).map((r) => r.subject));
    return [...new Set(list.filter((r) => r.kind === 'vouch' && r.person === person && !counting.has(r.subject) && !revoked.has(r.subject)).map((r) => r.subject))];
  }

  // The policy (policy.ts, 0066) -----------------------------------------------

  /** The genesis this workspace is pinned to (made since policies, or joined by a link that names it); null: one from before. */
  async pin(): Promise<string | null> {
    return this.get('kuraa.genesis');
  }

  async setPin(genesis: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(genesis)) throw new Error('Not a genesis');
    await this.write(['config', 'kuraa.genesis', genesis]);
  }

  private get legacyFile(): string {
    return join(this.stateDir, 'legacy.json');
  }

  private legacyCache: { stamp: string; value: LegacyState } | null = null;

  /**
   * A workspace from before (no pin): the legacy geneses this device holds as
   * its own, and the seal it keeps to (policy.ts, docs/policy.md). The first
   * time it is asked, those it holds then (its own, and those its devices had
   * passed on to each other, before any stranger could bring one). Null for a
   * workspace pinned to its genesis.
   */
  private async legacy(): Promise<LegacyState | null> {
    if (await this.pin()) return null;
    const ws = await this.workspace();
    if (!ws) return null;
    const stamp = await this.stamp(this.legacyFile);
    if (stamp && this.legacyCache?.stamp === stamp) return this.legacyCache.value;
    try {
      const v = JSON.parse(await readFile(this.legacyFile, 'utf8')) as { geneses?: unknown; seal?: unknown };
      const hex = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
      const value: LegacyState = { geneses: Array.isArray(v.geneses) ? v.geneses.filter(hex) : [], seal: hex(v.seal) ? v.seal : null };
      this.legacyCache = { stamp, value };
      return value;
    } catch {
      const records = this.pending?.list ?? (await this.records());
      return this.writeLegacy({ geneses: legacyGeneses(records.filter((r) => r.workspace === ws.id)), seal: null });
    }
  }

  private async writeLegacy(value: LegacyState): Promise<LegacyState> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.legacyFile, JSON.stringify(value), { mode: 0o600 });
    this.legacyCache = { stamp: await this.stamp(this.legacyFile), value };
    return value;
  }

  /**
   * A workspace from before, once records came or were made: a device welcomed
   * holding no legacy genesis of its own takes those it was welcomed with as its
   * own; a legacy genesis this device made is its own; and once a seal counts, the
   * device keeps to it (no seal made after, by anyone, counts here).
   */
  private async settleLegacy(o: { welcomed?: MemberRecord[]; made?: string } = {}): Promise<void> {
    let state = await this.legacy();
    if (!state) return;
    const before = JSON.stringify(state);
    if (!state.geneses.length && o.welcomed?.length) state = { ...state, geneses: legacyGeneses(o.welcomed) };
    if (o.made && !state.geneses.includes(o.made)) state = { ...state, geneses: [...state.geneses, o.made] };
    if (JSON.stringify(state) !== before) await this.writeLegacy(state);
    if (!state.seal) {
      const sealed = (await this.policy()).sealId;
      if (sealed) await this.writeLegacy({ ...state, seal: sealed });
    }
  }

  /** The workspace's policy, as the operations on record make it. */
  async policy(list?: MemberRecord[]): Promise<Policy> {
    const records = list ?? (await this.records());
    const ws = await this.workspace();
    const pin = await this.pin();
    const legacy = await this.legacy();
    // Worked out once for the same records (0071): it is asked for often, and costs more the more there are.
    // Nothing in it depends on this computer's clock (attestations expire by their verifier's: claims).
    const key = createHash('sha256').update(`${ws?.id ?? ''}\0${pin ?? ''}\0${JSON.stringify(legacy)}\0`).update(records.map((r) => r.sig).join('\n')).digest('hex');
    if (this.policyMemo?.key === key) return this.policyMemo.policy;
    const policy = this.evaluatePolicy(records, ws?.id ?? '', pin, legacy);
    this.policyMemo = { key, policy };
    policy.catch(() => {
      if (this.policyMemo?.policy === policy) this.policyMemo = null;
    });
    return policy;
  }

  private policyMemo: { key: string; policy: Promise<Policy> } | null = null;

  private async evaluatePolicy(records: MemberRecord[], workspace: string, pin: string | null, legacy: LegacyState | null): Promise<Policy> {
    const w = this.who(records);
    const entries = records.filter((r) => r.kind === 'policy' && r.workspace === workspace).map(policyEntry);
    // A key its person revoked (or left behind recovering) is still theirs for what it signed before (0072).
    const ctx = {
      workspace,
      pin,
      ...(legacy ? { legacy: legacy.geneses, seal: legacy.seal } : {}),
      personOf: (key: string) => (w.personOf.get(key) ?? w.formerly.get(key))?.key ?? null,
      cutKey: (key: string) => (w.personOf.has(key) ? undefined : w.cut.get(key)),
    };
    const base = evaluate(entries, ctx);
    if (!base.verifiers.size) return base;
    // Then again, with the emails attested by the verifiers it counts (step 6).
    const claims = this.claims(records, base.verifiers);
    return evaluate(entries, { ...ctx, claimsOf: (id) => [...(claims.get(id) ?? [])], claimed: new Set([...claims.values()].flatMap((c) => [...c])) });
  }

  /**
   * The emails attested of each person, by the verifiers given, unexpired. Not
   * by this computer's clock, which devices would read differently, but by the
   * verifier's: an attestation has expired once one the same verifier made
   * after it ran out is on record. Every device holding the same records
   * counts the same ones.
   */
  private claims(records: MemberRecord[], verifiers: Map<string, string>): Map<string, Set<string>> {
    const latest = new Map<string, number>();
    for (const r of records) if (r.kind === 'attest' && r.attestation) latest.set(r.attestation.verifier, Math.max(latest.get(r.attestation.verifier) ?? 0, r.attestation.at));
    const out = new Map<string, Set<string>>();
    for (const r of records) {
      const a = r.attestation;
      if (r.kind !== 'attest' || !a || !verifiers.has(a.verifier) || a.expires <= latest.get(a.verifier)!) continue;
      out.set(a.id, (out.get(a.id) ?? new Set()).add(a.claim.slice(6)));
    }
    return out;
  }

  /** The emails attested of a person that count in this workspace (by its verifiers). */
  async emailsOf(id: string): Promise<string[]> {
    const records = await this.records();
    const policy = await this.policy(records);
    return [...(this.claims(records, policy.verifiers).get(id) ?? [])].sort();
  }

  /** Put an attestation of this person on record here, if it is not (step 6). */
  async publishAttestation(a: Attestation): Promise<void> {
    if (!(await this.workspace())) return;
    if ((await this.records()).some((r) => r.kind === 'attest' && r.attestation?.sig === a.sig)) return;
    await this.decide('attest', a.id, { attestation: a });
  }

  /**
   * The devices whose person is an admin of the workspace (null if there is no
   * policy yet), and the person each device is, where known: who may remove a
   * device (an admin, or the same person: 0068).
   */
  private async managers(list?: MemberRecord[]): Promise<{ managers: Set<string> | null; persons: Map<string, string>; adminDevices: Set<string>; assigners: Set<string> }> {
    const records = list ?? (await this.records());
    const policy = await this.policy(records);
    const w = this.who(records);
    const self = (await this.deviceKey()).publicKey.toString('hex');
    const persons = new Map<string, string>();
    const managers = new Set<string>();
    const assigners = new Set<string>();
    for (const d of [self, ...(await this.members()).map((m) => m.key)]) {
      const id = w.personOf.get(w.signsWith.get(d) ?? '')?.key ?? null;
      if (id) persons.set(d, id);
      if (policy.isAdmin(id)) managers.add(d);
      if (policy.mayAssignAdmins(id)) assigners.add(d);
    }
    return { managers: policy.founded ? managers : null, persons, adminDevices: new Set(managers), assigners };
  }

  /**
   * Whether a device may remove another (0068, 0070): with no policy, any; its
   * own person, always; an admin, a member's computer; the owner, anyone's.
   */
  async mayRemove(device: string, other: string): Promise<boolean> {
    const { managers, persons, adminDevices, assigners } = await this.managers();
    if (!managers) return true;
    const whose = persons.get(device);
    if (whose && whose === persons.get(other)) return true;
    return managers.has(device) && (!adminDevices.has(other) || assigners.has(device));
  }

  /** The person (identity ID) a device is, as its signing key's vouch says; null if none. */
  async personIdOf(device: string): Promise<string | null> {
    return (await this.personOf(device))?.key ?? null;
  }

  /** Whether a device's person is an admin of the workspace (or of `group`); with no policy yet, every member is (0038). */
  async mayManage(device: string, group: string = WORKSPACE): Promise<boolean> {
    const policy = await this.policy();
    if (!policy.founded) return true;
    return policy.isAdmin(await this.personIdOf(device), group);
  }

  /** Make a policy operation, signed with this person's signing key, after all this device knows of. */
  async makePolicy(op: PolicyOp, key: KeyPair): Promise<string> {
    const ws = await this.workspace();
    if (!ws) throw new Error('This repository is not a workspace shared between devices');
    const parents = op.t === 'genesis' ? [] : (await this.policy()).heads;
    const e = makeOp(ws.id, op, parents, key);
    await this.decide('policy', e.id, { op: e.op, parents: e.parents, signer: e.signer, proof: e.proof });
    return e.id;
  }

  /**
   * A change to the policy that only an admin may make (`group`'s, or the
   * workspace's): refused here first if this person may not, and checked after.
   * In a workspace from before, the first seals its legacy geneses, so none
   * made later counts.
   */
  async adminOp(op: Extract<PolicyOp, { t: 'grant' | 'revoke' | 'rule' | 'verifier' | 'perm' | 'owner' | 'witness' }>, key: KeyPair): Promise<void> {
    const policy = await this.policy();
    const me = this.who(await this.records()).personOf.get(key.publicKey.toString('hex'))?.key ?? null;
    if (!policy.founded) throw new Error('This workspace has no policy yet');
    // The owner's (0070): giving the role; making, unmaking or taking out admins; the owner is never made a member or taken out.
    if (op.t === 'owner' && !policy.isOwner(me)) throw new Error('Only the owner gives the owner’s role');
    if ((op.t === 'grant' || op.t === 'revoke') && op.group === WORKSPACE) {
      if (op.who === policy.owner && (op.t === 'revoke' || op.role !== 'admin')) throw new Error('The owner stays an admin and in the workspace: they give the owner’s role to someone else first');
      const admin = policy.groups.get(WORKSPACE)?.get(op.who) === 'admin';
      if (((op.t === 'grant' && (op.role === 'admin' || admin)) || (op.t === 'revoke' && admin && op.who !== me)) && !policy.mayAssignAdmins(me)) {
        throw new Error('Only the workspace’s owner makes, unmakes or takes out admins');
      }
    }
    if (op.t === 'owner') {
      // Checked above.
    } else if (op.t === 'rule' || op.t === 'verifier' || op.t === 'perm' || op.t === 'witness') {
      if (!policy.isAdmin(me)) throw new Error(op.t === 'rule' ? 'Only an admin of this workspace can say who may change what' : op.t === 'witness' ? 'Only an admin of this workspace names its witnesses' : 'Only an admin of this workspace can say whose checks count here');
    } else if (!policy.isAdmin(me, op.group) && !(op.t === 'revoke' && op.who === me)) {
      throw new Error(op.group === WORKSPACE ? 'Only an admin of this workspace can change who is in it' : `Only an admin of ${op.group} can change who is in it`);
    }
    if (!(await this.pin()) && !policy.sealed) await this.makePolicy({ t: 'seal', geneses: policy.geneses }, key);
    const id = await this.makePolicy(op, key);
    if (!(await this.policy()).applied.includes(id)) {
      throw new Error(op.t === 'revoke' && op.group === WORKSPACE ? 'The workspace needs an admin: make someone else one first' : 'That change is not allowed');
    }
  }

  /**
   * Say how much of the policy this device holds (0072), if that changed since
   * it last said: an acknowledgement, by which its person confirms the removals
   * in it. Whether it said anything.
   */
  async acknowledge(): Promise<boolean> {
    if (!(await this.workspace())) return false;
    const records = await this.records();
    const policy = await this.policy(records);
    const self = (await this.deviceKey()).publicKey.toString('hex');
    if (!policy.founded || !policy.heads.length || !(await this.devices(records)).in.has(self)) return false;
    if ((this.latest('ack', self, records)?.policyHeads ?? []).join() === policy.heads.join()) return false;
    await this.decide('ack', createHash('sha256').update(`kuraa-ack\0${policy.heads.join(',')}`).digest('hex'), { policyHeads: policy.heads });
    return true;
  }

  /**
   * The removals that count (0072: people taken out of the workspace, computers
   * dropped), the latest first, with who confirmed each: the people, but
   * whoever made it and whoever it took out, whose devices' acknowledgements
   * say they hold it; and whether a witness is among them.
   */
  async confirmations(limit = 10): Promise<{ op: string; kind: 'person' | 'computer'; who: string; by: string | null; confirmedBy: string[]; witnessed: boolean }[]> {
    const records = await this.records();
    const policy = await this.policy(records);
    const w = this.who(records);
    const entries = new Map(records.filter((r) => r.kind === 'policy').map((r) => [r.subject, policyEntry(r)]));
    const personOfKey = (k: string) => (w.personOf.get(k) ?? w.formerly.get(k))?.key ?? null;
    // What each person's devices hold of the policy: all their acknowledged heads descend from.
    const held = new Map<string, Set<string>>();
    for (const device of new Set(records.filter((r) => r.kind === 'ack').map((r) => r.by))) {
      const ack = this.latest('ack', device, records)!;
      const person = personOfKey(w.signsWith.get(device) ?? '');
      if (!person) continue;
      const seen = held.get(person) ?? new Set<string>();
      for (const todo = [...(ack.policyHeads ?? [])]; todo.length;) {
        const id = todo.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        todo.push(...(entries.get(id)?.parents ?? []));
      }
      held.set(person, seen);
    }
    const out: { op: string; kind: 'person' | 'computer'; who: string; by: string | null; confirmedBy: string[]; witnessed: boolean }[] = [];
    for (const id of [...policy.applied].reverse()) {
      const e = entries.get(id);
      if (!e) continue;
      const who = e.op.t === 'revoke' && e.op.group === WORKSPACE ? e.op.who : e.op.t === 'drop' ? personOfKey(e.op.key) : null;
      if (!who) continue;
      const by = personOfKey(e.signer);
      const confirmedBy = [...held].filter(([p, ops]) => p !== by && p !== who && ops.has(id)).map(([p]) => p).sort();
      out.push({ op: id, kind: e.op.t === 'drop' ? 'computer' : 'person', who, by, confirmedBy, witnessed: confirmedBy.some((p) => policy.witnesses.has(p)) });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Make a space, or change who reads it (0066): checked after, as the policy judges it. */
  async makeSpace(id: string, audience: string[], key: KeyPair): Promise<void> {
    const op: PolicyOp = { t: 'space', id, audience: [...new Set(audience)].sort() };
    const made = await this.makePolicy(op, key);
    if (!(await this.policy()).applied.includes(made)) throw new Error('That audience is not one you may make');
  }

  /**
   * Write the policy down if there is none: for a workspace just made (`fresh`),
   * its genesis, naming this person its admin, pinned; for one from before, a
   * legacy genesis naming everyone this device knows of as admins (everyone has
   * the same say there, as before: 0038), which counts with the others' until an
   * admin seals them. A person whose key is not yet vouched for here writes none.
   */
  async ensureGenesis(person: string, key: KeyPair, fresh: boolean): Promise<void> {
    if (!(await this.workspace())) return;
    if (await this.pin()) return;
    if (fresh) {
      await this.setPin(await this.makePolicy({ t: 'genesis', admins: [person], legacy: false }, key));
      return;
    }
    const records = await this.records();
    const policy = await this.policy(records);
    const self = (await this.deviceKey()).publicKey.toString('hex');
    if (policy.founded || records.some((r) => r.kind === 'policy' && r.op?.t === 'genesis' && r.by === self)) return;
    const people = new Set([person, ...(await this.people()).map((p) => p.key)]);
    // This device's own: it counts here, and with the others' wherever they hold its maker an admin (policy.ts).
    await this.settleLegacy({ made: await this.makePolicy({ t: 'genesis', admins: [...people].sort(), legacy: true }, key) });
  }

  /** What this device knows, to judge a record by. */
  private async standing(): Promise<Standing> {
    const ws = await this.workspace();
    return {
      workspace: ws?.id ?? '',
      self: (await this.deviceKey()).publicKey.toString('hex'),
      members: new Set((await this.members()).map((m) => m.key)),
      removed: new Set(await this.removed()),
      ...(await this.managers()),
    };
  }

  /**
   * Drop one of a person's signing keys here (0072): the computer that signs
   * with it stops syncing, and what it signs from now on counts for nothing; what
   * it signed among `cutoff` (the commits this device has) still counts. Its own
   * person's to do, or an admin's (the owner's, for an admin's computer).
   */
  async dropKey(target: string, cutoff: string[], key: KeyPair): Promise<void> {
    const made = await this.makePolicy({ t: 'drop', key: target, cutoff: [...new Set(cutoff)].sort() }, key);
    if (!(await this.policy()).applied.includes(made)) throw new Error('Only an admin of this workspace (the owner, for an admin’s), or whoever it is, can remove a computer');
  }

  /**
   * Make the config say what the records say (the records are what counts; the
   * config is them applied): a device removed on record is removed here, one
   * paired on record is a remote here, a link revoked on record is revoked here.
   * Run when this device starts, and after a record could not be applied, so a
   * record kept but not applied (stopped in between, or git config could not be
   * written) is applied in the end. Remotes added by hand, or for a device not
   * on record (joining: the link's maker), are left as they are.
   */
  reconcile(): Promise<void> {
    return this.serial(() => this.reconcileNow());
  }

  private unapplied = false;

  private async reconcileNow(): Promise<void> {
    const list = await this.records();
    const ws = await this.workspace();
    if (!ws) return;
    const mine = list.filter((r) => r.workspace === ws.id);
    // Removals from before (0072: none made now).
    const removed = new Set(await this.getAll('kuraa.removed'));
    const remotes = new Set((await this.remotes()).map((m) => m.key));
    for (const r of mine) if (r.kind === 'remove' && (!removed.has(r.subject) || remotes.has(r.subject))) {
      await this.removeMemberNow(r.subject);
      removed.add(r.subject);
    }
    await this.syncRemotesNow();
    const revoked = new Set(await this.revokedLinks());
    for (const r of mine) if (r.kind === 'revoke-link' && !revoked.has(r.subject)) {
      await this.write(['config', '--add', 'kuraa.revokedlinks', r.subject]);
      revoked.add(r.subject);
    }
    await this.applySecret();
    this.unapplied = false;
  }

  /** The workspace's secret as the latest record of it says (made anew when a device is removed), into the config; null if none says. */
  private async applySecret(): Promise<void> {
    const ws = await this.workspace();
    if (!ws) return;
    let latest: MemberRecord | undefined;
    for (const r of await this.records()) if (r.kind === 'secret' && r.workspace === ws.id && (!latest || r.at > latest.at || (r.at === latest.at && r.sig > latest.sig))) latest = r;
    if (latest && latest.subject !== ws.secret) await this.write(['config', 'kuraa.secret', latest.subject]);
  }

  /**
   * Make the workspace's secret anew, on record (passed on to the members, never
   * to a removed device): devices find each other by it, so a device removed,
   * which knew the old one, can no longer find them. The new one is the secret
   * from now on, here and on each member as the record reaches it.
   */
  async newSecret(): Promise<string> {
    const secret = randomBytes(32).toString('hex');
    // The latest counts: later than any on record, even if this computer's clock is behind (0071).
    const latest = Math.max(0, ...(await this.records()).filter((r) => r.kind === 'secret').map((r) => r.at));
    await this.decide('secret', secret, { at: Math.max(Date.now(), latest + 1) });
    return secret;
  }

  /**
   * The topics of the invite links members made that still let people in (not
   * revoked or used, and not expired): every member announces them, so the
   * link's holder finds one, whichever is online. With when the soonest expires.
   */
  async linkTopics(now = Date.now()): Promise<{ topics: string[]; next: number }> {
    const ws = await this.workspace();
    const revoked = new Set([...(await this.revokedLinks()), ...(await this.policy()).unlinked]);
    const topics = new Set<string>();
    let next = 0;
    for (const r of await this.records()) {
      if (r.kind !== 'link' || r.workspace !== ws?.id || !r.topic || revoked.has(r.subject)) continue;
      if (r.expires && r.expires <= now) continue;
      topics.add(r.topic);
      if (r.expires && (!next || r.expires < next)) next = r.expires;
    }
    return { topics: [...topics], next };
  }

  /** Apply a record taken; if it cannot be now, it will be (reconcile) before the next change. */
  private async applyOrLater(r: MemberRecord, o: { rethrow: boolean }): Promise<void> {
    try {
      await this.apply(r);
    } catch (e) {
      this.unapplied = true;
      if (o.rethrow) throw e;
    }
  }

  /** Apply a record taken. */
  private async apply(r: MemberRecord): Promise<void> {
    // Pairings from before say nothing now (0072); removals from before still count.
    if (r.kind === 'remove') await this.removeMemberNow(r.subject);
    else if (r.kind === 'revoke-link' && !(await this.revokedLinks()).includes(r.subject)) await this.write(['config', '--add', 'kuraa.revokedlinks', r.subject]);
    else if (r.kind === 'secret') await this.applySecret();
    // signs, vouch, revoke-key, link, key-event: kept as they are, and read from the records.
  }

  /**
   * A change this device makes: signed with its key, kept, applied here, and
   * passed on. Any member may make one, and every other takes it (records.ts, judge).
   */
  decide(kind: RecordKind, subject: string, extra: { name?: string; proof?: string; keyProof?: string; person?: string; personKey?: string; event?: KeyEvent; op?: PolicyOp; parents?: string[]; signer?: string; heads?: string[]; policyHeads?: string[]; attestation?: Attestation; topic?: string; expires?: number; at?: number } = {}): Promise<MemberRecord> {
    return this.serial(async () => {
      const ws = await this.workspace();
      if (!ws) throw new Error('This repository is not a workspace shared between devices');
      if (this.unapplied) await this.reconcileNow();
      const r = signRecord({ kind, workspace: ws.id, subject, ...extra }, await this.deviceKey());
      await this.keepRecord(r);
      await this.applyOrLater(r, { rethrow: true });
      await this.syncRemotesOrLater();
      if (kind === 'policy') await this.settleLegacy();
      return r;
    });
  }

  /**
   * Records from another device: each taken as records.ts (judge) says, until
   * no more can be (one taken may make another's maker known to be in).
   * Returns those taken.
   */
  takeRecords(list: unknown[], o: { welcomed?: boolean } = {}): Promise<MemberRecord[]> {
    return this.serial(async () => {
      // Kept all at once, written down once (not the whole file again for each).
      const taken = await this.batch(() => this.takeNow(list));
      // A workspace from before: the legacy geneses of the device that welcomed this one; the seal it keeps to (settleLegacy).
      if (taken.some((r) => r.kind === 'policy')) await this.settleLegacy(o.welcomed ? { welcomed: taken } : {});
      return taken;
    });
  }

  private async takeNow(list: unknown[]): Promise<MemberRecord[]> {
    if (this.unapplied) await this.reconcileNow();
    const known = new Set((await this.records()).map((r) => r.sig));
    let waiting = list.map(readRecord).filter((r): r is MemberRecord => !!r && !known.has(r.sig));
    const taken: MemberRecord[] = [];
    if (!waiting.length) return taken;
    // What this device knows, read once and kept up to date as records are taken.
    const standing = await this.standing();
    for (let progress = true; progress && waiting.length;) {
      progress = false;
      const next: MemberRecord[] = [];
      // Who is an admin, worked out again once a round (0071), not after each record: a record that waits for
      // what one taken this round says is judged again in the next.
      let stale = false;
      for (const r of waiting) {
        const verdict = judge(r, standing);
        if (verdict === 'take') {
          // One that says what a newer record says already is passed over: nothing changes.
          if (!(await this.keepRecord(r))) continue;
          await this.applyOrLater(r, { rethrow: false });
          // Who is in, and who is an admin, may have changed: a record waiting for that is judged again.
          if (['policy', 'vouch', 'key-event', 'signs', 'revoke-key', 'remove'].includes(r.kind)) stale = true;
          taken.push(r);
          progress = true;
        } else if (verdict === 'wait') next.push(r);
      }
      if (stale) Object.assign(standing, await this.standing());
      waiting = next;
    }
    // One could not be applied: try again now, and if that fails too, before the next change.
    if (this.unapplied) await this.reconcileNow().catch(() => undefined);
    if (taken.length) await this.syncRemotesOrLater();
    return taken;
  }

  // Invite links ------------------------------------------------------------

  private get linksFile(): string {
    return join(this.stateDir, 'links.json');
  }

  /** The links this device made. */
  async links(): Promise<IssuedLink[]> {
    try {
      return JSON.parse(await readFile(this.linksFile, 'utf8')) as IssuedLink[];
    } catch {
      return [];
    }
  }

  /**
   * Make an invite link: whoever has it can join the workspace as a device,
   * until it expires (`hours`; null: never) or is revoked; `once`, for one
   * person: the first device it lets in uses it up. Signed with this device's
   * key, so any member can check it and let them in. Where the workspace has a
   * policy (0066), the link puts its holder in a group (`grant`: the workspace,
   * as a member, unless it says otherwise), signed by this person's signing key,
   * who must be an admin of that group.
   */
  async createLink(hours: number | null, once: boolean, hints: LinkHints = { relays: [], tcp: [] }, grant?: { key: KeyPair; group?: string; role?: Role }): Promise<string> {
    const ws = await this.workspace();
    if (!ws) throw new Error('This repository is not a workspace shared between devices');
    const key = await this.deviceKey();
    const id = randomBytes(8).toString('hex');
    const policy = await this.policy();
    const expires = hours === null ? 0 : Date.now() + hours * 3600_000;
    const issuer = key.publicKey.toString('hex');
    let granted: LinkGrant | undefined;
    if (policy.founded) {
      if (!grant) throw new Error('Only a person can invite to this workspace: this computer has no identity');
      const group = grant.group ?? WORKSPACE;
      const role = grant.role ?? 'member';
      if (!isGroupName(group)) throw new Error('Not a group');
      const signer = grant.key.publicKey.toString('hex');
      const who = this.who(await this.records()).personOf.get(signer)?.key ?? null;
      if (!policy.isAdmin(who, group)) throw new Error(group === WORKSPACE ? 'Only an admin of this workspace can invite people to it' : `Only an admin of ${group} can invite people to it`);
      if (group === WORKSPACE && role === 'admin' && !policy.mayAssignAdmins(who)) throw new Error('Only the workspace’s owner invites people as admins');
      const genesis = await this.pin();
      // Counting only for whom a device in the workspace lets in by it (admit), which checks it has not expired.
      granted = { group, role, genesis, granter: signer, signature: crypto.sign(admittedGrantMessage(ws.id, genesis, id, group, role, once, expires, issuer), grant.key.secretKey).toString('hex') };
    }
    const through = await this.cameInThrough();
    // Its own topic, not the workspace's secret: whoever holds the link finds the members by it
    // while it lets people in (every member announces it, from the link record), and nothing after.
    const topic = randomBytes(32).toString('hex');
    const signature = crypto.sign(linkMessage(ws.id, id, expires, once, issuer, through, topic), key.secretKey).toString('hex');
    const list = await this.links();
    list.push({ id, expires, once, created: Date.now(), ...(granted ? { group: granted.group, admitted: true } : {}) });
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.linksFile, JSON.stringify(list), { mode: 0o600 });
    await this.decide('link', id, { topic, expires });
    return encodeLink({ workspace: { id: ws.id, secret: null, forkedFrom: ws.forkedFrom }, topic, issuer: { key: issuer, name: await this.deviceName() }, through, id, expires, once, signature, hints, ...(granted ? { grant: granted } : {}) });
  }

  /**
   * Why a link's grant does not let its holder in under this workspace's policy,
   * or null if it does (or there is no policy yet: 0038). The grant must be for
   * this workspace's genesis, signed by its granter, who must be an admin of
   * the group it names.
   */
  async refuseGrant(l: InviteLink): Promise<string | null> {
    const policy = await this.policy();
    if (!policy.founded) return null;
    const g = l.grant;
    if (!g) return 'the link was made by an older kuraa: ask for a new one';
    if (g.genesis !== (await this.pin())) return 'the link is for another history of this workspace';
    // Signed with the link's expiry and maker (0071): a grant from before is not, and could be put in a link that never expires.
    const signed = (m: Buffer) => crypto.verify(m, Buffer.from(g.signature, 'hex'), Buffer.from(g.granter, 'hex'));
    if (!signed(admittedGrantMessage(l.workspace.id, g.genesis, l.id, g.group, g.role, l.once, l.expires, l.issuer.key)) && !signed(linkGrantMessage(l.workspace.id, g.genesis, l.id, g.group, g.role, l.once, l.expires, l.issuer.key))) {
      return signed(grantMessage(l.workspace.id, g.genesis, l.id, g.group, g.role, l.once)) ? 'the link was made by an older kuraa: ask for a new one' : 'the link is not signed by the person it names';
    }
    // Unlinked in the policy (revoked by an admin, wherever): it lets no one in.
    if (policy.unlinked.has(l.id)) return l.once ? 'the link was used, or revoked' : 'the link was revoked';
    const who = this.who(await this.records()).personOf.get(g.granter)?.key ?? null;
    if (!policy.isAdmin(who, g.group)) return 'the person who made the link may no longer invite people';
    return null;
  }

  /**
   * Joined by a link that puts its holder in a group: say so in the policy,
   * with the link's grant (once: done already, it is not done again).
   */
  async joinPolicy(l: InviteLink, key: KeyPair): Promise<void> {
    const g = l.grant;
    if (!g || !(await this.workspace())) return;
    const records = await this.records();
    const signer = key.publicKey.toString('hex');
    if (records.some((r) => r.kind === 'policy' && r.op?.t === 'join' && r.op.link === l.id && r.signer === signer)) return;
    await this.makePolicy({ t: 'join', group: g.group, role: g.role, link: l.id, once: l.once, granter: g.granter, grant: g.signature, expires: l.expires, issuer: l.issuer.key }, key);
  }

  /**
   * The devices this one came into the workspace through, back to the first
   * (from the pairing records it holds): with this device, where a device
   * joining by its link traces the others from (records.ts, traced).
   */
  async cameInThrough(): Promise<string[]> {
    const self = (await this.deviceKey()).publicKey.toString('hex');
    const adds = (await this.records()).filter((r) => r.kind === 'add');
    const out = new Set<string>();
    for (const todo = [self]; todo.length;) {
      const k = todo.pop()!;
      for (const r of adds) {
        if (r.subject === k && r.by !== self && !out.has(r.by)) {
          out.add(r.by);
          todo.push(r.by);
        }
      }
    }
    return [...out].sort();
  }

  /**
   * Revoke a link, on record (passed on to the others): no device lets anyone
   * join by it any more (those who did stay). With this person's signing key,
   * where the workspace has a policy, unlinked in it too: a join by it that was
   * not made before, from anyone, counts for nothing (policy.ts).
   */
  async revokeLink(id: string, key?: KeyPair): Promise<void> {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('Not a link id');
    await this.decide('revoke-link', id);
    if (key) await this.unlink(id, key);
  }

  /** Unlink a link in the policy (policy.ts), if this person may (an admin of its group) and it is not already. */
  private async unlink(id: string, key: KeyPair): Promise<void> {
    const policy = await this.policy();
    if (!policy.founded || policy.unlinked.has(id)) return;
    const records = await this.records();
    const me = this.who(records).personOf.get(key.publicKey.toString('hex'))?.key ?? null;
    // Its group: as this device made it, or as the joins by it say; else the workspace.
    const mine = (await this.links()).find((l) => l.id === id);
    const joined = records.find((r) => r.kind === 'policy' && r.op?.t === 'join' && r.op.link === id)?.op;
    const group = mine?.group ?? (joined?.t === 'join' ? joined.group : WORKSPACE);
    if (!policy.isAdmin(me, group)) return;
    await this.makePolicy({ t: 'unlink', link: id, group }, key);
  }

  /**
   * Unlink in the policy what no longer lets anyone in but its join could still
   * count by (policy.ts: a grant from before links were let in by): links this
   * device revoked on record, and links it made that have expired. Their
   * grants then let no one in, whoever holds them.
   */
  async unlinkStale(key: KeyPair, now = Date.now()): Promise<void> {
    if (!(await this.workspace()) || !(await this.policy()).founded) return;
    const records = await this.records();
    const self = (await this.deviceKey()).publicKey.toString('hex');
    const used = new Set(records.filter((r) => r.kind === 'revoke-link' && r.name === 'used').map((r) => r.subject));
    const stale = new Set(records.filter((r) => r.kind === 'revoke-link' && r.name !== 'used' && r.by === self).map((r) => r.subject));
    for (const l of await this.links()) if (!l.admitted && l.expires && l.expires <= now && !used.has(l.id)) stale.add(l.id);
    for (const id of stale) await this.unlink(id, key);
  }

  /**
   * Say in the policy that this device let someone in by a link (policy.ts,
   * admit): it checked the link, so a join by its grant counts for them.
   * `signer`: the key their join is signed with.
   */
  async admit(link: string, signer: string, key: KeyPair): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(signer) || !(await this.policy()).founded) return;
    await this.makePolicy({ t: 'admit', link, key: signer }, key);
  }

  /** A link for one person has let them in: on record, so no device lets anyone else in by it. */
  async useLink(id: string): Promise<void> {
    await this.decide('revoke-link', id, { name: 'used' });
  }

  /** Links that no longer let anyone in: revoked, or used (for one person). */
  async revokedLinks(): Promise<string[]> {
    return this.getAll('kuraa.revokedlinks');
  }

  /** Of those, the links for one person that were used. */
  async usedLinks(): Promise<string[]> {
    return (await this.records()).filter((r) => r.kind === 'revoke-link' && r.name === 'used').map((r) => r.subject);
  }

  /** The link this device joined by, shown to devices it meets that do not know it yet. */
  async joinedLink(): Promise<string | null> {
    try {
      return (await readFile(join(this.stateDir, 'joined-link'), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }

  async setJoinedLink(link: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(join(this.stateDir, 'joined-link'), link, { mode: 0o600 });
  }
}

/** An invite link as the device that made it keeps it. */
export interface IssuedLink {
  id: string;
  /** When it stops working (ms since 1970); 0: never. */
  expires: number;
  /** For one person: it lets one device in. */
  once: boolean;
  created: number;
  /** The group its grant lets its holder into; and whether that grant counts only for whom a device lets in (policy.ts, admit). */
  group?: string;
  admitted?: boolean;
}

/**
 * What an invite link carries: the workspace (its id; not its secret, which the
 * device that lets the holder in gives it), the topic to find the members by,
 * the device that made it, and its signature. Links made before 0050 carry the
 * secret instead of a topic.
 */
export interface InviteLink {
  workspace: { id: string; secret: string | null; forkedFrom: string | null };
  /** The topic the members announce while the link lets people in, hex; null in a link made before 0050. */
  topic: string | null;
  /**
   * Ways in besides the DHT (0053): relays named, and servers that take TCP
   * (`key@host:port`). Not signed: a link changed to name others gets its holder
   * nowhere, as every connection proves the key it reaches.
   */
  hints?: LinkHints;
  issuer: Member;
  /** The devices the issuer came into the workspace through, back to the first (Identity.cameInThrough). */
  through: string[];
  id: string;
  expires: number;
  /** For one person: the first device it lets in uses it up. */
  once: boolean;
  /** The issuer's signature over the workspace id, link id, expiry, whether it is for one person, issuer key and the devices it came in through, hex. */
  signature: string;
  /** Where the workspace has a policy (0066): the group the holder is put in, and as what, signed by an admin of it. */
  grant?: LinkGrant;
}

/** What an invite link lets its holder be (0066): signed (grantMessage) by an admin's signing key. */
export interface LinkGrant {
  group: string;
  role: Role;
  /** The workspace's genesis (its pin); null in one from before. */
  genesis: string | null;
  /** The signing key that signed it. */
  granter: string;
  signature: string;
}

function encodeGrant(g: LinkGrant | undefined): string {
  return g ? `g:${g.group},${g.role},${g.genesis ?? '-'},${g.granter},${g.signature}` : '';
}

function decodeGrant(s: string | undefined): LinkGrant | undefined {
  const m = s ? /^g:([a-z0-9][a-z0-9-]{0,39}),(admin|member),([0-9a-f]{64}|-),([0-9a-f]{64}),([0-9a-f]{128})$/.exec(s) : null;
  return m ? { group: m[1]!, role: m[2] as Role, genesis: m[3] === '-' ? null : m[3]!, granter: m[4]!, signature: m[5]! } : undefined;
}

/** Ways into a workspace besides the DHT, as an invite link carries them. */
export interface LinkHints { relays: string[]; tcp: string[] }

const HINT_TCP = /^[0-9a-f]{64}@[^\s,;|]{3,300}$/;

function encodeHints(h: LinkHints | undefined): string {
  if (!h || (!h.relays.length && !h.tcp.length)) return '';
  return `r:${h.relays.join(',')};t:${h.tcp.join(',')}`;
}

function decodeHints(s: string | undefined): LinkHints | undefined {
  if (!s) return undefined;
  const m = /^r:([^;]*);t:(.*)$/.exec(s);
  if (!m) return undefined;
  return { relays: m[1]!.split(',').filter((k) => /^[0-9a-f]{64}$/.test(k)).slice(0, 8), tcp: m[2]!.split(',').filter((a) => HINT_TCP.test(a)).slice(0, 8) };
}

/** What a link's maker signs: all it says but the secret (a link before 0050 has one, and no topic). */
const linkMessage = (workspace: string, id: string, expires: number, once: boolean, issuer: string, through: string[], topic: string | null) =>
  Buffer.from(`kuraa-invite\0${workspace}\0${id}\0${expires}\0${once ? 'once' : 'anyone'}\0${issuer}\0${through.join(',')}${topic ? `\0${topic}` : ''}`);

export function encodeLink(l: InviteLink): string {
  // The second field: the topic, as `t:<topic>`; in a link before 0050, the workspace's secret.
  const where = l.topic ? `t:${l.topic}` : l.workspace.secret ?? '';
  const hints = encodeHints(l.hints);
  const grant = encodeGrant(l.grant);
  // Hints, then the grant, each where there is one (an empty hints field before a grant).
  const tail = grant ? [hints, grant] : hints ? [hints] : [];
  const payload = [l.workspace.id, where, l.workspace.forkedFrom ?? '', l.issuer.key, l.issuer.name, l.id, String(l.expires), l.once ? '1' : '0', l.signature, l.through.join(','), ...tail].join('|');
  return `kuraa-invite:${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeLink(code: string): InviteLink {
  const m = /^kuraa-invite:([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('Not an invite link (it starts with kuraa-invite:)');
  const [id, where, forkedFrom, key, name, linkId, expires, once, signature, throughField, hintsField, grantField] = Buffer.from(m[1]!, 'base64url').toString('utf8').split('|');
  const through = throughField ? throughField.split(',') : [];
  const topic = where?.startsWith('t:') ? where.slice(2) : null;
  const secret = topic === null ? where : null;
  if (!id || !where || !key || !name || !linkId || !signature || throughField === undefined || !hex.test(id) || (topic !== null ? !/^[0-9a-f]{64}$/.test(topic) : !hex.test(secret!)) || !hex.test(key) || !/^[0-9a-f]{16}$/.test(linkId) || !/^\d+$/.test(expires ?? '') || (once !== '0' && once !== '1') || !hex.test(signature)
    || through.some((k) => !/^[0-9a-f]{64}$/.test(k))) {
    throw new Error('This invite link is damaged');
  }
  const hints = decodeHints(hintsField);
  const grant = decodeGrant(grantField);
  if (grantField && !grant) throw new Error('This invite link is damaged');
  return { workspace: { id, secret: secret ?? null, forkedFrom: forkedFrom || null }, topic, issuer: { key, name }, through, id: linkId, expires: Number(expires), once: once === '1', signature, ...(hints ? { hints } : {}), ...(grant ? { grant } : {}) };
}

/**
 * Why a link does not let a device join this workspace, or null if it does:
 * it is for this workspace, made by a member (any member's counts: 0038),
 * signed by it, not expired, and neither revoked nor used.
 */
export function checkLink(l: InviteLink, o: { workspace: string; members: string[]; revoked: string[]; now?: number }): string | null {
  if (l.workspace.id !== o.workspace) return 'the link is for another workspace';
  if (!o.members.includes(l.issuer.key)) return 'the link was made by a device that is not in the workspace';
  if (!linkSigned(l)) return 'the link is not signed by the device it names';
  if (l.expires !== 0 && l.expires < (o.now ?? Date.now())) return 'the link has expired';
  if (o.revoked.includes(l.id)) return l.once ? 'the link was used, or revoked' : 'the link was revoked';
  return null;
}

/** Whether a link is as the device it names made it: its signature over all it says but the workspace's secret. */
export function linkSigned(l: InviteLink): boolean {
  return crypto.verify(linkMessage(l.workspace.id, l.id, l.expires, l.once, l.issuer.key, l.through, l.topic), Buffer.from(l.signature, 'hex'), Buffer.from(l.issuer.key, 'hex'));
}
