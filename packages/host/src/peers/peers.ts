// The host as one of a workspace's devices (see docs/decisions/0028-peers.md).
//
// Git between devices: when a device connects, or says its branches moved, this
// one fetches them (into `<device>/<branch>`) and brings them into its own
// branches: a fast-forward, or a merge made as every device makes it (0025), so
// devices converge without merging each other's merges. When this device's
// branches move, it tells the others. Rooms across devices: rooms.ts.
//
// Whose work comes in on its own is this device's choice (accept.ts, 0032): by
// default every member's, on every branch; on a branch with a rule, only the
// devices it names, and others' work waits as a proposal until someone here
// accepts it. With a sync remote chosen (an ordinary git remote: GitHub, say;
// `kuraa.syncremote`), the device also syncs with it, after its commits and every
// few minutes.
import { describeOutcome, type Host } from '../host.js';
import { HttpError } from '../errors.js';
import { commitSigner } from '../signing.js';
import { isAncestor } from '../merging.js';
import type { PeerLink } from './link.js';
import { PeerNode } from './node.js';
import { encodeInvitation } from './identity.js';
import { Rooms } from './rooms.js';
import { acceptsBranch, acceptsPath, ruleFor, type AcceptRule } from './accept.js';
import type { Person } from './person.js';
import type { KeyPair } from '../keys.js';

export interface PeerOptions {
  /** DHT bootstrap nodes (`host:port`): a private network, or tests. Default: Hyperswarm's public ones. */
  bootstrap?: (string | { host: string; port: number })[];
  /** The most one fetch from a device may bring, in bytes. */
  maxFetchBytes?: number;
  /** How often to sync with the sync remote, in ms (default 5 minutes). */
  remoteSyncMs?: number;
  /** This computer's person's identity (person.ts); default: the one this computer keeps, if any. Tests give their own. */
  person?: Person | null;
  /** This computer's signing key (person.ts); default: the one this computer keeps, made on first use. Tests give their own. */
  signing?: KeyPair;
}

export interface DeviceInfo {
  name: string;
  key: string;
  online: boolean;
  /**
   * It merges differently from this device (another version of kuraa, say).
   * Between the two, only the one with the lower key makes merges; the other
   * takes them, so their histories never part.
   */
  otherVersion: boolean;
  /** A fork of this workspace, or the workspace this one was forked from: fetched from, never merged on its own. */
  related: boolean;
}

export interface Proposal {
  device: string;
  branch: string;
  /** Commits it has that this device's branch does not. */
  commits: number;
  subject: string;
}

export interface PeersStatus {
  device: { name: string; key: string };
  workspace: { id: string; forkedFrom: string | null };
  /** The ordinary git remote Sync uses (GitHub, say), if one is chosen. */
  remote: string | null;
  /** Where this device accepts only some devices' or people's work on its own ('' the whole branch, 'dir/' a folder, else a file), and whose (names). */
  rules: { branch: string; path: string; from: string[] }[];
  /** Files where another device's version differs and this device's rules keep its own: to take, or leave. */
  declined: { device: string; branch: string; path: string }[];
  /** Whose changes to the members it accepts (names); null: every member's. */
  membership: string[] | null;
  devices: DeviceInfo[];
  proposals: Proposal[];
}

/** Bring a device's work in (merging if need be), only by fast-forward, or hold it as a proposal. */
type Policy = 'merge' | 'fast-forward' | 'hold';

/**
 * Whether these rules keep this device's own version of a file against one with
 * these identities: the rule that counts for it is one for a folder or file (not
 * the whole branch: that holds work as a proposal instead), and does not name them.
 */
function declines(rules: AcceptRule[], who: string[], branch: string, path: string): boolean {
  const r = ruleFor(rules, branch, path);
  return !!r && r.path !== '' && !r.from.some((k) => who.includes(k));
}

export class Peers {
  readonly node: PeerNode;
  readonly rooms: Rooms;
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  /** Work waiting on a device that merges differently, already logged: `remote/branch`. */
  private readonly waiting = new Set<string>();
  /** Merge commits checked (mergeChanged): the files each has otherwise than this device's merge of its parents. */
  private readonly merges = new Map<string, string[]>();
  private announceTimer: NodeJS.Timeout | undefined;
  private remoteTimer: NodeJS.Timeout | undefined;
  private remoteSoon: NodeJS.Timeout | undefined;
  private stopRefs: (() => void) | null = null;
  private closed = false;

