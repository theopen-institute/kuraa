// Who a workspace is, which device this is, and which devices it is paired
// with: all kept on the device, never in the files people commit, as git keeps
// its remotes (see docs/decisions/0028-peers.md).
//
// - The workspace's id and secret, and this device's name: git config (`kuraa.*`).
// - This device's key pair: .git/kuraa/device.json, readable only by its owner.
// - Paired devices: git remotes whose URL is `kuraa://<device key>`, so
//   `git fetch laptop` works and their branches are `laptop/main`.
// - Devices removed from the workspace: `kuraa.removed`, never accepted again.
// - Invitations not yet used: .git/kuraa/invites.json.
// - Subscription links this device made: .git/kuraa/links.json; revoked ones,
//   `kuraa.revokedlinks` (shared with the other devices, as removals are). The
//   link this device joined by: .git/kuraa/joined-link.
// - Every change to the members, signed by the device that made it:
//   .git/kuraa/records.json (records.ts). The config above is what the records
//   this device took say, applied.
// - Whose work this device accepts on its own, by branch, and whose membership
//   changes: .git/kuraa/accept.json (accept.ts). Its own choice (0032).
// - The sync remote: the ordinary git remote Sync uses (GitHub, say), if it is not origin: `kuraa.syncremote`.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import type { Git } from '../git.js';
import { serialQueue } from '../serial.js';
import { reservedName } from '../files.js';
import { aboutItself, byPerson, judge, readRecord, sign, signRecord, signsMessage, vouchMessage, type MemberRecord, type RecordKind, type Standing } from './records.js';
import { EVERYONE, canonicalRules, readRules, rulePath, encodeRules, decodeRules, type AcceptRules } from './accept.js';
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

const hex = /^[0-9a-f]+$/;

/** The swarm topic for a workspace: derived from its secret, so only devices that know it find each other. */
export function topicFor(secret: string): Buffer {
  return createHash('sha256').update(`kuraa workspace topic\0${secret}`).digest();
}

/** A name a git remote can have: letters, digits, dots, dashes; not empty. */
export function remoteName(name: string): string {
  const clean = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  // Remotes are folders under .git/refs/remotes: none Windows could not make (con, nul, …).
  return !clean ? 'device' : reservedName(clean) ? `${clean}-device` : clean;
}

export class Identity {
  /** Changes to the members, one at a time (a device may be paired by two routes at once). */
  private readonly serial = serialQueue();

  constructor(private readonly git: Git, private readonly stateDir: string) {}

