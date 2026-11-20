// This device among the workspace's devices: finding them (Hyperswarm, by the
// workspace's topic), checking who they are, pairing new ones by invite link,
// sharing who the members are, and letting paired devices fetch from it.
//
// Who is let in: a paired device that has not been removed, and a device not
// yet paired that presents an invite link a member made (any member checks it).
// A device joining pairs with one the link's maker vouches for: the maker, or
// one its pairing records trace back to it (records.ts, traced). Records go
// only to paired devices. Membership spreads: a device paired with one member
// is paired by the others once that member vouches for it; every member has the
// same say (see docs/decisions/0028-peers.md and 0038).
import { devNull } from 'node:os';
import { join } from 'node:path';
import { writeAllowedSigners } from '../signing.js';
import { personFile, readPerson, revokedFile, revokedKeys, signingKey, type Person } from './person.js';
import type { KeyPair } from '../keys.js';
import { stat } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import Hyperswarm, { type SwarmConnection } from 'hyperswarm';
import { gitEnv, gitPath, spawnGit, type Git } from '../git.js';
import { GitBridge } from './bridge.js';
import { Identity, checkLink, decodeLink, topicFor, type Member, type WorkspaceIdentity } from './identity.js';
import { traced } from './records.js';
import { PeerLink, type ControlMessage } from './link.js';

export interface NodeOptions {
  /** The repository's working tree. */
  dir: string;
  git: Git;
  /** .git/kuraa */
  stateDir: string;
  /** DHT bootstrap nodes: a private network, or tests. Default: Hyperswarm's public ones. */
  bootstrap?: unknown[];
  /** The most one fetch from a device may bring, in bytes. Default 2 GiB. */
  maxFetchBytes?: number;
  /** The branch a joining device should start on. */
  branch(): Promise<string>;
  log(m: string): void;
  /** Joining: the invite link to present to the workspace's devices. */
  ticket?: string;
  /** Joining: any device the link's maker vouches for lets this one in. */
  joining?: boolean;
  /** How this device merges, told to the others (merging.ts, mergeSignature). */
  merges?: string;
  /** This computer's person's identity (person.ts); undefined: the one this computer keeps, if any. Tests give theirs. */
  person?: Person | null;
  /** This computer's signing key for its person; undefined: the one this computer keeps (made on first use). Tests give theirs. */
  signing?: KeyPair;
}

/** A DHT node, from `host:port` or as given. */
const bootstrapNode = (b: unknown) => (typeof b === 'string' ? { host: b.slice(0, b.lastIndexOf(':')), port: Number(b.slice(b.lastIndexOf(':') + 1)) } : b);

export interface NodeEvents {
  /** A device's hello was accepted: it can be fetched from, and talked to. */
  accepted?(link: PeerLink): void;
  closed?(link: PeerLink): void;
  /** A device says its branches changed. */
  refs?(link: PeerLink): void;
  /** A message about rooms. */
  room?(link: PeerLink, m: Extract<ControlMessage, { type: 'room' }>): void;
  /** The answer of the device that let this one in, when joining. */
  welcome?(link: PeerLink, m: Extract<ControlMessage, { type: 'welcome' }>): void;
  /** The members changed (a device paired or removed). */
  members?(): void;
  /** A device turned this one away, saying why. */
  refused?(link: PeerLink, reason: string): void;
}

export class PeerNode {
  readonly identity: Identity;
  ws!: WorkspaceIdentity;
  key!: KeyPair;
  name = '';
  readonly links = new Map<string, PeerLink>();
  private swarm: Hyperswarm | null = null;
  readonly bridge: GitBridge;
  // Kept for the firewall, which must answer at once.
  private removedKeys = new Set<string>();
  private closing = false;
  /** This computer's person's key as last read (from its file, unless given). */
  private personRead: { stamp: string; person: Person | null } | null = null;
  /** What this device last said in this workspace about its signing key and its person (syncPerson). */
  private saidFor: string | null = null;