  constructor(private readonly host: Host, private readonly opts: PeerOptions, stateDir: string) {
    this.node = new PeerNode({
      dir: host.dir,
      git: host.git,
      stateDir,
      bootstrap: opts.bootstrap,
      maxFetchBytes: opts.maxFetchBytes,
      branch: () => host.git.branch(),
      log: (m) => host.log(m),
      merges: host.mergeSignature,
      person: opts.person,
      signing: opts.signing,
    }, {
      accepted: (link) => {
        this.rooms.connected(link);
        this.syncFrom(link);
      },
      closed: (link) => this.rooms.disconnected(link),
      refs: (link) => this.syncFrom(link),
      room: (link, m) => this.rooms.message(link, m),
      // Records came in (rules, people): the rooms judge by what they say.
      members: () => void this.rooms.refresh().catch((e: Error) => host.log(`peers: rules not read: ${e.message}`)),
    });
    this.rooms = new Rooms(host, this.node);
  }

  async start(): Promise<void> {
    await this.node.start(true);
    this.stopRefs = this.host.onRefsChanged(() => this.announce());
    const every = this.opts.remoteSyncMs ?? 5 * 60_000;
    this.remoteTimer = setInterval(() => void this.syncRemoteQuietly(), every);
    this.remoteTimer.unref();
  }