  private async get(key: string): Promise<string | null> {
    const r = await this.git.run(['config', '--get', key], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async getAll(key: string): Promise<string[]> {
    const r = await this.git.run(['config', '--get-all', key], { allowFail: true });
    return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
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
    await this.git.run(['config', 'kuraa.originsecret', old.secret]);
    await this.setSyncRemote(null);
    // A workspace of its own: it accepts everyone's work, until its devices say otherwise.
    await this.setRules({ rules: [], membership: null });
    return ws;
  }

  /** The secret of the workspace this one was forked from, to meet its devices. */
  async originSecret(): Promise<string | null> {
    return this.get('kuraa.originsecret');
  }

  /** Take on a workspace's identity (a device joining it). */
  async adopt(ws: WorkspaceIdentity): Promise<void> {
    if (!hex.test(ws.id) || !hex.test(ws.secret)) throw new Error('Not a workspace identity');
    await this.git.run(['config', 'kuraa.workspace', ws.id]);
    await this.git.run(['config', 'kuraa.secret', ws.secret]);
    if (ws.forkedFrom) await this.git.run(['config', 'kuraa.forkedfrom', ws.forkedFrom]);
    else await this.git.run(['config', '--unset', 'kuraa.forkedfrom'], { allowFail: true });
  }

  /** What this device is called to its peers. */
  async deviceName(): Promise<string> {
    return (await this.get('kuraa.devicename')) ?? remoteName(hostname().replace(/\.local$/, ''));
  }

  async setDeviceName(name: string): Promise<void> {
    await this.git.run(['config', 'kuraa.devicename', remoteName(name)]);
  }

  /** This device's key pair, made the first time it is asked for (keys.ts). */
  deviceKey(): Promise<KeyPair> {
    return keptKey(join(this.stateDir, 'device.json'));
  }

  /** The devices this one is paired with: its kuraa:// remotes. */
  async members(): Promise<Member[]> {
    const r = await this.git.run(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
    const out: Member[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^remote\.(.+)\.url (.*)$/.exec(line.trim());
      if (m && m[2]!.startsWith(KURAA_SCHEME)) {
        const key = m[2]!.slice(KURAA_SCHEME.length).replace(/\/$/, '');
        if (hex.test(key) && key.length === 64) out.push({ name: m[1]!, key });
      }
    }
    return out;
  }

  /** Pair with a device: add it as a remote (under a free name), unless it was removed. Returns its remote name. */
  addMember(key: string, name: string): Promise<string | null> {
    return this.serial(() => this.addMemberNow(key, name));
  }

  private async addMemberNow(key: string, name: string): Promise<string | null> {
    if (!hex.test(key) || key.length !== 64) throw new Error('Not a device key');
    if ((await this.removed()).includes(key)) return null;
    const members = await this.members();
    const known = members.find((m) => m.key === key);
    if (known) return known.name;
    const remotes = (await this.git.out(['remote'])).split('\n').filter(Boolean);
    const base = remoteName(name);
    let pick = base;
    for (let i = 2; remotes.includes(pick); i++) pick = `${base}-${i}`;
    await this.git.run(['remote', 'add', pick, `${KURAA_SCHEME}${key}`]);
    return pick;
  }

  /** Remove a device from the workspace, on record (passed on to the others): forget it, and never accept it again. */
  async removeMember(key: string): Promise<void> {
    await this.decide('remove', key);
  }

  private async removeMemberNow(key: string): Promise<void> {
    const m = (await this.members()).find((x) => x.key === key);
    if (m) await this.git.run(['remote', 'remove', m.name]);
    if (!(await this.removed()).includes(key)) await this.git.run(['config', '--add', 'kuraa.removed', key]);
  }

  async removed(): Promise<string[]> {
    return this.getAll('kuraa.removed');
  }

  /** The sync remote: the ordinary git remote Sync fetches from, merges and pushes to (GitHub, say), if one is chosen. */
  async syncRemote(): Promise<string | null> {
    return this.get('kuraa.syncremote');
  }

  async setSyncRemote(remote: string | null): Promise<void> {
    if (remote === null) await this.git.run(['config', '--unset', 'kuraa.syncremote'], { allowFail: true });
    else await this.git.run(['config', 'kuraa.syncremote', remote]);
  }

  // Whose work this device accepts on its own (accept.ts) ----------------------

  private get rulesFile(): string {
    return join(this.stateDir, 'accept.json');
  }

  /** This device's rules: every member's work, until it says otherwise. */
  async rules(): Promise<AcceptRules> {
    const cached = await this.fresh(this.rulesFile, this.rulesCache);
    if (cached) return structuredClone(cached.value);
    try {
      const rules = readRules(JSON.parse(await readFile(this.rulesFile, 'utf8')));
      this.rulesCache = { stamp: await this.stamp(this.rulesFile), value: rules };
      return structuredClone(rules);
    } catch {
      const rules: AcceptRules = { ...EVERYONE, rules: [] };
      // Written once, so the rules are read from the file from now on (published when the device starts syncing).
      await this.writeRules(rules);
      return rules;
    }
  }

  /** Keep this device's rules, and publish them to the others (a rules record), if this is a shared workspace. */
  async setRules(r: AcceptRules): Promise<void> {
    await this.writeRules(readRules(r));
    await this.publishRules();
  }

  private async writeRules(r: AcceptRules): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.rulesFile, JSON.stringify(r, null, 1));
    this.rulesCache = null;
  }

  /** Publish this device's rules to the others (a rules record), if they changed since it last did; in a shared workspace. */
  async publishRules(): Promise<void> {
    if (!(await this.workspace())) return;
    const self = (await this.deviceKey()).publicKey.toString('hex');
    const text = canonicalRules(await this.rules());
    if (this.latest('rules', self, await this.records())?.rules !== text) await this.decide('rules', '', { rules: text });
  }

  /**
   * On `branch`, at `path` ('' the whole branch, 'dir/' a folder, else a file),
   * accept only the work of these devices or people on its own; null: every member's.
   */
  async acceptOn(branch: string, path: string, from: string[] | null): Promise<void> {
    const r = await this.rules();
    const at = rulePath(path);
    r.rules = r.rules.filter((x) => !(x.branch === branch && x.path === at));
    if (from) r.rules.push({ branch, path: at, from });
    await this.setRules(r);
  }

  /** Accept membership changes only from these devices or people (null: every member's). */
  async acceptMembershipFrom(from: string[] | null): Promise<void> {
    await this.setRules({ ...(await this.rules()), membership: from });
  }

  // Signed records (records.ts) --------------------------------------------

  private get recordsFile(): string {
    return join(this.stateDir, 'records.json');
  }

  private rulesCache: { stamp: string; value: AcceptRules } | null = null;
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

  /** The records this device has made or accepted. */
  async records(): Promise<MemberRecord[]> {
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

  /** The latest record of a kind a device made about itself (rules, person). */
  private latest(kind: RecordKind, by: string, list: MemberRecord[]): MemberRecord | undefined {
    let best: MemberRecord | undefined;
    for (const r of list) if (r.kind === kind && r.by === by && (!best || r.at > best.at || (r.at === best.at && r.sig > best.sig))) best = r;
    return best;
  }

  private async keepRecord(r: MemberRecord): Promise<void> {
    let list = await this.records();
    if (list.some((x) => x.sig === r.sig)) return;
    if (aboutItself(r.kind)) {
      // Only the latest of what a device says about itself is kept.
      const now = this.latest(r.kind, r.by, list);
      if (now && (now.at > r.at || (now.at === r.at && now.sig > r.sig))) return;
      list = list.filter((x) => !(x.kind === r.kind && x.by === r.by));
    }
    // What a person says about a key, once, whoever passed it on (a vouch: the latest).
    if (byPerson(r.kind)) {
      const same = list.filter((x) => x.kind === r.kind && x.person === r.person && x.subject === r.subject);
      if (r.kind === 'revoke-key' && same.length) return;
      if (same.some((x) => x.at > r.at || (x.at === r.at && x.sig > r.sig))) return;
      list = list.filter((x) => !same.includes(x));
    }
    list.push(r);
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.recordsFile, JSON.stringify(list, null, 1));
    this.recordsCache = null;
  }

  /** Another device's rules, as it last published them; null if it has not. */
  async rulesOf(device: string): Promise<AcceptRules | null> {
    const self = (await this.deviceKey()).publicKey.toString('hex');
    if (device === self) return this.rules();
    const r = this.latest('rules', device, await this.records());
    if (!r?.rules) return null;
    try {
      return readRules(JSON.parse(r.rules));
    } catch {
      return null;
    }
  }

  /**
   * Who is who, from the records (0035): the signing key each device signs with,
   * and the person whose each signing key is: the one identity that vouched for
   * it, with the key's own signature too. A key more than one identity vouched
   * for (only whoever holds it could make that so) is no one's, as is one its
   * person revoked.
   */
  private who(list: MemberRecord[]): { signsWith: Map<string, string>; personOf: Map<string, { key: string; name: string }> } {
    const signsWith = new Map<string, string>();
    for (const by of new Set(list.filter((r) => r.kind === 'signs').map((r) => r.by))) signsWith.set(by, this.latest('signs', by, list)!.subject);
    const revoked = new Set(list.filter((r) => r.kind === 'revoke-key').map((r) => `${r.person}\0${r.subject}`));
    const vouches = new Map<string, MemberRecord[]>();
    for (const r of list) if (r.kind === 'vouch') vouches.set(r.subject, [...(vouches.get(r.subject) ?? []), r]);
    const personOf = new Map<string, { key: string; name: string }>();
    for (const [key, vs] of vouches) {
      if (new Set(vs.map((v) => v.person)).size !== 1) continue;
      // Their latest name.
      const v = vs.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.sig > a.sig) ? b : a));
      if (!revoked.has(`${v.person}\0${key}`)) personOf.set(key, { key: v.person!, name: v.name ?? '' });
    }
    return { signsWith, personOf };
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

  /**
   * Who a device or a signing key is, for rules: the key itself, the signing key
   * a device signs with, and the person whose that is. A revoked key is only
   * itself from the moment this device takes the revocation: work it signed
   * that this device already has stays as it is, and none that comes after counts as theirs.
   */
  async identitiesOf(deviceOrKey: string): Promise<string[]> {
    return this.identitiesIn(this.who(await this.records()), deviceOrKey);
  }

  private identitiesIn(w: ReturnType<Identity['who']>, k: string): string[] {
    const signing = w.signsWith.get(k);
    const person = w.personOf.get(signing ?? k);
    return [k, ...(signing ? [signing] : []), ...(person ? [person.key] : [])];
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
    if (this.latest('signs', self, await this.records())?.subject === hex) return;
    await this.decide('signs', hex, { proof: sign(signsMessage(self), key) });
  }

  /** Say, in this workspace, that a signing key is a person's: with their identity's signature and the key's own. */
  async vouch(person: Person, key: KeyPair): Promise<void> {
    if (!(await this.workspace())) return;
    const p = person.publicKey.toString('hex');
    const k = key.publicKey.toString('hex');
    if ((await this.records()).some((r) => r.kind === 'vouch' && r.person === p && r.subject === k && r.name === person.name)) return;
    const m = vouchMessage(k, p, person.name);
    await this.decide('vouch', k, { person: p, name: person.name, proof: sign(m, person), keyProof: sign(m, key) });
  }

  /** Pass on a person's revocation of one of their signing keys (with their signature), in this workspace. */
  async revokeKey(person: string, key: string, proof: string): Promise<void> {
    if (!(await this.workspace())) return;
    if ((await this.records()).some((r) => r.kind === 'revoke-key' && r.person === person && r.subject === key)) return;
    await this.decide('revoke-key', key, { person, proof });
  }

  /** What this device knows, to judge a record by. */
  private async standing(): Promise<Standing> {
    const ws = await this.workspace();
    const w = this.who(await this.records());
    return {
      workspace: ws?.id ?? '',
      self: (await this.deviceKey()).publicKey.toString('hex'),
      members: new Set((await this.members()).map((m) => m.key)),
      removed: new Set(await this.removed()),
      acceptsFrom: (await this.rules()).membership,
      identitiesOf: (device: string) => this.identitiesIn(w, device),
    };
  }

  /** Apply a record taken. */
  private async apply(r: MemberRecord): Promise<void> {
    const self = (await this.deviceKey()).publicKey.toString('hex');
    // This device's own pairing, as another made it: nothing to pair with here.
    if (r.kind === 'add' && r.subject === self) return;
    if (r.kind === 'add') await this.addMemberNow(r.subject, r.name ?? 'device');
    else if (r.kind === 'remove') await this.removeMemberNow(r.subject);
    else if (r.kind === 'revoke-link' && !(await this.revokedLinks()).includes(r.subject)) await this.git.run(['config', '--add', 'kuraa.revokedlinks', r.subject]);
    // rules, signs, vouch, revoke-key: kept as they are, and read from the records.
  }

  /**
   * A change this device makes: signed with its key, kept, applied here, and
   * passed on. Any device may make one; each other device takes it or not by its
   * own rule (records.ts, judge).
   */
  decide(kind: RecordKind, subject: string, extra: { name?: string; rules?: string; proof?: string; keyProof?: string; person?: string } = {}): Promise<MemberRecord> {
    return this.serial(async () => {
      const ws = await this.workspace();
      if (!ws) throw new Error('This repository is not a workspace shared between devices');
      const r = signRecord({ kind, workspace: ws.id, subject, ...extra }, await this.deviceKey());
      await this.keepRecord(r);
      await this.apply(r);
      return r;
    });
  }

  /**
   * Records from another device: each taken if this device may (records.ts,
   * judge), until no more can be (an add may make another's signer known).
   * Returns those taken.
   */
  takeRecords(list: unknown[]): Promise<MemberRecord[]> {
    return this.serial(async () => {
      const known = new Set((await this.records()).map((r) => r.sig));
      let waiting = list.map(readRecord).filter((r): r is MemberRecord => !!r && !known.has(r.sig));
      const taken: MemberRecord[] = [];
      if (!waiting.length) return taken;
      // What this device knows, read once and kept up to date as records are taken.
      const standing = await this.standing();
      for (let progress = true; progress && waiting.length;) {
        progress = false;
        const next: MemberRecord[] = [];
        for (const r of waiting) {
          const verdict = judge(r, standing);
          if (verdict === 'take') {
            await this.keepRecord(r);
            await this.apply(r);
            if (r.kind === 'add' && r.subject !== standing.self && !standing.removed.has(r.subject)) standing.members.add(r.subject);
            else if (r.kind === 'remove') {
              standing.members.delete(r.subject);
              standing.removed.add(r.subject);
            }
            taken.push(r);
            progress = true;
          } else if (verdict === 'wait') next.push(r);
        }
        waiting = next;
      }
      return taken;
    });
  }

  // Invitations ------------------------------------------------------------

  private get invitesFile(): string {
    return join(this.stateDir, 'invites.json');
  }

  private async invites(): Promise<{ token: string; expires: number }[]> {
    try {
      return (JSON.parse(await readFile(this.invitesFile, 'utf8')) as { token: string; expires: number }[]).filter((i) => i.expires > Date.now());
    } catch {
      return [];
    }
  }

  /** Make a one-time invitation, good for `hours`. Returns its token. */
  async invite(hours = 24): Promise<string> {
    const token = randomBytes(16).toString('hex');
    const list = await this.invites();
    // Only a hash is kept: the file does not let anyone join.
    list.push({ token: createHash('sha256').update(token).digest('hex'), expires: Date.now() + hours * 3600_000 });
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.invitesFile, JSON.stringify(list), { mode: 0o600 });
    return token;
  }

  // Subscription links ------------------------------------------------------

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
   * Make a subscription link: anyone with it can join the workspace as a full
   * device, any number of times, until it expires (`hours`; null: never) or is
   * revoked. Signed with this device's key, so any member can check it.
   */
  async createLink(hours: number | null): Promise<string> {
    const ws = await this.workspace();
    if (!ws) throw new Error('This repository is not a workspace shared between devices');
    const key = await this.deviceKey();
    const id = randomBytes(8).toString('hex');
    const expires = hours === null ? 0 : Date.now() + hours * 3600_000;
    const issuer = key.publicKey.toString('hex');
    const through = await this.cameInThrough();
    const rules = await this.rules();
    const signature = crypto.sign(linkMessage(ws.id, id, expires, issuer, through, rules), key.secretKey).toString('hex');
    const list = await this.links();
    list.push({ id, expires, created: Date.now() });
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.linksFile, JSON.stringify(list), { mode: 0o600 });
    return encodeLink({ workspace: ws, issuer: { key: issuer, name: await this.deviceName() }, through, id, expires, signature, rules });
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

  /** Revoke a link, on record (passed on to the others): no device lets anyone join by it any more (those who did stay). */
  async revokeLink(id: string): Promise<void> {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('Not a link id');
    await this.decide('revoke-link', id);
  }

  async revokedLinks(): Promise<string[]> {
    return this.getAll('kuraa.revokedlinks');
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

  /** Use up an invitation; whether it was good. */
  async redeem(token: string): Promise<boolean> {
    const hash = createHash('sha256').update(token).digest('hex');
    const list = await this.invites();
    const left = list.filter((i) => i.token !== hash);
    if (left.length === list.length) return false;
    await writeFile(this.invitesFile, JSON.stringify(left), { mode: 0o600 });
    return true;
  }
}

