// Running code chunks, through run plugins (see @kuraa/run-kit and plugins.ts).
//
// The runner knows no language and no place to run code: engines and
// environments come from plugins (see @kuraa/run-kit and plugins.ts). For each
// document and engine it opens a session in the environment, runs requests one
// at a time, broadcasts
// each run's progress and outputs to everyone with the document open, and
// caches the latest output of each chunk in .git/kuraa/outputs (never in the
// document).
//
// Who decides what: the operator (host options, from flags) loads plugins,
// turns engines on, chooses the environment and sets the limits; an environment
// that is not sandboxed only if they say so. A workspace may ask, in
// .kuraa/run.json, for what its engines need (an image, packages) and for more
// access (writing the workspace, the network); it gets more access only where
// the operator allows it. If the environment is unavailable, nothing runs.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_POLICY, type ChunkOutput, type Engine, type EngineSession, type Environment, type EnvironmentStatus, type PackageContext, type PackageInfo, type PackageResult, type Policy, type RunPlugin } from '@kuraa/run-kit';
import type { ChunkRef, PresenceUser, RoomMessage, RunRecord, RunSessionInfo } from '@kuraa/session/server';
import type { RunPlugins } from './plugins.js';

export interface RunOptions {
  /** Engines to turn on, by id: ['r']. None: running is off. */
  engines: string[];
  /** Where code runs, by environment id: 'podman'. Default: the only environment loaded. */
  environment?: string;
  /**
   * Run plugins: engines and environments, as modules or by path or package
   * name. The host loads none of its own (@kuraa/run-plugins has those that ship).
   */
  plugins?: (RunPlugin | string)[];
  /** Use an environment that is not sandboxed: code then runs with whatever rights it has there. */
  allowUnsandboxed?: boolean;
  /** Options by engine or environment id: { podman: { podman: '/path/to/podman' } }. */
  options?: Record<string, unknown>;
  /** Let a workspace ask to write to itself (default: read-only). */
  allowWorkspaceWrite?: boolean;
  /** Let a workspace ask for the network (default: none). */
  allowNetwork?: boolean;
  /** Limits for each session. */
  memory?: string;
  cpus?: number;
  /**
   * Let people install packages (install.packages() in a chunk, the Packages
   * panel). Installs run apart from the workspace, with the network.
   */
  allowInstalls?: boolean;
  /** Where engines keep what is shared by every workspace (a package cache). Default: the user's app data folder. */
  dataDir?: string;
}

/** The per-user folder for data shared by workspaces on this computer. */
export function defaultDataDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'kuraa');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'kuraa');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'kuraa');
}

/** What a workspace asks for, in .kuraa/run.json. */
interface WorkspaceRunConfig {
  access?: { workspace?: unknown; network?: unknown };
  [engine: string]: unknown;
}

export interface RunDescription {
  enabled: boolean;
  engines: { id: string; label: string; handles: string[]; packages: boolean }[];
  /** Whether people may install packages here. */
  allowInstalls: boolean;
  /** Where code runs, and whether it is there. */
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
  /** The engines that are on. */
  private readonly on: string[];

  constructor(private readonly o: {
    root: string;
    stateDir: string;
    plugins: RunPlugins;
    options: RunOptions | undefined;
    broadcast: (path: string, message: RoomMessage) => void;
    /** To everyone with any document of the workspace open. */
    broadcastAll: (message: RoomMessage) => void;
    /** Commit workspace files an engine changed (its package manifest), crediting `by`. */
    commit: (paths: string[], message: string, by: PresenceUser | null) => Promise<void>;
    log: (m: string) => void;
    idleMs?: number;
  }) {
    for (const id of o.options?.engines ?? []) if (!o.plugins.engines.has(id)) throw new Error(`Unknown engine "${id}". Known: ${[...o.plugins.engines.keys()].join(', ') || 'none'}.`);
    this.on = [...(o.options?.engines ?? [])];
    this.env = this.chooseEnvironment();
  }

  /** Where code runs: the one the operator named, else the only one loaded. */
  private readonly env: Environment | null;

