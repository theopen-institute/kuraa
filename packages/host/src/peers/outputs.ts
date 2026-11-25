// Run outputs shared between a workspace's devices (docs/decisions/0058-shared-outputs.md,
// 0062-outputs-as-they-happen.md).
//
// Outputs are never written into a document (0011), and each device caches the
// latest run of each chunk in .git/kuraa/outputs. To let the other devices see
// them, each device publishes its cache as a commit of its own ref,
// `refs/kuraa/outputs/<device key>`: outside the branches (never checked out,
// merged, pushed to backups or to the online copy), with no parent (each
// publish replaces the last, so nothing piles up: git's cleanup takes what no
// ref holds any more), and signed with the device's signing key, as its commits
// are. Devices fetch each other's outputs refs, keep the newest of each
// device's they hear of (directly or passed on by another), and show them
// beside their own. A device writes only its own ref, so two never conflict.
//
// The tree of an outputs commit:
//
//   runs/<sha1 of the path>/<run id>.json   a finished run (RunRecord), images out of line
//   images/<sha256 of the bytes>            a plot, as its bytes; one blob however many runs show it
//   hidden.json                             { ids }: runs of other devices cleared here
//
// Clearing an output another device made hides it here and, through
// hidden.json, on every device; the device that made it forgets it when it
// hears.
//
// As they happen (0062): each run's changes (queued, running, finished,
// cancelled), and clearing, also go at once to the devices connected to this
// one, on the link's outputs channel (link.ts), to those with the document
// open for runs. The device that ran it is the one sending: the link proves
// it. What comes this way is kept beside that device's outputs commit (its
// live layer) until a commit of its holds it, and runs under way only until
// they finish or the device goes. Git stays what every device ends up with:
// for a device that was not connected, or did not have the document open.
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChunkOutput, ChunkRef, RunRecord } from '@kuraa/session/server';
import type { Git } from '../git.js';
import type { KeyPair } from '../keys.js';
import type { OutputsFrame } from './link.js';
import { renameOver } from '../files.js';
import { signCommitObject, splitSignature, sshSigner } from '../signing.js';
import { checkMadeFrom } from '../madefrom.js';

/** Each device's outputs: `refs/kuraa/outputs/<device key>`. */
export const OUTPUTS = 'refs/kuraa/outputs/';
/** Where a fetch from a device puts the outputs refs it has, before they are checked and taken. */
export const fetchedFrom = (remote: string) => `refs/kuraa/fetched/${remote}/`;
/** The refspec that fetches them. */
export const outputsRefspec = (remote: string) => `+${OUTPUTS}*:${fetchedFrom(remote)}*`;

/** The most a device publishes, in bytes (runs and plots): the newest runs first, until it is reached. */
export const MAX_SHARED_BYTES = 64 * 1024 * 1024;
/** The most one run sent as it happens may carry, in bytes (its plots too): a larger one reaches the others by git only. */
export const MAX_LIVE_BYTES = 8 * 1024 * 1024;
/** The most runs of a device kept as they came, until a commit of its holds them. */
const MAX_LIVE_RUNS = 500;
/**
 * A run that came as it happened, and finished this long before a commit of
 * its device that does not hold it, is gone there (cleared, or left out), in
 * ms. A run that finished just before is not: the commit may have been made
 * before it was cached.
 */
const LIVE_SLACK_MS = 2000;
/** The most runs of other devices a device keeps cleared. */
const MAX_HIDDEN = 2000;
/** The largest run read from another device, in bytes (without its plots). */
const MAX_RUN_BYTES = 32 * 1024 * 1024;

const ID = /^[\w-]{1,64}$/;
const KEY = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FINISHED = new Set(['done', 'failed', 'interrupted']);
const PENDING = new Set(['queued', 'running']);
/** The states a run sent as it happens may be in. */
const LIVE_STATES = new Set([...FINISHED, ...PENDING, 'cancelled']);
const TEXTS = new Set(['text', 'message', 'warning', 'error', 'note']);

/** A plot as published: its bytes are in `images/<blob>`. */
type StoredImage = Extract<ChunkOutput, { type: 'image' }> & { blob: string };

/** One device's published outputs, as read. */
interface DeviceOutputs {
  key: string;
  /** The outputs commit. */
  oid: string;
  /** When it was published (seconds): the newest of a device's wins. */
  at: number;
  /** Runs by document path, plots out of line. */
  runs: Map<string, RunRecord[]>;
  /** Runs by the blob they were read from: not read again from the device's next commit. */
  byBlob: Map<string, RunRecord>;
  /** Plots: sha256 → blob. */
  images: Map<string, string>;
  hidden: Set<string>;
}