  constructor(private readonly o: NodeOptions, readonly events: NodeEvents = {}) {
    this.identity = new Identity(o.git, o.stateDir);
    this.bridge = new GitBridge({
      stateDir: o.stateDir,
      maxBytes: o.maxFetchBytes ?? 2 * 1024 ** 3,
      log: o.log,
      open: (key, service, protocol) => {
        const link = this.links.get(key);
        if (!link?.accepted) return `the device ${key.slice(0, 8)}… is not connected`;
        return link.openGit(service, protocol);
      },
    });
  }

  get myKey(): string {
    return this.key.publicKey.toString('hex');
  }

  /** Start, as a device of the workspace this repository belongs to; `found` makes it one if it is not yet. */
  async start(found: boolean): Promise<void> {
    const ws = await this.identity.workspace();
    if (!ws && !found) throw new Error('This repository is not a workspace shared between devices yet');
    this.ws = ws ?? (await this.identity.found());
    this.key = await this.identity.deviceKey();
    this.name = await this.identity.deviceName();
    // Whose this device is, if this computer keeps a person's key: said in this workspace, with their signature.
    await this.syncPerson();
    await this.refresh();
    await this.bridge.start();
    this.swarm = new Hyperswarm({
      keyPair: this.key,
      ...(this.o.bootstrap ? { bootstrap: this.o.bootstrap.map(bootstrapNode) } : {}),
      firewall: (remote) => this.refuse(remote.toString('hex')),
    });
    this.swarm.on('connection', (conn) => this.connected(conn));
    // Paired devices are dialled directly too, as well as found by the topic.
    for (const m of await this.identity.members()) this.swarm.joinPeer(Buffer.from(m.key, 'hex'));
    this.swarm.join(topicFor(this.ws.secret), { server: true, client: true });
    // A fork still meets the devices of the workspace it came from, to fetch from them by hand.
    const origin = await this.identity.originSecret();
    if (origin) this.swarm.join(topicFor(origin), { server: true, client: true });
    this.o.log(`peers: this device is ${this.name} (${this.myKey.slice(0, 8)}…) in workspace ${this.ws.id.slice(0, 8)}…`);
  }