  private chooseEnvironment(): Environment | null {
    const { plugins, options } = this.o;
    const all = [...plugins.environments.values()];
    if (options?.environment) {
      const env = plugins.environments.get(options.environment);
      if (!env) throw new Error(`Unknown environment "${options.environment}". Known: ${all.map((e) => e.id).join(', ') || 'none'}.`);
      return this.checkSandbox(env);
    }
    if (!this.on.length) return all.length === 1 ? all[0]! : null;
    if (all.length === 0) throw new Error('Engines are on, but no environment to run code in is loaded. Load one with --plugin.');
    if (all.length > 1) throw new Error(`Several environments are loaded (${all.map((e) => e.id).join(', ')}); choose one with --env.`);
    return this.checkSandbox(all[0]!);
  }

  private checkSandbox(env: Environment): Environment {
    if (!env.sandboxed && this.on.length && !this.o.options?.allowUnsandboxed) {
      throw new Error(`The environment "${env.id}" is not sandboxed: code would run ${env.label} with whatever rights it has there. Use it only with --allow-unsandboxed.`);
    }
    return env;
  }

  get enabled(): boolean {
    return this.on.length > 0 && this.env !== null;
  }

  /** The engines that are on, by id. */
  get turnedOn(): string[] {
    return [...this.on];
  }

  /** Every engine and environment the loaded plugins offer, which are on, and whether each environment is there. */
  async catalog(): Promise<{
    engines: { id: string; label: string; description: string; on: boolean }[];
    environments: { id: string; label: string; description: string; sandboxed: boolean; on: boolean; available: boolean; message: string }[];
  }> {
    const { plugins } = this.o;
    return {
      engines: [...plugins.engines.values()].map((e) => ({ id: e.id, label: e.label, description: e.description ?? '', on: this.on.includes(e.id) })),
      environments: await Promise.all([...plugins.environments.values()].map(async (e) => ({
        id: e.id, label: e.label, description: e.description ?? '', sandboxed: e.sandboxed,
        on: this.enabled && e === this.env, ...(await this.status(e)),
      }))),
    };
  }

