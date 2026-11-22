// Run outputs shared between a workspace's devices (docs/decisions/0058-shared-outputs.md).
//
// Outputs are never written into a document (0011), and each device caches the
// latest run of each chunk in .git/kuraa/outputs. To let the other devices see
// them, each device publishes its cache as a commit of its own ref,
// `refs/kuraa/outputs/<device key>`: outside the branches (never checked out,
// merged, pushed to backups or to the online copy), with no parent (each
// publish replaces the last, so nothing piles up: git's cleanup takes what no
// ref holds any more), and signed with the device's signing key, as its commits
// are. Devices fetch each other's outputs refs with their branches, keep the
// newest of each device's they hear of (directly or passed on by another), and
// show them beside their own. A device writes only its own ref, so two never
// conflict.
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
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChunkOutput, ChunkRef, RunRecord } from '@kuraa/session/server';
import type { Git } from '../git.js';
import type { KeyPair } from '../keys.js';
import { renameOver } from '../files.js';
import { signCommitObject, splitSignature, sshSigner } from '../signing.js';

/** Each device's outputs: `refs/kuraa/outputs/<device key>`. */
export const OUTPUTS = 'refs/kuraa/outputs/';
/** Where a fetch from a device puts the outputs refs it has, before they are checked and taken. */
export const fetchedFrom = (remote: string) => `refs/kuraa/fetched/${remote}/`;
/** The refspec that fetches them. */
export const outputsRefspec = (remote: string) => `+${OUTPUTS}*:${fetchedFrom(remote)}*`;

/** The most a device publishes, in bytes (runs and plots): the newest runs first, until it is reached. */
export const MAX_SHARED_BYTES = 64 * 1024 * 1024;
/** The most runs of other devices a device keeps cleared. */
const MAX_HIDDEN = 2000;
/** The largest run read from another device, in bytes (without its plots). */
const MAX_RUN_BYTES = 32 * 1024 * 1024;

const ID = /^[\w-]{1,64}$/;
const KEY = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FINISHED = new Set(['done', 'failed', 'interrupted']);
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
  /** Plots: sha256 → blob. */
  images: Map<string, string>;
  hidden: Set<string>;
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
  /** Runs others published or cleared, for people with `path` open. */
  changed: (path: string, added: RunRecord[], removed: string[]) => void;
  /** This device's outputs, or those it took from others, changed: tell the other devices. */
  announce: () => void;
  log: (m: string) => void;
  /** How long publishing waits for more changes, in ms. */
  publishMs?: number;
}