  /** Tell the other devices this one's branches moved (soon, once for a burst), and the sync remote. */
  private announce(): void {
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => this.node.broadcast({ type: 'refs' }), 200);
    clearTimeout(this.remoteSoon);
    this.remoteSoon = setTimeout(() => void this.syncRemoteQuietly(), 30_000);
    this.remoteSoon.unref();
  }

  private async syncRemoteQuietly(): Promise<void> {
    if (this.closed) return;
    // Only a sync remote chosen for this workspace, not origin by default.
    const chosen = await this.node.identity.syncRemote();
    const remote = await this.host.syncRemoteName();
    if (!chosen || !remote || chosen !== remote) return;
    await this.host.serial(() => this.host.syncWith(remote)).catch((e: Error) => this.host.log(`peers: syncing with ${remote} failed: ${e.message}`));
  }

  /** Fetch from a device and bring its work in; one at a time per device, again if asked meanwhile. */
  syncFrom(link: PeerLink): Promise<void> {
    if (this.closed) return Promise.resolve();
    const remote = link.remote!;
    const running = this.fetching.get(remote);
    if (running) {
      this.again.add(remote);
      return running;
    }
    const run = (async () => {
      do {
        this.again.delete(remote);
        if (!(await this.node.fetch(remote))) return;
        if (link.hello?.workspace !== this.node.ws.id) return; // a fork: fetched, never merged on its own
        await this.rooms.settle(link);
        await this.bringIn(link);
      } while (this.again.has(remote) && !this.closed);
    })().catch((e: Error) => this.host.log(`peers: syncing with ${remote} failed: ${e.message}`)).finally(() => this.fetching.delete(remote));
    this.fetching.set(remote, run);
    return run;
  }

  /** Sync with every connected device now. */
  async syncAll(): Promise<string> {
    const links = [...this.node.links.values()].filter((l) => l.accepted);
    await Promise.all(links.map((l) => this.syncFrom(l)));
    return links.length ? `Synced with ${links.map((l) => l.remote).join(', ')}` : 'No other device is connected';
  }

  /**
   * What to do with a device's branch: bring it in, or hold it (a proposal).
   * It comes in if this device accepts the device it came from on that branch
   * (trusting what that device took in), or else if it accepts whoever signed
   * each commit it would bring (0034: signatures are people).
   */
  private async decision(device: string, branch: string, oid: string, rules: AcceptRule[]): Promise<Policy> {
    let ok = acceptsBranch(rules, await this.node.identity.identitiesOf(device), branch);
    if (!ok) {
      const commits = await this.commitsIn(oid, device);
      ok = commits.length > 0 && commits.every((c) => acceptsBranch(rules, c.who, branch));
    }
    if (!ok) return 'hold';
    // Two devices that merge differently would each make their own merge of the same
    // work, and their histories would part: the one with the lower key makes the merges.
    return this.node.mergesDiffer(device) && device < this.node.myKey ? 'fast-forward' : 'merge';
  }

  /**
   * The commits a device's branch would bring that this device has on none of
   * its branches: whose each is, and the files it changed. A commit is its
   * signer's (and the person whose that key is, unless revoked), or, unsigned,
   * the device's it came from. A merge is no one's where it is the merge any
   * device would make of its parents (merging.ts); where it differs from that,
   * the files it differs in are the device's it came from.
   */
  private async commitsIn(oid: string, device: string): Promise<{ who: string[]; paths: string[] }[]> {
    const id = this.node.identity;
    const out = await this.host.git.out(['log', '--no-renames', '--format=%x01%H %P', '--name-only', oid, '--not', '--branches']);
    const from = await id.identitiesOf(device);
    const commits: { who: string[]; paths: string[] }[] = [];
    for (const chunk of out.split('\x01').filter((c) => c.trim())) {
      const [head, ...paths] = chunk.trim().split('\n').filter(Boolean);
      const [hash, ...parents] = head!.split(' ').filter(Boolean);
      if (parents.length > 1) {
        const changed = await this.mergeChanged(hash!, parents);
        if (changed.length) commits.push({ who: from, paths: changed });
        continue;
      }
      const signer = await commitSigner(this.host.git, hash!);
      commits.push({ who: signer ? await id.identitiesOf(signer) : from, paths });
    }
    return commits;
  }

  /**
   * The files a merge commit has otherwise than the merge this device makes of
   * its parents: none, for a merge as every device makes it; those a room's text
   * or a kept version changed, or another version of kuraa merged otherwise, or
   * someone edited. (Of more than two parents, all it changed from the first.)
   */
  private async mergeChanged(commit: string, parents: string[]): Promise<string[]> {
    const known = this.merges.get(commit);
    if (known) return known;
    const changedFrom = async (base: string) => {
      const diff = await this.host.git.run(['diff', '--name-only', '--no-renames', '-z', base, commit], { allowFail: true });
      if (diff.code !== 0) throw new Error(diff.stderr.trim());
      return diff.stdout.split('\0').filter(Boolean);
    };
    let paths: string[];
    try {
      paths = await changedFrom(parents.length === 2 ? (await this.host.merge(parents[0]!, parents[1]!)).commit : parents[0]!);
    } catch (e) {
      // Not made again: all it changed from its first parent.
      this.host.log(`peers: could not check merge ${commit.slice(0, 7)} (${(e as Error).message}); its changes count as the device's it came from`);
      // Nor that: changes to no file known, but still the device's, so a rule for the branch holds it.
      paths = await changedFrom(parents[0]!).catch(() => ['']);
    }
    if (this.merges.size > 10_000) this.merges.clear();
    this.merges.set(commit, paths);
    return paths;
  }

  /**
   * Files on `branch` whose changes from a device this one does not take, by a
   * rule for a folder or file (accept.ts): neither from the device they came from
   * nor from whoever signed the commits that changed them. Their history comes
   * in, this device's version of those stays. Undefined if no such rule applies.
   */
  private async keepFor(device: string, branch: string, oid: string): Promise<((path: string) => boolean) | undefined> {
    const { rules } = await this.node.identity.rules();
    const from = await this.node.identity.identitiesOf(device);
    if (!rules.some((r) => r.branch === branch && r.path !== '' && !r.from.some((k) => from.includes(k)))) return undefined;
    const commits = await this.commitsIn(oid, device);
    return (path) => declines(rules, from, branch, path) && commits.some((c) => c.paths.includes(path) && !acceptsPath(rules, c.who, branch, path));
  }

  /** The branches a device has, from what was fetched. */
  private async branchesOf(remote: string): Promise<{ branch: string; oid: string }[]> {
    const out = await this.host.git.out(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/remotes/${remote}/`]);
    return out.split('\n').filter(Boolean).map((l) => {
      const [ref, oid] = l.split('\0');
      return { branch: ref!.slice(`refs/remotes/${remote}/`.length), oid: oid! };
    }).filter((b) => b.branch !== 'HEAD');
  }

  private async bringIn(link: PeerLink): Promise<void> {
    const remote = link.remote!;
    const { rules } = await this.node.identity.rules();
    for (const { branch, oid } of await this.branchesOf(remote)) {
      const p = await this.decision(link.key, branch, oid, rules);
      if (p === 'hold') continue;
      await this.bringBranch(branch, `refs/remotes/${remote}/${branch}`, oid, link, p === 'fast-forward');
    }
  }

  /**
   * Bring a commit into a branch: the checked-out one through the working tree,
   * others by their ref alone. `forwardOnly`: only if no merge is needed (the
   * other device will make it, and this one take it then).
   */
  private async bringBranch(branch: string, ref: string, oid: string, link: PeerLink | null, forwardOnly = false): Promise<void> {
    await this.host.serial(async () => {
      const current = await this.host.git.branch();
      const mine = (await this.host.git.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })).stdout.trim();
      const from = link?.remote ?? ref;
      if (forwardOnly && mine && !(await isAncestor(this.host.git, mine, oid))) {
        if (!this.waiting.has(`${from}/${branch}`)) this.host.log(`peers: ${from} merges differently from this device (another version of kuraa?); its work on ${branch} comes in once it has merged this device's`);
        this.waiting.add(`${from}/${branch}`);
        return;
      }
      this.waiting.delete(`${from}/${branch}`);
      const keep = link ? await this.keepFor(link.key, branch, oid) : undefined;
      if (branch === current) {
        const outcome = await this.host.integrate(ref, link ? this.rooms.override(link) : undefined, keep);
        if (outcome.kind !== 'same') this.host.log(`peers: brought in ${branch} from ${link?.remote ?? ref}${describeOutcome(outcome)}`);
        return;
      }
      if (!mine) {
        await this.host.git.run(['update-ref', `refs/heads/${branch}`, oid, '']);
        this.host.refsChanged();
        return;
      }
      const outcome = await this.host.merge(mine, oid, undefined, keep);
      if (outcome.commit !== mine) {
        await this.host.git.run(['update-ref', `refs/heads/${branch}`, outcome.commit, mine]);
        this.host.refsChanged();
      }
    });
  }

  /** Accept a device's held work on a branch (a proposal): bring it in. */
  async accept(device: string, branch: string): Promise<void> {
    const ref = `refs/remotes/${device}/${branch}`;
    const oid = await this.host.git.out(['rev-parse', '--verify', ref]);
    const link = [...this.node.links.values()].find((l) => l.remote === device) ?? null;
    await this.bringBranch(branch, ref, oid, link);
  }

  /** Take a device's version of a file this device's rules keep its own of (a declined file): put it here, and commit it. */
  async takeVersion(device: string, branch: string, path: string): Promise<void> {
    if (branch !== (await this.host.git.branch())) throw new HttpError(409, `${branch} is not the branch open here`);
    const ref = `refs/remotes/${device}/${branch}`;
    if ((await this.host.git.run(['rev-parse', '--verify', '-q', ref], { allowFail: true })).code !== 0) throw new HttpError(404, `Nothing from ${device} on ${branch}`);
    const theirs = await this.host.git.run(['show', `${ref}:${path}`], { allowFail: true });
    await this.host.serial(() => this.host.replaceFile(path, theirs.code === 0 ? theirs.stdout : null, `Take ${device}'s version of ${path}`));
  }

  /**
   * Devices (or people) that would not take this device's changes to a file:
   * those with a rule for it that does not name this device or its person, as
   * their rules were last published. For the editor to say so (0033).
   */
  async declinedBy(branch: string, path: string): Promise<string[]> {
    const id = this.node.identity;
    const me = await id.identitiesOf(this.node.myKey);
    const names = new Set<string>();
    for (const m of await id.members()) {
      const rules = (await id.rulesOf(m.key))?.rules;
      if (!ruleFor(rules, branch, path) || acceptsPath(rules, me, branch, path)) continue;
      names.add((await id.personOf(m.key))?.name || m.name);
    }
    return [...names];
  }

  /** Make a subscription link: anyone with it may join, until it expires or is revoked (CLI: kuraa-host link). */
  subscriptionLink(hours: number | null = 168): Promise<string> {
    return this.node.identity.createLink(hours);
  }

  /** The subscription links this device made, and whether each still lets people in. */
  async links(): Promise<{ id: string; created: number; expires: number; state: 'active' | 'expired' | 'revoked' }[]> {
    const revoked = await this.node.identity.revokedLinks();
    return (await this.node.identity.links()).map((l) => ({
      ...l,
      state: revoked.includes(l.id) ? 'revoked' : l.expires && l.expires < Date.now() ? 'expired' : 'active',
    }));
  }

  /** Revoke a subscription link, on record, and tell the other devices. */
  async revokeLink(id: string): Promise<void> {
    await this.node.identity.decide('revoke-link', id);
    await this.node.membersChanged();
  }

  /** Make an invitation for another device to join (CLI: kuraa-host invite). */
  async invitation(hours = 24): Promise<string> {
    const token = await this.node.identity.invite(hours);
    await this.node.refresh();
    return encodeInvitation({ workspace: this.node.ws, inviter: { key: this.node.myKey, name: this.node.name }, token, rules: await this.node.identity.rules() });
  }

  /** Files on the branch open here where a device's version differs and this device's rules keep its own. */
  private async declined(members: { name: string; key: string }[], rules: AcceptRule[]): Promise<{ device: string; branch: string; path: string }[]> {
    const branch = await this.host.git.branch();
    if (!rules.some((r) => r.branch === branch && r.path !== '')) return [];
    const out: { device: string; branch: string; path: string }[] = [];
    for (const m of members) {
      const ref = `refs/remotes/${m.name}/${branch}`;
      const diff = await this.host.git.run(['diff', '--name-only', '--no-renames', '-z', 'HEAD', ref], { allowFail: true });
      if (diff.code !== 0) continue;
      const who = await this.node.identity.identitiesOf(m.key);
      for (const path of diff.stdout.split('\0').filter(Boolean)) if (declines(rules, who, branch, path)) out.push({ device: m.name, branch, path });
    }
    return out;
  }

  async status(): Promise<PeersStatus> {
    const id = this.node.identity;
    const members = await id.members();
    const rules = await id.rules();
    const people = await id.people();
    const nameOf = (key: string) => (key === this.node.myKey ? this.node.name : members.find((m) => m.key === key)?.name ?? people.find((p) => p.key === key)?.name ?? `${key.slice(0, 8)}…`);
    const proposals: Proposal[] = [];
    for (const m of members) {
      const link = this.node.links.get(m.key);
      if (link?.hello && link.hello.workspace !== this.node.ws.id) continue;
      for (const { branch, oid } of await this.branchesOf(m.name)) {
        if ((await this.decision(m.key, branch, oid, rules.rules)) !== 'hold') continue;
        const count = await this.host.git.run(['rev-list', '--count', `refs/heads/${branch}..${oid}`], { allowFail: true });
        const commits = count.code === 0 ? Number(count.stdout.trim()) : Number((await this.host.git.out(['rev-list', '--count', oid])) || 0);
        if (commits > 0) proposals.push({ device: m.name, branch, commits, subject: await this.host.git.out(['log', '-1', '--format=%s', oid]) });
      }
    }
    return {
      device: { name: this.node.name, key: this.node.myKey },
      workspace: { id: this.node.ws.id, forkedFrom: this.node.ws.forkedFrom },
      remote: await this.host.syncRemoteName(),
      rules: rules.rules.map((r) => ({ branch: r.branch, path: r.path, from: r.from.map(nameOf) })),
      declined: await this.declined(members, rules.rules),
      membership: rules.membership?.map(nameOf) ?? null,
      devices: members.map((m) => {
        const link = this.node.links.get(m.key);
        return {
          name: m.name,
          key: m.key,
          online: !!link?.accepted,
          otherVersion: this.node.mergesDiffer(m.key),
          related: !!link?.hello && link.hello.workspace !== this.node.ws.id,
        };
      }),
      proposals,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.announceTimer);
    clearTimeout(this.remoteSoon);
    clearInterval(this.remoteTimer);
    this.stopRefs?.();
    // Let fetches under way finish, but not hold closing up for long.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.fetching.values()]), new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    this.rooms.close();
    await this.node.close();
  }
}