  private get engines(): Engine[] {
    return this.on.map((id) => this.o.plugins.engines.get(id)!);
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


  private async status(env: Environment): Promise<EnvironmentStatus> {
    const hit = this.checked.get(env.id);
    if (hit && Date.now() - hit.at < 10_000) return hit.status;
    const status = await env.check(this.o.options?.options?.[env.id]).catch((e: Error) => ({ available: false, message: e.message }));
    this.checked.set(env.id, { at: Date.now(), status });
    return status;
  }

  async describe(): Promise<RunDescription> {
    if (!this.enabled) return { enabled: false, engines: [], allowInstalls: false, environment: null };
    const env = this.env!;
    const status = await this.status(env);
    return {
      enabled: true,
      engines: this.engines.map((e) => ({ id: e.id, label: e.label, handles: e.handles, packages: !!e.packages })),
      allowInstalls: !!this.o.options?.allowInstalls,
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

  private get dataDir(): string {
    return this.o.options?.dataDir ?? defaultDataDir();
  }

  private get workspaceKey(): string {
    return createHash('sha1').update(resolve(this.o.root)).digest('hex').slice(0, 16);
  }

  private installs: Promise<unknown> = Promise.resolve();
  private recorded = new Set<string>();

  /** What a package manager works with, for this workspace, crediting `by`. */
  private async packageContext(engine: Engine, by: PresenceUser | null): Promise<PackageContext> {
    const config = await this.config();
    const environment = this.env!;
    const status = await this.status(environment);
    if (!status.available) throw new Error(status.message);
    return {
      environment,
      environmentOptions: this.o.options?.options?.[environment.id],
      workspace: this.o.root,
      files: join(this.o.stateDir, 'run', 'engines', engine.id),
      dataDir: join(this.dataDir, 'engines', engine.id),
      workspaceKey: this.workspaceKey,
      policy: this.policy(config),
      requirements: config[engine.id],
      options: this.o.options?.options?.[engine.id],
      log: (m) => this.o.log(`${engine.id} packages: ${m}`),
      status: (m) => this.o.broadcastAll({ type: 'packages', engine: engine.id, message: m }),
      commit: (paths, message) => this.o.commit(paths, message, by),
    };
  }

  /** One package operation at a time per workspace. */
  private queueInstall<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.installs.then(fn, fn);
    this.installs = run.catch(() => undefined);
    return run;
  }

  private packagesOf(engineId: string): Engine & { packages: NonNullable<Engine['packages']> } {
    const engine = this.engines.find((e) => e.id === engineId);
    if (!engine?.packages) throw new Error(`No engine here manages ${engineId} packages.`);
    return engine as Engine & { packages: NonNullable<Engine['packages']> };
  }

  async listPackages(engineId: string): Promise<PackageInfo[]> {
    const engine = this.packagesOf(engineId);
    return engine.packages.list(await this.packageContext(engine, null));
  }

  async installPackages(engineId: string, refs: string[], by: PresenceUser | null): Promise<PackageResult> {
    if (!this.o.options?.allowInstalls) return { ok: false, message: 'Installing packages is turned off on this host (start it with --allow-installs).', log: '', restart: false };
    const engine = this.packagesOf(engineId);
    const result = await this.queueInstall(async () => engine.packages.install(await this.packageContext(engine, by), refs));
    this.o.broadcastAll({ type: 'packages', engine: engine.id, message: result.message });
    return result;
  }

  async removePackages(engineId: string, names: string[], by: PresenceUser | null): Promise<PackageResult> {
    if (!this.o.options?.allowInstalls) return { ok: false, message: 'Changing packages is turned off on this host (start it with --allow-installs).', log: '', restart: false };
    const engine = this.packagesOf(engineId);
    const result = await this.queueInstall(async () => engine.packages.remove(await this.packageContext(engine, by), names));
    this.o.broadcastAll({ type: 'packages', engine: engine.id, message: result.message });
    return result;
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
    const environment = this.env!;
    const status = await this.status(environment);
    if (!status.available) throw new Error(status.message);
    const pathHash = createHash('sha1').update(path).digest('hex').slice(0, 12);
    const s: Session = { engine, environment, ready: false, info: { path, engine: engine.id, environment: environment.id, state: 'starting', message: null }, session: null! };
    this.sessions.set(key, s);
    this.setInfo(path, s, 'starting', null);
    // A fresh clone, or another machine: install what the workspace's manifest lists.
    if (engine.packages && this.o.options?.allowInstalls) {
      const pkgs = engine.packages;
      const restored = await this.queueInstall(async () => {
        const pctx = await this.packageContext(engine, null);
        return pkgs.restore({ ...pctx, status: (m) => this.setInfo(path, s, 'starting', m) });
      }).catch((e: Error) => ({ ok: false, message: e.message, log: '', restart: false }));
      if (restored && !restored.ok) this.o.log(`${engine.id} (${path}): restoring packages failed: ${restored.message}\n${restored.log}`);
    }
    const byNow = () => this.active.get(path)?.record.by ? { ...this.active.get(path)!.record.by, email: '' } : null;
    s.session = engine.open({
      environment,
      dataDir: join(this.dataDir, 'engines', engine.id),
      workspaceKey: this.workspaceKey,
      install: (refs) => this.installPackages(engine.id, refs, byNow()),
      remove: (names) => this.removePackages(engine.id, names, byNow()),
      usedFromEnvironment: (pkgs) => {
        const fresh = pkgs.filter((p) => !this.recorded.has(`${engine.id}:${p.name}@${p.version}`));
        if (!fresh.length || !engine.packages) return;
        for (const p of fresh) this.recorded.add(`${engine.id}:${p.name}@${p.version}`);
        const by = byNow();
        void this.queueInstall(async () => engine.packages!.recordUsed(await this.packageContext(engine, by), fresh))
          .catch((e: Error) => this.o.log(`could not record packages: ${e.message}`));
      },
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
