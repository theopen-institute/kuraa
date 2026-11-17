// Running code chunks, through run plugins (see @kuraa/run-kit and plugins.ts).
//
// The runner knows no language or sandbox. For each document and engine it
// opens a session in an environment, runs requests one at a time, broadcasts
// each run's progress and outputs to everyone with the document open, and
// caches the latest output of each chunk in .git/kuraa/outputs (never in the
// document).
//
// Who decides what: the operator (host options) turns engines and environments
// on, and sets the limits. A workspace may ask, in .kuraa/run.json, for one of
// the allowed environments, for what its engines need (an image, packages), and
// for more access (writing the workspace, the network); it gets more access
// only where the operator allows it. It can never choose an environment the
// operator did not allow, and if the chosen one is unavailable, nothing runs.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_POLICY, type ChunkOutput, type Engine, type EngineSession, type Environment, type EnvironmentStatus, type Policy } from '@kuraa/run-kit';
import type { ChunkRef, PresenceUser, RoomMessage, RunRecord, RunSessionInfo } from '@kuraa/session/server';
import type { RunPlugins } from './plugins.js';

export interface RunOptions {
  /** Engines to turn on, by id: ['r']. None: running is off. */
  engines: string[];
  /** Environments allowed, by id; the first is the default: ['podman']. None: running is off. */
  environments: string[];
  /** More run plugins to load, by path or package name. */
  plugins?: string[];
  /** Options for plugins, by engine or environment id: { r: { rscript: '…' }, podman: { podman: '…' } }. */
  options?: Record<string, unknown>;
  /** Let a workspace ask to write to itself (default: read-only). */
  allowWorkspaceWrite?: boolean;
  /** Let a workspace ask for the network (default: none). */
  allowNetwork?: boolean;
  /** Limits for each session. */
  memory?: string;
  cpus?: number;
}

/** What a workspace asks for, in .kuraa/run.json. */
interface WorkspaceRunConfig {
  environment?: unknown;
  access?: { workspace?: unknown; network?: unknown };
  [engine: string]: unknown;
}

export interface RunDescription {
  enabled: boolean;
  engines: { id: string; label: string; handles: string[] }[];
  /** The environment this workspace runs in, and whether it is there. */
  environment: { id: string; label: string; sandboxed: boolean; available: boolean; message: string } | null;
}

const MAX_TEXT = 200_000;

interface Job { record: RunRecord; engine: Engine; code: string; header: string }

interface Session { engine: Engine; environment: Environment; session: EngineSession; info: RunSessionInfo; ready: boolean }

export class Runner {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Job[]>();
  private readonly active = new Map<string, Job>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  private readonly checked = new Map<string, { at: number; status: EnvironmentStatus }>();
  private closed = false;

  constructor(private readonly o: {
    root: string;
    stateDir: string;
    plugins: RunPlugins;
    options: RunOptions | undefined;
    broadcast: (path: string, message: RoomMessage) => void;
    log: (m: string) => void;
    idleMs?: number;
  }) {
    const opts = o.options;
    for (const id of opts?.engines ?? []) if (!o.plugins.engines.has(id)) throw new Error(`Unknown engine "${id}". Known: ${[...o.plugins.engines.keys()].join(', ') || 'none'}.`);
    for (const id of opts?.environments ?? []) if (!o.plugins.environments.has(id)) throw new Error(`Unknown environment "${id}". Known: ${[...o.plugins.environments.keys()].join(', ') || 'none'}.`);
  }

  get enabled(): boolean {
    return !!this.o.options?.engines.length && !!this.o.options.environments.length;
  }

  private get engines(): Engine[] {
    return (this.o.options?.engines ?? []).map((id) => this.o.plugins.engines.get(id)!);
  }

  /** The engine that runs chunks of `name` (a chunk's engine, e.g. `r`). */
  engineFor(name: string): Engine | undefined {
    return this.engines.find((e) => e.handles.includes(name.toLowerCase()));
  }