  /**
   * This computer's person's key, if it keeps one (person.ts): read again when
   * its file changes, so a key made or imported while the host runs is used from
   * its next commit. Tests give theirs (NodeOptions.person).
   */
  async person(): Promise<Person | null> {
    if (this.o.person !== undefined) return this.o.person;
    const file = personFile();
    let stamp = '';
    try {
      const st = await stat(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* none */ }
    if (this.personRead?.stamp !== stamp) this.personRead = { stamp, person: stamp ? await readPerson(file) : null };
    return this.personRead.person;
  }

  /** This computer's signing key, for its person (person.ts: made on first use, never copied; read each time, as importing an identity replaces it). Tests give theirs. */
  private signingKeyNow(): Promise<KeyPair> {
    return this.o.signing ? Promise.resolve(this.o.signing) : signingKey();
  }

  /**
   * Say in this workspace which key this device's commits are signed with (with
   * that key's signature) and, if this computer keeps its person's identity,
   * that the key is theirs and which of their keys they revoked (with their
   * signature): again when any of that changes. Whether anything was said.
   */
  private async syncPerson(): Promise<boolean> {
    const key = await this.signingKeyNow();
    const person = await this.person();
    let revokedStamp = '';
    try {
      const st = await stat(revokedFile());
      revokedStamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* none */ }
    const said = `${key.publicKey.toString('hex')}:${person ? `${person.publicKey.toString('hex')}:${person.name}` : ''}:${revokedStamp}`;
    if (said === this.saidFor) return false;
    await this.identity.signsWith(key);
    if (person) {
      await this.identity.vouch(person, key);
      const p = person.publicKey.toString('hex');
      for (const r of await revokedKeys()) await this.identity.revokeKey(p, r.key, r.proof);
    }
    this.saidFor = said;
    return true;
  }

  /**
   * The key the commits made here are signed with (0035): this computer's
   * signing key for its person, vouched for by their identity if this computer
   * keeps it. A host is one person, whoever edits through it.
   */
  async signingKey(): Promise<KeyPair> {
    if (await this.syncPerson()) void this.membersChanged().catch(() => undefined);
    return this.signingKeyNow();
  }

  /** Read the removed devices again (after a change), and tell git which keys sign for which devices. */
  async refresh(): Promise<void> {
    this.removedKeys = new Set(await this.identity.removed());
    // The keys commits here are signed with, named by their person (or device), as git checks them.
    const signers: { name: string; key: string }[] = [];
    for (const d of [{ key: this.myKey, name: this.name }, ...(await this.identity.members())]) {
      const key = await this.identity.signingKeyOf(d.key);
      if (key) signers.push({ name: (await this.identity.personOf(key))?.name || d.name, key });
    }
    await writeAllowedSigners(this.o.git, join(this.o.stateDir, 'allowed_signers'), signers).catch((e: Error) => this.o.log(`peers: allowed signers: ${e.message}`));
  }

  /** Pair with a device this one lets in (by an invite link), on record so the others pair with it too. */
  private async admit(key: string, name: string): Promise<string | null> {
    if ((await this.identity.removed()).includes(key)) return null;
    await this.identity.decide('add', key, { name });
    return (await this.identity.members()).find((m) => m.key === key)?.name ?? null;
  }

  /**
   * Whether to turn a device away before it says anything: a removed one. Only
   * devices that know the workspace's secret find it at all; any other device
   * not paired is turned away after its hello, unless it brings an invite link.
   */
  private refuse(key: string): boolean {
    return this.closing || this.removedKeys.has(key);
  }

  private connected(conn: SwarmConnection): void {
    const key = conn.remotePublicKey.toString('hex');
    this.links.get(key)?.close();
    const link: PeerLink = new PeerLink(conn, () => {
      if (this.links.get(key) === link) this.links.delete(key);
      if (link.accepted) this.events.closed?.(link);
    });
    this.links.set(key, link);
    link.onMessage((m) => void this.message(link, m).catch((e: Error) => this.o.log(`peers: ${e.message}`)));
    link.onGit((service, protocol, stream) => this.serveGit(link, service, protocol, stream));
    void this.helloFor(link).then((h) => link.send(h));
  }

  private async helloFor(link: PeerLink): Promise<ControlMessage> {
    const shown = await this.linkToShow();
    const paired = link.accepted || (await this.identity.members()).some((m) => m.key === link.key);
    return {
      type: 'hello',
      workspace: this.ws.id,
      forkedFrom: this.ws.forkedFrom,
      name: this.name,
      // Who is in, and who people are: nothing for a device not known yet (it may never be let in).
      records: paired ? await this.identity.records() : [],
      merges: this.o.merges ?? '',
      // A device that came in by a link shows it to devices that may not know it yet.
      ...(shown ? { link: shown } : {}),
    };
  }

  private async linkToShow(): Promise<string | null> {
    return this.o.ticket ?? this.identity.joinedLink();
  }

  /** Why an invite link does not let a device in here, or null if it does. */
  private async refuseLink(code: string): Promise<string | null> {
    let l;
    try {
      l = decodeLink(code);
    } catch (e) {
      return (e as Error).message;
    }
    // Any member's links (0038).
    const members = [this.myKey, ...(await this.identity.members()).map((m) => m.key)];
    return checkLink(l, { workspace: this.ws.id, members, revoked: await this.identity.revokedLinks() });
  }

  /**
   * Whether a device merges differently from this one (another version of
   * kuraa, or other document types): only one of the two may then make the
   * merges between them. Unknown until it has said hello.
   */
  mergesDiffer(key: string): boolean {
    const hello = this.links.get(key)?.hello;
    return !!hello && hello.merges !== (this.o.merges ?? '');
  }

  private async message(link: PeerLink, m: ControlMessage): Promise<void> {
    if (m.type === 'hello') return this.hello(link, m);
    if (m.type === 'welcome') return this.welcomed(link, m);
    if (!link.accepted) return;
    if (m.type === 'refs') this.events.refs?.(link);
    else if (m.type === 'room') this.events.room?.(link, m);
    else if (m.type === 'bye') {
      this.o.log(`peers: ${link.remote ?? link.key.slice(0, 8)} left: ${m.reason}`);
      this.events.refused?.(link, String(m.reason));
      link.close();
    }
  }

  private async hello(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    // Again, from a device already accepted: what it now knows of the members.
    if (link.accepted) {
      link.hello = h;
      if (h.workspace === this.ws.id) await this.gossip(link, h);
      return;
    }
    const bye = (reason: string) => {
      link.send({ type: 'bye', reason });
      setTimeout(() => link.close(), 100);
    };
    if (this.removedKeys.has(link.key)) return bye('this device was removed from the workspace');
    const same = h.workspace === this.ws.id;
    // A fork and the workspace it came from may fetch from each other; neither brings the other's work in on its own.
    const related = (h.forkedFrom ?? '').startsWith(`${this.ws.id}@`) || (this.ws.forkedFrom ?? '').startsWith(`${h.workspace}@`);
    if (!same && !related) return bye('another workspace');
    let member: Member | undefined = (await this.identity.members()).find((x) => x.key === link.key);
    if (!member && this.o.joining) {
      // Joining: a device of the workspace may let this one in; it is paired with
      // once its welcome shows the link's maker vouches for it (welcomed).
      if (same && this.o.ticket) {
        link.hello = h;
        return;
      }
      return bye('not paired with this device');
    }
    if (!member) {
      if (!same || typeof h.link !== 'string') return bye('not paired with this device');
      const why = await this.refuseLink(h.link);
      if (why) return bye(`not paired with this device, and ${why}`);
      const l = decodeLink(h.link);
      const name = await this.admit(link.key, h.name);
      if (!name) return bye('this device was removed from the workspace');
      // A link for one person lets one device in: used up, on record, so no other device lets anyone else in by it.
      if (l.once) await this.identity.useLink(l.id);
      const how = `by invite link ${l.id}${l.once ? ', now used' : ''}`;
      member = { key: link.key, name };
      await this.refresh();
      this.o.log(`peers: paired with ${name} (${link.key.slice(0, 8)}…), ${how}`);
      const members = (await this.identity.members()).filter((x) => x.key !== link.key);
      link.send({ type: 'welcome', name: this.name, members: members.map((x) => ({ key: x.key, name: x.name })), branch: await this.o.branch(), records: await this.identity.records() });
      void this.membersChanged(link);
    }
    link.accepted = true;
    link.remote = member.name;
    link.hello = h;
    if (same) await this.gossip(link, h);
    this.events.accepted?.(link);
  }

  /**
   * A device let this one in (joining). The link's maker is paired already.
   * Any other must show, by the records it sends, that
   * the link's maker vouches for it (traced from the maker and the devices it
   * came in through, as the link says, signed): someone who only knows the
   * workspace's secret, from an old link, say, does not get to be the device
   * this one starts from. Then its records are taken, and the members it names
   * that are vouched for in the same way.
   */
  private async welcomed(link: PeerLink, m: Extract<ControlMessage, { type: 'welcome' }>): Promise<void> {
    if (!this.o.joining) return;
    const records = Array.isArray(m.records) ? m.records : [];
    let members = Array.isArray(m.members) ? m.members : [];
    if (!link.accepted) {
      const t = this.o.ticket;
      if (!t || !link.hello || link.hello.workspace !== this.ws.id) return;
      const l = decodeLink(t);
      const known = traced([l.issuer.key, ...l.through], records, this.ws.id);
      if (!known.has(link.key)) {
        this.o.log(`peers: ${link.hello.name} (${link.key.slice(0, 8)}…) offered to let this device in, but the link's maker does not vouch for it; not joining through it`);
        link.close();
        return;
      }
      const name = await this.identity.addMember(link.key, link.hello.name);
      if (!name) return;
      link.accepted = true;
      link.remote = name;
      members = members.filter((x) => known.has(x.key));
    }
    await this.takeRecords(link, records);
    this.events.welcome?.(link, { ...m, members });
  }

  /** Take in what a member says about who else is (or is no longer) in the workspace. */
  private async gossip(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    if (Array.isArray(h.records)) await this.takeRecords(link, h.records);
  }

  /** Signed records (records.ts): each taken if its signer may make it, whoever passed it on. */
  private async takeRecords(link: PeerLink, records: unknown[]): Promise<void> {
    const taken = await this.identity.takeRecords(records);
    if (!taken.length) return;
    if (taken.some((r) => r.kind === 'remove' && r.subject === this.myKey)) {
      this.o.log('peers: this device was removed from the workspace; not syncing');
      await this.close();
      return;
    }
    for (const r of taken) {
      const who = (await this.identity.members()).find((m) => m.key === r.by)?.name ?? (r.by === this.myKey ? 'this device' : `${r.by.slice(0, 8)}…`);
      if (r.kind === 'add') {
        if (r.subject === this.myKey) continue;
        this.o.log(`peers: ${who} paired ${r.name ?? 'a device'} (${r.subject.slice(0, 8)}…)`);
        this.swarm?.joinPeer(Buffer.from(r.subject, 'hex'));
      } else if (r.kind === 'remove') {
        this.links.get(r.subject)?.close();
        this.o.log(`peers: ${who} removed ${r.subject.slice(0, 8)}…`);
      } else if (r.kind === 'revoke-link') this.o.log(`peers: ${who} ${r.name === 'used' ? 'let someone in by' : 'revoked'} invite link ${r.subject}`);
      else this.o.log(`peers: ${who} acts for ${r.name ?? 'someone'}`);
    }
    await this.membersChanged(link);
  }

  /** The members changed: tell the other devices (not `except`, which told this one). */
  async membersChanged(except?: PeerLink): Promise<void> {
    await this.refresh();
    for (const l of this.links.values()) if (l.accepted && l !== except) l.send(await this.helloFor(l));
    this.events.members?.();
  }

  /** Let a paired device fetch: `git upload-pack`, nothing that writes. */
  private serveGit(link: PeerLink, service: string, protocol: string, stream: Duplex): void {
    if (!link.accepted || service !== 'git-upload-pack') return void stream.destroy();
    const child = spawnGit(['upload-pack', '--strict', '--timeout=600', join(this.o.dir, '.git')], {
      env: gitEnv(protocol ? { GIT_PROTOCOL: protocol } : {}),
      detached: false,
    });
    child.stderr.resume();
    stream.pipe(child.stdin);
    child.stdout.pipe(stream);
    child.on('error', () => stream.destroy());
    stream.on('error', () => child.kill());
    stream.on('close', () => child.kill());
  }

  private readonly fetches = new Map<string, Promise<boolean>>();

  /** Fetch a paired device's branches into `<its remote>/…`, one fetch per device at a time. Returns whether it worked. */
  fetch(remote: string): Promise<boolean> {
    const before = this.fetches.get(remote) ?? Promise.resolve(true);
    const run = before.catch(() => false).then(() => this.fetchNow(remote));
    this.fetches.set(remote, run);
    void run.finally(() => {
      if (this.fetches.get(remote) === run) this.fetches.delete(remote);
    });
    return run;
  }

  private async fetchNow(remote: string): Promise<boolean> {
    if (this.closing) return false;
    const r = await this.o.git.run([
      '-c', `core.hooksPath=${devNull}`, '-c', 'fetch.recurseSubmodules=false', '-c', 'protocol.version=2',
      'fetch', '--prune', '--no-write-fetch-head', remote,
    ], { allowFail: true, timeoutMs: 10 * 60_000, env: { PATH: gitPath(this.bridge.binDir) } });
    if (r.code !== 0 && !this.closing) this.o.log(`peers: fetching from ${remote} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.code === 0;
  }

  /** Tell every connected device something. */
  broadcast(m: ControlMessage): void {
    for (const link of this.links.values()) if (link.accepted) link.send(m);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const link of this.links.values()) link.close();
    await this.swarm?.destroy();
    await this.bridge.close();
  }
}