/** What came from a device as it happened, beside its outputs commit. */
interface Live {
  /** Finished runs, plots in line, by id: until a commit of the device holds them. */
  runs: Map<string, RunRecord>;
  /** Runs queued or running there, by id: until they finish, or the device goes. */
  pending: Map<string, RunRecord>;
  /** Its own runs it forgot (cleared there), still in its last commit. */
  gone: Set<string>;
  /** Other devices' runs cleared there, not yet in its last commit. */
  hidden: Set<string>;
}

/** A run of another device shown here, and whose it is. */
interface Shown {
  run: RunRecord;
  key: string;
}

/** A run of this device's, as written into the last commit: not serialised again while it is the same. */
interface Prepared {
  state: string;
  finishedAt: string | null;
  json: Buffer;
  /** Its plots: their sha256, size, and which of its outputs each is. */
  plots: { sha: string; size: number; index: number }[];
}

export interface SharedOutputsDeps {
  git: Git;
  /** This device's key. */
  myKey: string;
  /** Where the host keeps its state (.git/kuraa). */
  stateDir: string;
  /** The key this device's commits are signed with. */
  signing: () => Promise<KeyPair>;
  /** The workspace's other devices: key and name. */
  members: () => Promise<{ key: string; name: string }[]>;
  /** The signing key a device says it signs with (hex), or null if it has not said. */
  signerOf: (device: string) => Promise<string | null>;
  /** This device's cached runs, by document (Runner.cached). */
  cached: () => Promise<{ path: string; runs: RunRecord[] }[]>;
  /** Forget runs of this device another device's person cleared (Runner.forget). */
  forget: (ids: Set<string>) => Promise<{ path: string; ids: string[] }[]>;
  /** Runs others published, cleared, started or finished, for people with `path` open. */
  changed: (path: string, added: RunRecord[], removed: string[]) => void;
  /** This device's outputs, or those it took from others, changed: tell the other devices. */
  announce: () => void;
  /**
   * Send the connected devices something as it happens (0062): about a run of
   * `path` (to those with it open), or, with null, to every one.
   */
  live?: (frame: OutputsFrame, path: string | null) => void;
  log: (m: string) => void;
  /** How long publishing waits for more changes after the first, in ms. */
  publishMs?: number;
  /** The least time between two publishes, in ms: a burst of runs is one publish, or a few. */
  gapMs?: number;
  /** Log how long each step takes (KURAA_TIMINGS=1). */
  timings?: boolean;
}

export class SharedOutputs {
  private readonly devices = new Map<string, DeviceOutputs>();
  /** Each member's outputs commit last judged and not taken for good (older, or not signed by it). */
  private readonly passed = new Map<string, string>();
  /** Each member's outputs commit fetched but not taken (it could not be read, or its ref moved meanwhile): fetched and judged again (lacks, 0071). */
  private readonly failed = new Map<string, string>();
  private readonly live = new Map<string, Live>();
  private readonly prepared = new Map<string, Prepared>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private lastPublish = 0;
  private closed = false;

  constructor(private readonly d: SharedOutputsDeps) {}

  private get hiddenFile(): string {
    return join(this.d.stateDir, 'outputs-hidden.json');
  }

  private get ownRef(): string {
    return `${OUTPUTS}${this.d.myKey}`;
  }

  /** One change at a time: publishing, taking a device's, clearing. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A step's timing, logged when asked for (KURAA_TIMINGS). */
  timing(m: string): void {
    if (this.d.timings ?? !!process.env.KURAA_TIMINGS) this.d.log(`outputs timing: ${m}`);
  }

  /** Read the outputs taken from other devices so far, and publish this device's. */
  async start(): Promise<void> {
    await this.serial(async () => {
      await this.ownHidden();
      for (const [key, oid] of Object.entries(await this.refs())) {
        if (key === this.d.myKey) continue;
        const read = await this.read(key, oid).catch(() => null);
        if (read) this.devices.set(key, read);
      }
    });
    this.publish();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Every outputs ref here: this device's, and the others' it took. */
  refs(): Promise<Record<string, string>> {
    return outputRefs(this.d.git);
  }

  // ---------------------------------------------------------------------------
  // Publishing this device's

  /**
   * Publish this device's outputs soon: shortly after a first change, and then
   * no sooner than a gap after the last publish, so a burst of runs is one.
   */
  publish(): void {
    if (this.closed || this.timer) return;
    const wait = Math.max(this.d.publishMs ?? 100, this.lastPublish + (this.d.gapMs ?? 1000) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publishNow().catch((e: Error) => this.d.log(`outputs: could not publish: ${e.message}`));
    }, wait);
    this.timer.unref?.();
  }