  private async config(): Promise<WorkspaceRunConfig> {
    try {
      const parsed = JSON.parse(await readFile(join(this.o.root, '.kuraa', 'run.json'), 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as WorkspaceRunConfig) : {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.o.log(`.kuraa/run.json is not valid JSON; ignoring it (${(e as Error).message})`);
      return {};
    }
  }

  /** The environment for this workspace: the one it asks for if allowed, else the operator's default. */
  private environmentFor(config: WorkspaceRunConfig): Environment | null {
    const allowed = this.o.options?.environments ?? [];
    const asked = typeof config.environment === 'string' && allowed.includes(config.environment) ? config.environment : allowed[0];
    return asked ? this.o.plugins.environments.get(asked)! : null;
  }

  private async status(env: Environment): Promise<EnvironmentStatus> {
    const hit = this.checked.get(env.id);
    if (hit && Date.now() - hit.at < 10_000) return hit.status;
    const status = await env.check(this.o.options?.options?.[env.id]).catch((e: Error) => ({ available: false, message: e.message }));
    this.checked.set(env.id, { at: Date.now(), status });
    return status;
  }

  async describe(): Promise<RunDescription> {
    if (!this.enabled) return { enabled: false, engines: [], environment: null };
    const env = this.environmentFor(await this.config())!;
    const status = await this.status(env);
    return {
      enabled: true,
      engines: this.engines.map((e) => ({ id: e.id, label: e.label, handles: e.handles })),
      environment: { id: env.id, label: env.label, sandboxed: env.sandboxed, ...status },
    };
  }

  private policy(config: WorkspaceRunConfig): Policy {
    const opts = this.o.options!;
    const access = config.access ?? {};
    const wantsWrite = access.workspace === 'read-write';
    const wantsNetwork = access.network === true;
    if (wantsWrite && !opts.allowWorkspaceWrite) this.o.log('the workspace asks to write to itself; this host does not allow it');
    if (wantsNetwork && !opts.allowNetwork) this.o.log('the workspace asks for the network; this host does not allow it');
    return {
      ...DEFAULT_POLICY,
      workspace: wantsWrite && opts.allowWorkspaceWrite ? 'read-write' : 'read-only',
      network: wantsNetwork && opts.allowNetwork === true,
      memory: opts.memory ?? DEFAULT_POLICY.memory,
      cpus: opts.cpus ?? DEFAULT_POLICY.cpus,
    };
  }

  private cacheFile(path: string): string {
    return join(this.o.stateDir, 'outputs', createHash('sha1').update(path).digest('hex') + '.json');
  }

  /** The latest run of each chunk, as cached. */
  async outputs(path: string): Promise<RunRecord[]> {
    try {
      return (JSON.parse(await readFile(this.cacheFile(path), 'utf8')) as { runs: RunRecord[] }).runs;
    } catch {
      return [];
    }
  }

  session(path: string): RunSessionInfo {
    const s = [...this.sessions.entries()].find(([k]) => k.startsWith(`${path}\0`))?.[1];
    return s?.info ?? { path, engine: null, environment: null, state: 'none', message: null };
  }

  /** Runs for a document that have not finished, in order. */
  pending(path: string): RunRecord[] {
    const active = this.active.get(path);
    return [...(active ? [active.record] : []), ...(this.queues.get(path) ?? []).map((j) => j.record)];
  }

  /** Queue code from a chunk of the document at `path`. */
  run(path: string, req: { engine: Engine; code: string; header: string; chunk: ChunkRef; by: PresenceUser }): RunRecord {
    const record: RunRecord = {
      id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      path, chunk: req.chunk, state: 'queued', outputs: [],
      by: { name: req.by.name, color: req.by.color },
      queuedAt: new Date().toISOString(), finishedAt: null, ms: null,
    };
    const queue = this.queues.get(path) ?? [];
    queue.push({ record, engine: req.engine, code: req.code, header: req.header });
    this.queues.set(path, queue);
    this.o.broadcast(path, { type: 'run', run: record });
    void this.pump(path);
    return record;
  }

  private setInfo(path: string, s: Session, state: RunSessionInfo['state'], message: string | null = s.info.message): void {
    s.info = { path, engine: s.engine.id, environment: s.environment.id, state, message };
    this.o.broadcast(path, { type: 'run-session', session: s.info });
  }

  /** The document's session for an engine, opened if needed. */
  private async sessionFor(path: string, engine: Engine): Promise<Session> {
    const key = `${path}\0${engine.id}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const config = await this.config();
    const environment = this.environmentFor(config)!;
    const status = await this.status(environment);
    if (!status.available) throw new Error(status.message);
    const pathHash = createHash('sha1').update(path).digest('hex').slice(0, 12);
    const s: Session = { engine, environment, ready: false, info: { path, engine: engine.id, environment: environment.id, state: 'starting', message: null }, session: null! };
    this.sessions.set(key, s);
    this.setInfo(path, s, 'starting', null);
    s.session = engine.open({
      environment,
      environmentOptions: this.o.options?.options?.[environment.id],
      workspace: this.o.root,
      scratch: join(this.o.stateDir, 'run', 'scratch', pathHash),
      files: join(this.o.stateDir, 'run', 'engines', engine.id),
      policy: this.policy(config),
      requirements: config[engine.id],
      options: this.o.options?.options?.[engine.id],
      log: (m) => this.o.log(`${engine.id} (${path}): ${m}`),
      status: (m) => this.setInfo(path, s, s.ready ? s.info.state : 'starting', m),
    });
    void s.session.ended.then((why) => {
      if (this.sessions.get(key) !== s) return;
      this.sessions.delete(key);
      this.setInfo(path, s, s.ready ? 'stopped' : 'failed', why);
    });
    return s;
  }

  private async pump(path: string): Promise<void> {
    if (this.active.has(path) || this.closed) return;
    const job = this.queues.get(path)?.shift();
    if (!job) {
      this.scheduleIdle(path);
      return;
    }
    clearTimeout(this.idle.get(path));
    this.active.set(path, job);
    const { record } = job;
    record.state = 'running';
    this.o.broadcast(path, { type: 'run', run: record });
    const started = Date.now();
    try {
      const s = await this.sessionFor(path, job.engine);
      const version = await s.session.ready;
      if (!s.ready) {
        s.ready = true;
        this.setInfo(path, s, 'ready', version);
      }
      this.setInfo(path, s, 'busy');
      try {
        const result = await s.session.run({ id: record.id, code: job.code, header: job.header, dir: dirname(resolve(this.o.root, path)) });
        record.outputs = tidy(result.outputs);
        record.state = result.interrupted ? 'interrupted' : record.outputs.some((o) => o.type === 'error') ? 'failed' : 'done';
        if (result.interrupted) record.outputs.push({ type: 'note', text: 'Interrupted.' });
      } finally {
        if (this.sessions.get(`${path}\0${job.engine.id}`) === s) this.setInfo(path, s, 'ready');
      }
    } catch (e) {
      record.state = 'failed';
      record.outputs.push({ type: 'error', text: (e as Error).message });
    }
    record.ms = Date.now() - started;
    record.finishedAt = new Date().toISOString();
    this.active.delete(path);
    this.o.broadcast(path, { type: 'run', run: record });
    await this.remember(record).catch((e) => this.o.log(`could not cache outputs: ${e}`));
    void this.pump(path);
  }

  /** Keep the latest run of each chunk: same label, or same position among unlabelled chunks, or same code. */
  private async remember(record: RunRecord): Promise<void> {
    if (record.state === 'cancelled') return;
    const c = record.chunk;
    const same = (r: RunRecord) =>
      (c.label !== null && r.chunk.label === c.label) ||
      (c.label === null && r.chunk.label === null && r.chunk.index === c.index) ||
      r.chunk.codeHash === c.codeHash;
    const runs = [...(await this.outputs(record.path)).filter((r) => !same(r)), record];
    const file = this.cacheFile(record.path);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ path: record.path, runs }));
    await rename(tmp, file);
  }

  /** Forget one chunk's output, or all of a document's. */
  async clear(path: string, chunk?: ChunkRef): Promise<void> {
    const runs = chunk
      ? (await this.outputs(path)).filter((r) => !(r.chunk.index === chunk.index && r.chunk.label === chunk.label && r.chunk.codeHash === chunk.codeHash))
      : [];
    const file = this.cacheFile(path);
    if (!runs.length) await rm(file, { force: true });
    else await writeFile(file, JSON.stringify({ path, runs }));
  }

  private sessionsOf(path: string): [string, Session][] {
    return [...this.sessions.entries()].filter(([k]) => k.startsWith(`${path}\0`));
  }

  /** Stop what is running for a document, and drop what is queued. */
  interrupt(path: string): void {
    for (const job of this.queues.get(path)?.splice(0) ?? []) {
      job.record.state = 'cancelled';
      job.record.finishedAt = new Date().toISOString();
      this.o.broadcast(path, { type: 'run', run: job.record });
    }
    for (const [, s] of this.sessionsOf(path)) s.session.interrupt();
  }

  /** Fresh sessions for a document: everything defined so far is gone. */
  async restart(path: string): Promise<void> {
    this.interrupt(path);
    const sessions = this.sessionsOf(path);
    for (const [k] of sessions) this.sessions.delete(k);
    await Promise.all(sessions.map(([, s]) => s.session.stop()));
    this.o.broadcast(path, { type: 'run-session', session: { path, engine: null, environment: null, state: 'none', message: 'Restarted.' } });
  }

  /** A document's sessions have been idle for idleMs: stop them to give the memory back. */
  private scheduleIdle(path: string): void {
    clearTimeout(this.idle.get(path));
    this.idle.set(path, setTimeout(() => {
      if (this.active.has(path)) return;
      for (const [k, s] of this.sessionsOf(path)) {
        this.sessions.delete(k);
        void s.session.stop().then(() => this.o.log(`stopped idle ${s.engine.id} session for ${path}`));
      }
    }, this.o.idleMs ?? 60 * 60 * 1000).unref());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.idle.values()) clearTimeout(t);
    for (const path of this.queues.keys()) this.interrupt(path);
    await Promise.all([...this.sessions.values()].map((s) => s.session.stop().catch(() => undefined)));
    this.sessions.clear();
  }
}

/** Merge adjacent text, and cap its size. */
function tidy(outputs: ChunkOutput[]): ChunkOutput[] {
  const out: ChunkOutput[] = [];
  for (const o of outputs) {
    const prev = out[out.length - 1];
    if (o.type === 'text' && prev?.type === 'text') prev.text += o.text;
    else out.push({ ...o });
  }
  for (const o of out) {
    if ('text' in o && o.text.length > MAX_TEXT) o.text = `${o.text.slice(0, MAX_TEXT)}\n… (${o.text.length - MAX_TEXT} more characters not shown)`;
  }
  return out;
}