export class SharedOutputs {
  private readonly devices = new Map<string, DeviceOutputs>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
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
  }

  /** Every outputs ref here: this device's, and the others' it took. */
  refs(): Promise<Record<string, string>> {
    return outputRefs(this.d.git);
  }

  // ---------------------------------------------------------------------------
  // Publishing this device's

  /** Publish this device's outputs soon (once for a burst of changes). */
  publish(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.publishNow().catch((e: Error) => this.d.log(`outputs: could not publish: ${e.message}`)), this.d.publishMs ?? 1000);
    this.timer.unref?.();
  }

  /** Publish this device's outputs now; returns the commit, or null if there was nothing to publish. */
  publishNow(): Promise<string | null> {
    clearTimeout(this.timer);
    return this.serial(() => this.publishOnce());
  }

  private async publishOnce(): Promise<string | null> {
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
      const plots: { sha: string; bytes: Buffer }[] = [];
      const outputs = run.outputs.map((o): ChunkOutput | StoredImage => {
        if (o.type !== 'image') return o;
        const data = Buffer.from(o.data, 'base64');
        const sha = createHash('sha256').update(data).digest('hex');
        plots.push({ sha, bytes: data });
        return { ...o, data: '', blob: sha };
      });
      const { device: _device, ...own } = run;
      const json = Buffer.from(JSON.stringify({ ...own, outputs }));
      const fresh = plots.filter((p) => !images.has(p.sha));
      const size = json.length + fresh.reduce((n, p) => n + p.bytes.length, 0);
      if (bytes + size > MAX_SHARED_BYTES) continue;
      bytes += size;
      files.push({ path: `runs/${sha1(run.path)}/${run.id}.json`, content: json });
      for (const p of fresh) {
        images.add(p.sha);
        const path = `images/${p.sha}`;
        files.push(had.has(path) ? { path, oid: had.get(path) } : { path, content: p.bytes });
      }
    }
    if (hidden.length) files.push({ path: 'hidden.json', content: Buffer.from(JSON.stringify({ ids: hidden })) });

    const made = await this.commit(files);
    if (before && (await git.out(['rev-parse', `${made}^{tree}`])) === (await git.out(['rev-parse', `${before}^{tree}`]))) return null;
    const raw = (await git.run(['cat-file', 'commit', made])).bytes;
    const signed = await git.out(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: signCommitObject(raw, await this.d.signing()) });
    await git.run(['update-ref', this.ownRef, signed, before ?? '']);
    this.d.announce();
    return signed;
  }

  /** A commit of these files and nothing else, with no parent (git fast-import: one process, however many files). */
  private async commit(files: { path: string; content?: Buffer; oid?: string }[]): Promise<string> {
    const tmp = `refs/kuraa/tmp/outputs-${process.pid}-${randomBytes(4).toString('hex')}`;
    const message = Buffer.from('Run outputs\n');
    const parts: Buffer[] = [Buffer.from(`commit ${tmp}\ncommitter kuraa <> ${Math.floor(Date.now() / 1000)} +0000\ndata ${message.length}\n`), message];
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
  // Taking other devices'

  /**
   * Whether fetching from a device that says it has these outputs refs would
   * bring any this device lacks: a commit it does not have, of a member's.
   */
  async lacks(theirs: Record<string, string> | null): Promise<boolean> {
    if (!theirs) return false;
    const members = new Set((await this.d.members()).map((m) => m.key));
    const unknown = Object.entries(theirs).filter(([key, oid]) => key !== this.d.myKey && members.has(key) && this.devices.get(key)?.oid !== oid).map(([, oid]) => oid);
    if (!unknown.length) return false;
    const r = await this.d.git.run(['cat-file', '--batch-check'], { input: `${unknown.join('\n')}\n`, allowFail: true });
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
        this.d.log(`outputs: ${remote} passed on outputs of ${members.get(key)} not signed by it; not taken`);
        continue;
      }
      if (now && (commit.at < now.at || (commit.at === now.at && oid < now.oid))) continue;
      const read = await this.read(key, oid, commit.at).catch((e: Error) => {
        this.d.log(`outputs: could not read ${members.get(key)}’s: ${e.message}`);
        return null;
      });
      if (!read) continue;
      const moved = await git.run(['update-ref', `${OUTPUTS}${key}`, oid, now?.oid ?? ''], { allowFail: true });
      if (moved.code !== 0) continue;
      this.devices.set(key, read);
      changed = true;
    }
    // Devices no longer in the workspace: their outputs go.
    for (const key of [...this.devices.keys()]) {
      if (members.has(key)) continue;
      await git.run(['update-ref', '-d', `${OUTPUTS}${key}`], { allowFail: true });
      this.devices.delete(key);
      changed = true;
    }
    if (!changed) return;
    await this.tell(before);
    // This device's runs that another device's person cleared: forgotten here too (and so published no more).
    const hidden = this.hiddenByOthers();
    for (const { path, ids } of await this.d.forget(hidden)) this.d.changed(path, [], ids);
    this.d.announce();
  }

  /** Tell people with documents open which runs of other devices came and went since `before`. */
  private async tell(before: Map<string, Map<string, RunRecord>>): Promise<void> {
    const after = this.visible();
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(path) ?? new Map<string, RunRecord>();
      const is = after.get(path) ?? new Map<string, RunRecord>();
      const added = [...is.values()].filter((r) => !was.has(r.id));
      const removed = [...was.keys()].filter((id) => !is.has(id));
      if (added.length || removed.length) this.d.changed(path, await this.withImages(added), removed);
    }
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

  /** A device's outputs commit, read and checked. */
  private async read(key: string, oid: string, at?: number): Promise<DeviceOutputs> {
    const when = at ?? (await this.readCommit(oid))?.at ?? 0;
    const files = await this.list(oid);
    const images = new Map<string, string>();
    for (const f of files) {
      const sha = /^images\/([0-9a-f]{64})$/.exec(f.path)?.[1];
      if (sha && SHA256.test(sha)) images.set(sha, f.oid);
    }
    const wanted = files.filter((f) => f.size <= MAX_RUN_BYTES && (f.path === 'hidden.json' || /^runs\/[0-9a-f]{40}\/[\w-]{1,64}\.json$/.test(f.path)));
    const blobs = await readObjects(this.d.git, wanted.map((f) => f.oid));
    const runs = new Map<string, RunRecord[]>();
    let hidden = new Set<string>();
    for (const f of wanted) {
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
      const run = readRun(v, images);
      if (!run || f.path !== `runs/${sha1(run.path)}/${run.id}.json`) continue;
      const list = runs.get(run.path);
      if (list) list.push(run);
      else runs.set(run.path, [run]);
    }
    return { key, oid, at: when, runs, images, hidden };
  }

  // ---------------------------------------------------------------------------
  // Showing and clearing

  /** Runs of other devices cleared anywhere: here, or by any device whose outputs this one has. */
  private hiddenByOthers(): Set<string> {
    const all = new Set<string>();
    for (const d of this.devices.values()) for (const id of d.hidden) all.add(id);
    return all;
  }

  private ownHiddenNow: Set<string> = new Set();

  /** Every run cleared, here or on another device: none of them is shown. */
  async hidden(): Promise<Set<string>> {
    const all = this.hiddenByOthers();
    for (const id of await this.ownHidden()) all.add(id);
    return all;
  }

  /** Other devices' runs shown now, by path and id (without the hidden ones). */
  private visible(): Map<string, Map<string, RunRecord>> {
    const hidden = new Set([...this.hiddenByOthers(), ...this.ownHiddenNow]);
    const out = new Map<string, Map<string, RunRecord>>();
    for (const d of this.devices.values()) {
      for (const [path, runs] of d.runs) {
        for (const r of runs) {
          if (hidden.has(r.id)) continue;
          const byId = out.get(path) ?? new Map<string, RunRecord>();
          byId.set(r.id, r);
          out.set(path, byId);
        }
      }
    }
    return out;
  }

  /** The runs other devices published for a document, with their plots, each saying which device it ran on. */
  async runs(path: string): Promise<RunRecord[]> {
    await this.ownHidden();
    return this.withImages([...(this.visible().get(path)?.values() ?? [])]);
  }

  /** Runs as people see them: plots in line, and the device each ran on. */
  private async withImages(runs: RunRecord[]): Promise<RunRecord[]> {
    if (!runs.length) return [];
    const names = new Map((await this.d.members()).map((m) => [m.key, m.name]));
    const owner = new Map<string, DeviceOutputs>();
    for (const d of this.devices.values()) for (const list of d.runs.values()) for (const r of list) owner.set(r.id, d);
    const wanted = new Set<string>();
    for (const r of runs) for (const o of r.outputs) if (o.type === 'image') wanted.add(owner.get(r.id)!.images.get((o as StoredImage).blob)!);
    const blobs = await readObjects(this.d.git, [...wanted]);
    return runs.map((r) => {
      const d = owner.get(r.id)!;
      const outputs = r.outputs.map((o): ChunkOutput => {
        if (o.type !== 'image') return o;
        const { blob, ...image } = o as StoredImage;
        return { ...image, data: blobs.get(d.images.get(blob)!)?.toString('base64') ?? '' };
      });
      return { ...r, outputs, device: names.get(d.key) ?? d.key.slice(0, 8) };
    });
  }

  /**
   * Clear other devices' outputs of a chunk (those of its code, as the client
   * clears them), or all of a document's: hidden here and, once published, on
   * every device. Returns the runs cleared, by id.
   */
  hide(path: string, chunk?: ChunkRef): Promise<string[]> {
    return this.serial(async () => {
      const ids = [...(this.visible().get(path)?.values() ?? [])]
        .filter((r) => !chunk || r.chunk.codeHash === chunk.codeHash || (r.chunk.index === chunk.index && r.chunk.label === chunk.label))
        .map((r) => r.id);
      if (!ids.length) return [];
      const own = [...(await this.ownHidden()), ...ids].slice(-MAX_HIDDEN);
      await mkdir(dirname(this.hiddenFile), { recursive: true });
      const tmp = `${this.hiddenFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ ids: own }));
      await renameOver(tmp, this.hiddenFile);
      this.ownHiddenNow = new Set(own);
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

/** A run as another device published it, checked: null if it is not one. Its plots must be in the tree. */
export function readRun(v: unknown, images: Map<string, string>): RunRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const c = r.chunk as Record<string, unknown> | null;
  const by = r.by as Record<string, unknown> | null;
  if (!isStr(r.id) || !ID.test(r.id) || !isStr(r.path) || !r.path || !isStr(r.state) || !FINISHED.has(r.state) || !isStr(r.queuedAt)) return null;
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
  return run;
}