  /** Publish this device's outputs now; returns the commit, or null if there was nothing to publish. */
  publishNow(): Promise<string | null> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.serial(() => this.publishOnce()).finally(() => (this.lastPublish = Date.now()));
  }

  /** A run as written into a commit: serialised once, and again only if it changed. */
  private prepare(run: RunRecord): Prepared {
    const had = this.prepared.get(run.id);
    if (had && had.state === run.state && had.finishedAt === run.finishedAt) return had;
    const plots: Prepared['plots'] = [];
    const outputs = run.outputs.map((o, index): ChunkOutput | StoredImage => {
      if (o.type !== 'image') return o;
      const data = Buffer.from(o.data, 'base64');
      const sha = createHash('sha256').update(data).digest('hex');
      plots.push({ sha, size: data.length, index });
      return { ...o, data: '', blob: sha };
    });
    const { device: _device, ...own } = run;
    const p = { state: run.state, finishedAt: run.finishedAt, json: Buffer.from(JSON.stringify({ ...own, outputs })), plots };
    this.prepared.set(run.id, p);
    return p;
  }

  private async publishOnce(): Promise<string | null> {
    const started = Date.now();
    const git = this.d.git;
    const before = (await git.run(['rev-parse', '--verify', '-q', this.ownRef], { allowFail: true })).stdout.trim() || null;
    const runs = (await this.d.cached()).flatMap((c) => c.runs.filter((r) => r.path === c.path && FINISHED.has(r.state) && ID.test(r.id)));
    const hidden = await this.ownHidden();
    if (!before && !runs.length && !hidden.length) return null;

    // What the last publish has already written, to name instead of writing again.
    const had = new Map<string, string>();
    if (before) for (const e of await this.list(before)) had.set(e.path, e.oid);

    const files: { path: string; content?: Buffer; oid?: string }[] = [];
    const images = new Set<string>();
    let bytes = 0;
    runs.sort((a, b) => (b.finishedAt ?? b.queuedAt).localeCompare(a.finishedAt ?? a.queuedAt));
    for (const run of runs) {
      const p = this.prepare(run);
      const fresh = p.plots.filter((x) => !images.has(x.sha));
      const size = p.json.length + fresh.reduce((n, x) => n + x.size, 0);
      if (bytes + size > MAX_SHARED_BYTES) continue;
      bytes += size;
      const path = `runs/${sha1(run.path)}/${run.id}.json`;
      const oid = had.get(path);
      files.push(oid && oid === blobId(p.json, oid.length) ? { path, oid } : { path, content: p.json });
      for (const x of fresh) {
        images.add(x.sha);
        const image = `images/${x.sha}`;
        const data = run.outputs[x.index] as Extract<ChunkOutput, { type: 'image' }>;
        files.push(had.has(image) ? { path: image, oid: had.get(image) } : { path: image, content: Buffer.from(data.data, 'base64') });
      }
    }
    // Runs no longer cached: not prepared any more either.
    const ids = new Set(runs.map((r) => r.id));
    for (const id of this.prepared.keys()) if (!ids.has(id)) this.prepared.delete(id);
    if (hidden.length) files.push({ path: 'hidden.json', content: Buffer.from(JSON.stringify({ ids: hidden })) });

    // Dated after the last this device published, whatever its clock says now (0071): the others take the newest by date.
    const last = before ? (await this.readCommit(before))?.at ?? 0 : 0;
    const made = await this.commit(files, Math.max(Math.floor(Date.now() / 1000), last + 1));
    if (before && (await git.out(['rev-parse', `${made}^{tree}`])) === (await git.out(['rev-parse', `${before}^{tree}`]))) return null;
    const raw = (await git.run(['cat-file', 'commit', made])).bytes;
    const signed = await git.out(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: signCommitObject(raw, await this.d.signing()) });
    await git.run(['update-ref', this.ownRef, signed, before ?? '']);
    this.d.announce();
    const newest = Math.max(0, ...runs.map((r) => Date.parse(r.finishedAt ?? r.queuedAt) || 0));
    this.timing(`published ${runs.length} runs in ${Date.now() - started} ms, ${Date.now() - newest} ms after the newest finished`);
    return signed;
  }

  /** A commit of these files and nothing else, with no parent (git fast-import: one process, however many files). */
  private async commit(files: { path: string; content?: Buffer; oid?: string }[], at = Math.floor(Date.now() / 1000)): Promise<string> {
    const tmp = `refs/kuraa/tmp/outputs-${process.pid}-${randomBytes(4).toString('hex')}`;
    const message = Buffer.from('Run outputs\n');
    const parts: Buffer[] = [Buffer.from(`commit ${tmp}\ncommitter kuraa <> ${at} +0000\ndata ${message.length}\n`), message];
    for (const f of files) {
      if (f.oid) parts.push(Buffer.from(`M 100644 ${f.oid} ${f.path}\n`));
      else parts.push(Buffer.from(`M 100644 inline ${f.path}\ndata ${f.content!.length}\n`), f.content!, Buffer.from('\n'));
    }
    parts.push(Buffer.from('\ndone\n'));
    try {
      await this.d.git.run(['fast-import', '--quiet', '--done'], { input: Buffer.concat(parts) });
      return await this.d.git.out(['rev-parse', '--verify', tmp]);
    } finally {
      await this.d.git.run(['update-ref', '-d', tmp], { allowFail: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Sending this device's as they happen (0062)

  /** A run of this device's changed (queued, running, finished, cancelled): tell the devices with its document open. */
  ran(run: RunRecord): void {
    if (this.closed || !this.d.live || !ID.test(run.id) || !LIVE_STATES.has(run.state)) return;
    const frame = liveRun(run);
    if (frame) this.d.live(frame, run.path);
    else this.timing(`run ${run.id} too large to send as it happened; it goes by git`);
  }

  /** This device's people cleared these runs of its own: the others stop showing them at once. */
  cleared(ids: string[]): void {
    if (ids.length && this.d.live) this.d.live({ meta: { op: 'gone', ids }, data: [] }, null);
  }

  // ---------------------------------------------------------------------------
  // Taking other devices' as they happen (0062)

  private liveOf(key: string): Live {
    let l = this.live.get(key);
    if (!l) this.live.set(key, (l = { runs: new Map(), pending: new Map(), gone: new Set(), hidden: new Set() }));
    return l;
  }

  /** Something a connected device sent as it happened, about its own runs: the link proves which device. */
  receive(from: string, frame: OutputsFrame): Promise<void> {
    return this.serial(() => this.receiveNow(from, frame)).catch((e: Error) => this.d.log(`outputs: could not use what a device sent: ${e.message}`));
  }

  private async receiveNow(from: string, { meta, data }: OutputsFrame): Promise<void> {
    if (from === this.d.myKey || !KEY.test(from)) return;
    const members = new Map((await this.d.members()).map((m) => [m.key, m.name]));
    if (!members.has(from)) return;
    const name = members.get(from)!;
    const live = this.liveOf(from);
    const before = this.visible();
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, MAX_HIDDEN) : []);
    if (meta.op === 'run') {
      const plots = new Map<string, Buffer>();
      for (const b of data) if (Buffer.isBuffer(b)) plots.set(createHash('sha256').update(b).digest('hex'), b);
      const run = readRun(meta.run, new Map([...plots.keys()].map((k) => [k, k])), LIVE_STATES);
      if (!run) return;
      if (PENDING.has(run.state)) {
        // As many under way as are kept finished, at the most (0071): a device cannot grow this without end.
        if (!live.pending.has(run.id) && live.pending.size >= MAX_LIVE_RUNS) return;
        live.pending.set(run.id, run);
        this.d.changed(run.path, [{ ...run, outputs: [], device: name }], []);
        return;
      }
      const wasPending = live.pending.delete(run.id);
      if (run.state === 'cancelled') {
        if (wasPending) this.d.changed(run.path, [], [run.id]);
        return;
      }
      run.outputs = run.outputs.map((o): ChunkOutput => {
        if (o.type !== 'image') return o;
        const { blob, ...image } = o as StoredImage;
        return { ...image, data: plots.get(blob)!.toString('base64') };
      });
      live.runs.set(run.id, run);
      live.gone.delete(run.id);
      if (live.runs.size > MAX_LIVE_RUNS) {
        const oldest = [...live.runs.values()].sort((a, b) => (a.finishedAt ?? a.queuedAt).localeCompare(b.finishedAt ?? b.queuedAt))[0]!;
        live.runs.delete(oldest.id);
      }
      const added = await this.tell(before);
      // Finished, but not shown (cleared meanwhile): no longer under way either.
      if (wasPending && !added.some((r) => r.id === run.id)) this.d.changed(run.path, [], [run.id]);
      if (run.finishedAt) this.timing(`${name}’s run ${run.id} came as it happened, ${Date.now() - Date.parse(run.finishedAt)} ms after it finished`);
      return;
    }
    if (meta.op === 'gone') {
      for (const id of ids(meta.ids)) {
        live.runs.delete(id);
        live.gone.add(id);
      }
      trim(live.gone);
      await this.tell(before);
      return;
    }
    if (meta.op === 'hide') {
      for (const id of ids(meta.ids)) live.hidden.add(id);
      trim(live.hidden);
      await this.tell(before);
      await this.forgetHidden();
    }
  }

  /** A device went away: its runs under way are no longer shown as such (what finished stays). */
  disconnected(key: string): void {
    const live = this.live.get(key);
    if (!live?.pending.size) return;
    const byPath = new Map<string, string[]>();
    for (const r of live.pending.values()) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r.id]);
    live.pending.clear();
    for (const [path, ids] of byPath) this.d.changed(path, [], ids);
  }

  /** Other devices' runs of a document under way, each saying which device. */
  async pending(path: string): Promise<RunRecord[]> {
    const names = new Map((await this.d.members()).map((m) => [m.key, m.name]));
    const out: RunRecord[] = [];
    for (const [key, live] of this.live) for (const r of live.pending.values()) if (r.path === path) out.push({ ...r, device: names.get(key) ?? key.slice(0, 8) });
    return out;
  }

  /** What came as it happened that a device's commit now holds, or shows gone there, let go of. */
  private reconcile(key: string, commit: DeviceOutputs): void {
    const live = this.live.get(key);
    if (!live) return;
    const held = new Set<string>();
    for (const list of commit.runs.values()) for (const r of list) held.add(r.id);
    const cutoff = commit.at * 1000 - LIVE_SLACK_MS;
    for (const [id, r] of live.runs) if (held.has(id) || Date.parse(r.finishedAt ?? r.queuedAt) < cutoff) live.runs.delete(id);
    for (const id of live.gone) if (!held.has(id)) live.gone.delete(id);
    for (const id of live.hidden) if (commit.hidden.has(id)) live.hidden.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Taking other devices' commits

  /**
   * Whether fetching from a device that says it has these outputs refs would
   * bring any this device lacks: a commit it does not have, of a member's.
   */
  async lacks(theirs: Record<string, string> | null): Promise<boolean> {
    if (!theirs) return false;
    const members = new Set((await this.d.members()).map((m) => m.key));
    const unknown = Object.entries(theirs).filter(([key, oid]) => key !== this.d.myKey && members.has(key) && this.devices.get(key)?.oid !== oid && this.passed.get(key) !== oid);
    if (!unknown.length) return false;
    // One fetched before but not taken then (it could not be read, say) is fetched and judged again (0071).
    if (unknown.some(([key, oid]) => this.failed.get(key) === oid)) return true;
    const r = await this.d.git.run(['cat-file', '--batch-check'], { input: `${unknown.map(([, oid]) => oid).join('\n')}\n`, allowFail: true });
    return r.stdout.split('\n').some((l) => l.endsWith(' missing'));
  }

  /**
   * Take the outputs refs just fetched from a device (`remote`, key `from`): of
   * each member's, the newest, if signed with that member's signing key (or, if
   * it has not said which, fetched from that member itself). People with a
   * document open see what changed.
   */
  adopt(remote: string, from: string): Promise<void> {
    return this.serial(() => this.adoptNow(remote, from));
  }

  private async adoptNow(remote: string, from: string): Promise<void> {
    const started = Date.now();
    const git = this.d.git;
    const prefix = fetchedFrom(remote);
    const fetched = await git.out(['for-each-ref', '--format=%(refname)%00%(objectname)', prefix]);
    const members = new Map((await this.d.members()).map((m) => [m.key, m.name]));
    const before = this.visible();
    let changed = false;
    for (const line of fetched.split('\n').filter(Boolean)) {
      const [ref, oid] = line.split('\0') as [string, string];
      const key = ref.slice(prefix.length);
      if (key === this.d.myKey || !members.has(key)) continue;
      const now = this.devices.get(key);
      if (now?.oid === oid) continue;
      const commit = await this.readCommit(oid);
      if (!commit) continue;
      const signer = await this.d.signerOf(key);
      if (signer ? commit.signer !== signer : key !== from) {
        if (this.passed.get(key) !== oid) this.d.log(`outputs: ${remote} passed on outputs of ${members.get(key)} not signed by it; not taken`);
        this.passed.set(key, oid);
        continue;
      }
      if (now && (commit.at < now.at || (commit.at === now.at && oid < now.oid))) {
        this.passed.set(key, oid);
        continue;
      }
      const read = await this.read(key, oid, commit.at, now).catch((e: Error) => {
        this.d.log(`outputs: could not read ${members.get(key)}’s: ${e.message}`);
        return null;
      });
      if (!read) {
        this.failed.set(key, oid);
        continue;
      }
      const moved = await git.run(['update-ref', `${OUTPUTS}${key}`, oid, now?.oid ?? ''], { allowFail: true });
      if (moved.code !== 0) {
        this.failed.set(key, oid);
        continue;
      }
      this.failed.delete(key);
      this.devices.set(key, read);
      this.reconcile(key, read);
      changed = true;
    }
    // Devices no longer in the workspace: their outputs go.
    for (const key of new Set([...this.devices.keys(), ...this.live.keys()])) {
      if (members.has(key)) continue;
      if (this.devices.delete(key)) await git.run(['update-ref', '-d', `${OUTPUTS}${key}`], { allowFail: true });
      this.disconnected(key);
      this.live.delete(key);
      changed = true;
    }
    if (!changed) return;
    const added = await this.tell(before);
    const newest = Math.max(0, ...added.map((r) => Date.parse(r.finishedAt ?? r.queuedAt) || 0));
    if (newest) this.timing(`took ${remote}’s in ${Date.now() - started} ms, ${Date.now() - newest} ms after the newest finished there`);
    await this.forgetHidden();
    this.d.announce();
  }

  /** This device's runs that another device's person cleared: forgotten here too (and so published no more). */
  private async forgetHidden(): Promise<void> {
    for (const { path, ids } of await this.d.forget(this.hiddenByOthers())) this.d.changed(path, [], ids);
  }

  /** Tell people with documents open which runs of other devices came and went since `before`; returns those that came. */
  private async tell(before: Map<string, Map<string, Shown>>): Promise<RunRecord[]> {
    const after = this.visible();
    const all: RunRecord[] = [];
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(path) ?? new Map<string, Shown>();
      const is = after.get(path) ?? new Map<string, Shown>();
      const added = [...is.values()].filter((s) => !was.has(s.run.id));
      const removed = [...was.keys()].filter((id) => !is.has(id));
      if (added.length || removed.length) this.d.changed(path, await this.withImages(added), removed);
      all.push(...added.map((s) => s.run));
    }
    return all;
  }

  private async readCommit(oid: string): Promise<{ at: number; signer: string | null } | null> {
    const r = await this.d.git.run(['cat-file', 'commit', oid], { allowFail: true });
    if (r.code !== 0) return null;
    const at = Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(r.stdout)?.[1]);
    if (!Number.isFinite(at)) return null;
    const parts = splitSignature(r.bytes);
    return { at, signer: parts ? sshSigner(parts.payload, parts.armored) : null };
  }

  /** The files of a commit's tree: path and blob. */
  private async list(oid: string): Promise<{ path: string; oid: string; size: number }[]> {
    const out = (await this.d.git.run(['ls-tree', '-r', '-z', '--long', '--full-tree', oid])).stdout;
    const files: { path: string; oid: string; size: number }[] = [];
    for (const entry of out.split('\0').filter(Boolean)) {
      const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.*)$/s.exec(entry);
      if (m) files.push({ oid: m[1]!, size: Number(m[2]), path: m[3]! });
    }
    return files;
  }

  /** A device's outputs commit, read and checked; runs whose blobs `prev` (its last) had read are not read again. */
  private async read(key: string, oid: string, at?: number, prev?: DeviceOutputs): Promise<DeviceOutputs> {
    const when = at ?? (await this.readCommit(oid))?.at ?? 0;
    const files = await this.list(oid);
    const images = new Map<string, string>();
    for (const f of files) {
      const sha = /^images\/([0-9a-f]{64})$/.exec(f.path)?.[1];
      if (sha && SHA256.test(sha)) images.set(sha, f.oid);
    }
    const wanted = files.filter((f) => f.size <= MAX_RUN_BYTES && (f.path === 'hidden.json' || /^runs\/[0-9a-f]{40}\/[\w-]{1,64}\.json$/.test(f.path)));
    const blobs = await readObjects(this.d.git, wanted.filter((f) => !prev?.byBlob.has(f.oid)).map((f) => f.oid));
    const runs = new Map<string, RunRecord[]>();
    const byBlob = new Map<string, RunRecord>();
    let hidden = new Set<string>();
    for (const f of wanted) {
      const reused = prev?.byBlob.get(f.oid);
      let run: RunRecord | null;
      // A run read before, if its plots are still in this commit (where they are read from).
      if (reused) run = reused.outputs.every((o) => o.type !== 'image' || images.has((o as StoredImage).blob)) ? reused : null;
      else {
        const bytes = blobs.get(f.oid);
        if (!bytes) continue;
        let v: unknown;
        try {
          v = JSON.parse(bytes.toString('utf8'));
        } catch {
          continue;
        }
        if (f.path === 'hidden.json') {
          const ids = (v as { ids?: unknown })?.ids;
          if (Array.isArray(ids)) hidden = new Set(ids.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(-MAX_HIDDEN));
          continue;
        }
        run = readRun(v, images);
      }
      if (!run || f.path !== `runs/${sha1(run.path)}/${run.id}.json`) continue;
      byBlob.set(f.oid, run);
      const list = runs.get(run.path);
      if (list) list.push(run);
      else runs.set(run.path, [run]);
    }
    return { key, oid, at: when, runs, byBlob, images, hidden };
  }

  // ---------------------------------------------------------------------------
  // Showing and clearing

  /** Runs of other devices cleared anywhere: here, or by any device whose outputs this one has. */
  private hiddenByOthers(): Set<string> {
    const all = new Set<string>();
    for (const d of this.devices.values()) for (const id of d.hidden) all.add(id);
    for (const l of this.live.values()) for (const id of l.hidden) all.add(id);
    return all;
  }

  private ownHiddenNow: Set<string> = new Set();

  /** Every run cleared, here or on another device: none of them is shown. */
  async hidden(): Promise<Set<string>> {
    const all = this.hiddenByOthers();
    for (const id of await this.ownHidden()) all.add(id);
    return all;
  }

  /** Other devices' runs shown now, by path and id (without the hidden ones): those of their commits, and those that came as they happened. */
  private visible(): Map<string, Map<string, Shown>> {
    const hidden = new Set([...this.hiddenByOthers(), ...this.ownHiddenNow]);
    const out = new Map<string, Map<string, Shown>>();
    const show = (key: string, r: RunRecord) => {
      if (hidden.has(r.id)) return;
      const byId = out.get(r.path) ?? new Map<string, Shown>();
      if (!byId.has(r.id)) byId.set(r.id, { run: r, key });
      out.set(r.path, byId);
    };
    for (const key of new Set([...this.devices.keys(), ...this.live.keys()])) {
      const live = this.live.get(key);
      for (const r of live?.runs.values() ?? []) show(key, r);
      for (const list of this.devices.get(key)?.runs.values() ?? []) for (const r of list) if (!live?.gone.has(r.id)) show(key, r);
    }
    return out;
  }

  /** The runs other devices published (or sent as they happened) for a document, with their plots, each saying which device it ran on. */
  async runs(path: string): Promise<RunRecord[]> {
    await this.ownHidden();
    return this.withImages([...(this.visible().get(path)?.values() ?? [])]);
  }

  /** Runs as people see them: plots in line, and the device each ran on. */
  private async withImages(shown: Shown[]): Promise<RunRecord[]> {
    if (!shown.length) return [];
    const names = new Map((await this.d.members()).map((m) => [m.key, m.name]));
    const blobOf = (key: string, o: ChunkOutput) => (o.type === 'image' && 'blob' in o ? this.devices.get(key)?.images.get((o as StoredImage).blob) : undefined);
    const wanted = new Set<string>();
    for (const { run, key } of shown) {
      for (const o of run.outputs) {
        const blob = blobOf(key, o);
        if (blob) wanted.add(blob);
      }
    }
    const blobs = await readObjects(this.d.git, [...wanted]);
    return shown.map(({ run, key }) => {
      const outputs = run.outputs.map((o): ChunkOutput => {
        if (o.type !== 'image' || !('blob' in o)) return o;
        const { blob: _blob, ...image } = o as StoredImage;
        const b = blobOf(key, o);
        return { ...image, data: (b && blobs.get(b)?.toString('base64')) ?? '' };
      });
      return { ...run, outputs, device: names.get(key) ?? key.slice(0, 8) };
    });
  }

  /**
   * Clear other devices' outputs of a chunk (those of its code, as the client
   * clears them), or all of a document's: hidden here and, once published, on
   * every device (at once on those connected). Returns the runs cleared, by id.
   */
  hide(path: string, chunk?: ChunkRef): Promise<string[]> {
    return this.serial(async () => {
      const ids = [...(this.visible().get(path)?.values() ?? [])]
        .map((s) => s.run)
        .filter((r) => !chunk || r.chunk.codeHash === chunk.codeHash || (r.chunk.index === chunk.index && r.chunk.label === chunk.label))
        .map((r) => r.id);
      if (!ids.length) return [];
      const own = [...(await this.ownHidden()), ...ids].slice(-MAX_HIDDEN);
      await mkdir(dirname(this.hiddenFile), { recursive: true });
      const tmp = `${this.hiddenFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ ids: own }));
      await renameOver(tmp, this.hiddenFile);
      this.ownHiddenNow = new Set(own);
      this.d.live?.({ meta: { op: 'hide', ids }, data: [] }, null);
      this.publish();
      return ids;
    });
  }

  /** The runs of other devices cleared on this one, oldest first. */
  private async ownHidden(): Promise<string[]> {
    try {
      const ids = (JSON.parse(await readFile(this.hiddenFile, 'utf8')) as { ids?: unknown }).ids;
      const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && ID.test(x)) : [];
      this.ownHiddenNow = new Set(list);
      return list;
    } catch {
      this.ownHiddenNow = new Set();
      return [];
    }
  }
}

/** A run of this device's as sent as it happens: plots as bytes beside it, named by their sha256; null if it is too large. */
export function liveRun(run: RunRecord): OutputsFrame | null {
  const data: Buffer[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const outputs = PENDING.has(run.state) || run.state === 'cancelled' ? [] : run.outputs.map((o): ChunkOutput | StoredImage => {
    if (o.type !== 'image') return o;
    const b = Buffer.from(o.data, 'base64');
    const sha = createHash('sha256').update(b).digest('hex');
    if (!seen.has(sha)) {
      seen.add(sha);
      data.push(b);
      bytes += b.length;
    }
    return { ...o, data: '', blob: sha };
  });
  const { device: _device, ...own } = run;
  const meta = { op: 'run', run: { ...own, outputs } };
  bytes += Buffer.byteLength(JSON.stringify(meta));
  return bytes > MAX_LIVE_BYTES ? null : { meta, data };
}

/** The outputs refs a repository has: device key → commit. */
export async function outputRefs(git: Git): Promise<Record<string, string>> {
  const out = await git.out(['for-each-ref', '--format=%(refname)%00%(objectname)', OUTPUTS]);
  const refs: Record<string, string> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, oid] = line.split('\0');
    const key = ref!.slice(OUTPUTS.length);
    if (KEY.test(key)) refs[key] = oid!;
  }
  return refs;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** The id git gives a blob of these bytes (sha1, or sha256 in a repository that uses it: by the length of its ids). */
function blobId(bytes: Buffer, length: number): string {
  return createHash(length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Keep a set of ids to the newest MAX_HIDDEN (a set keeps the order they were added in). */
function trim(ids: Set<string>): void {
  for (const id of ids) {
    if (ids.size <= MAX_HIDDEN) return;
    ids.delete(id);
  }
}

/** Objects by id, read with one git process: id → bytes (missing ones left out). */
async function readObjects(git: Git, oids: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!oids.length) return out;
  const b = (await git.run(['cat-file', '--batch'], { input: `${oids.join('\n')}\n` })).bytes;
  let at = 0;
  for (const oid of oids) {
    const nl = b.indexOf(10, at);
    if (nl < 0) break;
    const header = /^(\S+) (\S+) (\d+)$/.exec(b.subarray(at, nl).toString('utf8'));
    at = nl + 1;
    if (!header) continue;
    const size = Number(header[3]);
    out.set(oid, b.subarray(at, at + size));
    at += size + 1;
  }
  return out;
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * A run as another device published (or sent) it, checked: null if it is not
 * one, or not in one of `states`. Its plots must be among `images`.
 */
export function readRun(v: unknown, images: Map<string, string>, states: Set<string> = FINISHED): RunRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const c = r.chunk as Record<string, unknown> | null;
  const by = r.by as Record<string, unknown> | null;
  if (!isStr(r.id) || !ID.test(r.id) || !isStr(r.path) || !r.path || !isStr(r.state) || !states.has(r.state) || !isStr(r.queuedAt)) return null;
  if (!c || typeof c !== 'object' || typeof c.index !== 'number' || !isStr(c.codeHash) || (c.label !== null && !isStr(c.label))) return null;
  if (!by || typeof by !== 'object' || !isStr(by.name) || !isStr(by.color)) return null;
  if (!Array.isArray(r.outputs)) return null;
  const outputs: (ChunkOutput | StoredImage)[] = [];
  for (const o of r.outputs as Record<string, unknown>[]) {
    if (!o || typeof o !== 'object' || !isStr(o.type)) return null;
    if (TEXTS.has(o.type)) {
      if (!isStr(o.text)) return null;
      outputs.push({ type: o.type as 'text', text: o.text });
    } else if (o.type === 'image') {
      if (!isStr(o.mime) || !isStr(o.blob) || !images.has(o.blob) || typeof o.width !== 'number' || typeof o.height !== 'number') return null;
      outputs.push({ type: 'image', mime: o.mime, data: '', width: o.width, height: o.height, blob: o.blob });
    } else if (o.type === 'table') {
      const cols = o.columns, types = o.types, data = o.data;
      if (!Array.isArray(cols) || !cols.every(isStr) || !Array.isArray(types) || !types.every(isStr) || !Array.isArray(data) || !data.every((col) => Array.isArray(col) && col.every(isStr))) return null;
      if (o.rownames !== null && !(Array.isArray(o.rownames) && o.rownames.every(isStr))) return null;
      if (typeof o.nrow !== 'number' || typeof o.ncol !== 'number') return null;
      outputs.push({ type: 'table', columns: cols, types, data: data as string[][], rownames: o.rownames as string[] | null, nrow: o.nrow, ncol: o.ncol });
    } else return null;
  }
  const run: RunRecord = {
    id: r.id, path: r.path, state: r.state as RunRecord['state'], outputs: outputs as ChunkOutput[],
    chunk: { label: c.label as string | null, index: c.index, codeHash: c.codeHash, ...(c.partial === true ? { partial: true } : {}) },
    by: { name: by.name, color: by.color },
    queuedAt: r.queuedAt,
    finishedAt: isStr(r.finishedAt) ? r.finishedAt : null,
    ms: typeof r.ms === 'number' ? r.ms : null,
  };
  if (isStr(r.engine)) run.engine = r.engine;
  const basis = r.basis as Record<string, unknown> | undefined;
  if (basis && typeof basis === 'object' && isStr(basis.session) && Array.isArray(basis.steps)) {
    const steps = (basis.steps as Record<string, unknown>[]).filter((s) => s && typeof s === 'object' && (s.label === null || isStr(s.label)) && typeof s.index === 'number' && isStr(s.codeHash) && typeof s.complete === 'boolean');
    if (steps.length === basis.steps.length) run.basis = { session: basis.session, steps: steps.map((s) => ({ label: s.label as string | null, index: s.index as number, codeHash: s.codeHash as string, complete: s.complete as boolean })) };
  }
  const made = r.madeFrom === undefined ? null : checkMadeFrom(r.madeFrom);
  if (made) run.madeFrom = made;
  return run;
}