/** A subscription link as the device that made it keeps it. */
export interface IssuedLink {
  id: string;
  /** When it stops working (ms since 1970); 0: never. */
  expires: number;
  created: number;
}

/** What a subscription link carries: the workspace, the device that made it, and its signature. */
export interface SubscriptionLink {
  workspace: WorkspaceIdentity;
  issuer: Member;
  /** The devices the issuer came into the workspace through, back to the first (Identity.cameInThrough). */
  through: string[];
  id: string;
  expires: number;
  /** The issuer's signature over the workspace id, link id, expiry, issuer key, the devices it came in through, and the rules, hex. */
  signature: string;
  /** Whose work its maker accepts on its own: the device joining starts with the same rules, its own to change. */
  rules: AcceptRules;
}

const linkMessage = (workspace: string, id: string, expires: number, issuer: string, through: string[], rules: AcceptRules) =>
  Buffer.from(`kuraa-link\0${workspace}\0${id}\0${expires}\0${issuer}\0${through.join(',')}\0${canonicalRules(rules)}`);

export function encodeLink(l: SubscriptionLink): string {
  const payload = [l.workspace.id, l.workspace.secret, l.workspace.forkedFrom ?? '', l.issuer.key, l.issuer.name, l.id, String(l.expires), l.signature, encodeRules(l.rules), l.through.join(',')].join('|');
  return `kuraa-link:${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeLink(code: string): SubscriptionLink {
  const m = /^kuraa-link:([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('Not a subscription link (it starts with kuraa-link:)');
  const [id, secret, forkedFrom, key, name, linkId, expires, signature, rulesField, throughField] = Buffer.from(m[1]!, 'base64url').toString('utf8').split('|');
  const rules = decodeRules(rulesField);
  const through = throughField ? throughField.split(',') : [];
  if (!id || !secret || !key || !name || !linkId || !signature || !rules || throughField === undefined || !hex.test(id) || !hex.test(secret) || !hex.test(key) || !/^[0-9a-f]{16}$/.test(linkId) || !/^\d+$/.test(expires ?? '') || !hex.test(signature)
    || through.some((k) => !/^[0-9a-f]{64}$/.test(k))) {
    throw new Error('This subscription link is damaged');
  }
  return { workspace: { id, secret, forkedFrom: forkedFrom || null }, issuer: { key, name }, through, id: linkId, expires: Number(expires), signature, rules };
}

/**
 * Why a link does not let a device join this workspace, or null if it does:
 * it is for this workspace, made by a device this one accepts links from, signed
 * by it, not expired and not revoked.
 */
export function checkLink(l: SubscriptionLink, o: { workspace: string; issuers: string[]; revoked: string[]; now?: number }): string | null {
  if (l.workspace.id !== o.workspace) return 'the link is for another workspace';
  if (!o.issuers.includes(l.issuer.key)) return 'the link was made by a device this one does not take links from';
  if (!linkSigned(l)) return 'the link is not signed by the device it names';
  if (l.expires !== 0 && l.expires < (o.now ?? Date.now())) return 'the link has expired';
  if (o.revoked.includes(l.id)) return 'the link was revoked';
  return null;
}

/** Whether a link is as the device it names made it: its signature over all it says but the workspace's secret. */
export function linkSigned(l: SubscriptionLink): boolean {
  return crypto.verify(linkMessage(l.workspace.id, l.id, l.expires, l.issuer.key, l.through, l.rules), Buffer.from(l.signature, 'hex'), Buffer.from(l.issuer.key, 'hex'));
}

/** What an invitation carries: the workspace, who invited, and the one-time token. */
export interface Invitation {
  workspace: WorkspaceIdentity;
  /** The inviting device's key, hex, and name. */
  inviter: Member;
  token: string;
  /** Whose work the inviting device accepts on its own: the device joining starts with the same. */
  rules: AcceptRules;
}

export function encodeInvitation(inv: Invitation): string {
  const payload = [inv.workspace.id, inv.workspace.secret, inv.workspace.forkedFrom ?? '', inv.inviter.key, inv.inviter.name, inv.token, encodeRules(inv.rules)].join('|');
  return `kuraa-invite:${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeInvitation(code: string): Invitation {
  const m = /^kuraa-invite:([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('Not an invitation (it starts with kuraa-invite:)');
  const [id, secret, forkedFrom, key, name, token, rulesField] = Buffer.from(m[1]!, 'base64url').toString('utf8').split('|');
  const rules = decodeRules(rulesField);
  if (!id || !secret || !key || !name || !token || !rules || !hex.test(id) || !hex.test(secret) || !hex.test(key) || !hex.test(token)) throw new Error('This invitation is damaged');
  return { workspace: { id, secret, forkedFrom: forkedFrom || null }, inviter: { key, name }, token, rules };
}
