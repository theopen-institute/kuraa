// Running code chunks, through run components.
//
// The runner knows no language and no place to run code: engines and
// environments come from components (see @kuraa/run-kit and components.ts). For
// each document and engine it opens a session in the environment, runs requests
// one at a time, broadcasts each run's progress and outputs to everyone with the
// document open, and caches the latest output of each chunk in
// .git/kuraa/outputs (never in the document).
//
// A session may be interrupted, restarted or left idle at any point, also while
// it is still starting (restoring packages, building an image): a run waiting
// for it is then cancelled, and a session dropped before it opened never opens.
//
// Who decides what: the operator (host options, from flags) loads components,
// turns engines on, chooses the environment and sets the limits; an environment
// that is not sandboxed only if they say so. A workspace may ask, in
// .kuraa/run.json, for what its engines need (an image, packages) and for more
// access (writing the workspace, the network); it gets more access only where
// the operator allows it. If the environment is unavailable, nothing runs.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_POLICY, parseSize,
  type ChunkOutput, type ComponentContext, type Engine, type EngineSession, type Environment, type EnvironmentStatus,
  type DocumentRenderer, type PackageContext, type PackageInfo, type PackageResult, type Policy, type RenderContext, type RunComponent,
} from '@kuraa/run-kit';
import type { ChunkRef, PresenceUser, RoomMessage, RunRecord, RunSessionInfo, RunStep } from '@kuraa/session/server';
import type { RunComponents } from './components.js';
import { renameOver } from './files.js';

export interface RunOptions {
  /** Engines to turn on, by id: ['r']. None: running is off. */
  engines: string[];
  /** Where code runs, by environment id: 'podman'. Default: the only environment loaded. */
  environment?: string;
  /**
   * Run components: engines and environments, as modules or by path or package
   * name. The host loads none of its own (@kuraa/run-components has those that ship).
   */
  components?: (RunComponent | string)[];
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
  /** The most each process may write (scratch, its temporary files), e.g. '2g'. */
  disk?: string;
  /**
   * Let people install packages (install.packages() in a chunk, the Packages
   * panel). Installs run apart from the workspace, with the network.
   */
  allowInstalls?: boolean;
  /** Where engines keep what is shared by every workspace (a package cache). Default: the user's app data folder. */
  dataDir?: string;
  /** The longest a render of a document may take once its process has started, in ms (default: 10 minutes). */
  renderTimeoutMs?: number;
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
/** The most outputs a run keeps (a loop that draws ten thousand plots, say). */
const MAX_OUTPUTS = 1000;
/** The most steps a session's history keeps (the oldest go first). */
const MAX_STEPS = 1000;

/** A run waiting for its turn, or running. */
interface Job {
  record: RunRecord;
  engine: Engine;
  code: string;
  header: string;
  /** Interrupt was asked for: a run still waiting for its session to start then never runs. */
  cancel(): void;
  cancelled: Promise<typeof CANCELLED>;
}

const CANCELLED = Symbol('cancelled');

/**
 * A document's session with an engine. Its history is what it has run, in order,
 * so that clients can tell which outputs were computed from code that has since
 * changed (see decision 0024). It is listed as soon as it starts opening (to
 * show progress), so `session` is null until the engine has opened it.
 */
interface Session {
  key: string;
  path: string;
  id: string;
  engine: Engine;
  environment: Environment;
  /** The engine's session, once opened. */
  session: EngineSession | null;
  opened: Promise<EngineSession>;
  /** Restarted, stopped or ended: no longer the document's session, and not to be opened. */
  dropped: boolean;
  info: RunSessionInfo;
  ready: boolean;
  history: RunStep[];
}

const NO_SESSION = (path: string, message: string | null = null): RunSessionInfo => ({ path, engine: null, environment: null, state: 'none', message, id: null, steps: [] });

/**
 * Add a run to a history. An earlier run of the same chunk and code adds nothing
 * the later one does not, so it goes; but a line or selection run again from a
 * chunk that has run in full leaves that run standing (the session still has it).
 */
function addStep(history: RunStep[], step: RunStep, partial: boolean): void {
  const same = history.findIndex((h) => h.label === step.label && h.index === step.index && h.codeHash === step.codeHash);
  if (same >= 0 && partial && history[same]!.complete) return;
  if (same >= 0) history.splice(same, 1);
  history.push(step);
  if (history.length > MAX_STEPS) history.splice(0, history.length - MAX_STEPS);
}

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
    components: RunComponents;
    options: RunOptions | undefined;
    broadcast: (path: string, message: RoomMessage) => void;
    /** To everyone with any document of the workspace open. */
    broadcastAll: (message: RoomMessage) => void;
    /** Commit workspace files an engine changed (its package manifest), crediting `by`. */
    commit: (paths: string[], message: string, by: PresenceUser | null) => Promise<void>;
    log: (m: string) => void;
    idleMs?: number;
  }) {
    for (const id of o.options?.engines ?? []) if (!o.components.engines.has(id)) throw new Error(`Unknown engine "${id}". Known: ${[...o.components.engines.keys()].join(', ') || 'none'}.`);
    this.on = [...(o.options?.engines ?? [])];
    this.env = this.chooseEnvironment();
    if (o.options?.disk !== undefined && parseSize(o.options.disk) === null) throw new Error(`--disk takes a size such as 2g, not "${o.options.disk}".`);
    this.dataDir = o.options?.dataDir ?? defaultDataDir();
    this.workspaceKey = createHash('sha1').update(resolve(o.root)).digest('hex').slice(0, 16);
  }

  /** Where engines keep what every workspace shares. */
  private readonly dataDir: string;
  /** A stable short id for the workspace, for what engines keep for it in dataDir. */
  private readonly workspaceKey: string;

  /** Where code runs: the one the operator named, else the only one loaded. */
  private readonly env: Environment | null;

  private chooseEnvironment(): Environment | null {
    const { components, options } = this.o;
    const all = [...components.environments.values()];
    if (options?.environment) {
      const env = components.environments.get(options.environment);
      if (!env) throw new Error(`Unknown environment "${options.environment}". Known: ${all.map((e) => e.id).join(', ') || 'none'}.`);
      return this.checkSandbox(env);
    }
    if (!this.on.length) return all.length === 1 ? all[0]! : null;
    if (all.length === 0) throw new Error('Engines are on, but no environment to run code in is loaded. Load one with --component.');
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

  /** Every engine and environment the loaded components offer, which are on, and whether each environment is there. */
  async catalog(): Promise<{
    engines: { id: string; label: string; description: string; on: boolean }[];
    environments: { id: string; label: string; description: string; sandboxed: boolean; on: boolean; available: boolean; message: string }[];
  }> {
    const { components } = this.o;
    return {
      engines: [...components.engines.values()].map((e) => ({ id: e.id, label: e.label, description: e.description ?? '', on: this.on.includes(e.id) })),
      environments: await Promise.all([...components.environments.values()].map(async (e) => ({
        id: e.id, label: e.label, description: e.description ?? '', sandboxed: e.sandboxed,
        on: this.enabled && e === this.env, ...(await this.status(e)),
      }))),
    };
  }

  private get engines(): Engine[] {
    return this.on.map((id) => this.o.components.engines.get(id)!);
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
      disk: opts.disk ?? DEFAULT_POLICY.disk,
    };
  }

  private installs: Promise<unknown> = Promise.resolve();
  private recorded = new Set<string>();

  /** What an engine's sessions and its package manager both get, for this workspace. */
  private context(engine: Engine, config: WorkspaceRunConfig): ComponentContext {
    const environment = this.env!;
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
      log: (m) => this.o.log(`${engine.id}: ${m}`),
      status: (m) => this.o.broadcastAll({ type: 'packages', engine: engine.id, message: m }),
    };
  }

  /** The environment, if it can run processes now; else why not. */
  private async available(): Promise<Environment> {
    const status = await this.status(this.env!);
    if (!status.available) throw new Error(status.message);
    return this.env!;
  }

  /** The engine that renders a file, by its extension (renders.ts), if one that is on does. */
  rendererFor(path: string): { engine: Engine; renderer: DocumentRenderer } | null {
    const dot = path.lastIndexOf('.');
    const ext = dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
    if (!this.enabled || !ext) return null;
    for (const engine of this.engines) if (engine.render?.extensions.includes(ext)) return { engine, renderer: engine.render };
    return null;
  }

  /**
   * What a render works with: as a session's, but the workspace only read and no
   * network, whatever the workspace asks for. Throws, saying why, if the
   * environment is not there.
   */
  async renderContext(engine: Engine, scratch: string, signal: AbortSignal, status: (m: string) => void): Promise<RenderContext> {
    await this.available();
    const ctx = this.context(engine, await this.config());
    return {
      ...ctx,
      policy: { ...ctx.policy, workspace: 'read-only', network: false },
      scratch,
      timeLimitMs: this.o.options?.renderTimeoutMs ?? 10 * 60_000,
      signal,
      log: (m) => this.o.log(`${engine.id} render: ${m}`),
      status,
    };
  }

  /** What a package manager works with, for this workspace, crediting `by`. */
  private async packageContext(engine: Engine, by: PresenceUser | null): Promise<PackageContext> {
    await this.available();
    return {
      ...this.context(engine, await this.config()),
      log: (m) => this.o.log(`${engine.id} packages: ${m}`),
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
    if (!this.o.options?.allowInstalls) return { ok: false, message: 'Installing packages is turned off on this server; whoever runs it can turn it on.', log: '', restart: false };
    const engine = this.packagesOf(engineId);
    const result = await this.queueInstall(async () => engine.packages.install(await this.packageContext(engine, by), refs));
    this.o.broadcastAll({ type: 'packages', engine: engine.id, message: result.message });
    return result;
  }

  async removePackages(engineId: string, names: string[], by: PresenceUser | null): Promise<PackageResult> {
    if (!this.o.options?.allowInstalls) return { ok: false, message: 'Changing packages is turned off on this server; whoever runs it can turn it on.', log: '', restart: false };
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

  private readonly cacheChanges = new Map<string, Promise<unknown>>();

  /**
   * Change a document's cached runs. One change at a time per document (a run
   * finishing and a clear would otherwise each write over the other), each
   * written whole, so a reader never finds half a file and loses every output.
   */
  private changeCache(path: string, change: (runs: RunRecord[]) => RunRecord[]): Promise<void> {
    const next = (this.cacheChanges.get(path) ?? Promise.resolve()).then(async () => {
      const runs = change(await this.outputs(path));
      const file = this.cacheFile(path);
      if (!runs.length) return rm(file, { force: true });
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ path, runs }));
      await renameOver(tmp, file);
    });
    const settled = next.catch(() => undefined);
    this.cacheChanges.set(path, settled);
    void settled.then(() => {
      if (this.cacheChanges.get(path) === settled) this.cacheChanges.delete(path);
    });
    return next;
  }

  private sessionsOf(path: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.path === path);
  }

  session(path: string): RunSessionInfo {
    return this.sessionsOf(path)[0]?.info ?? NO_SESSION(path);
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
      path, chunk: req.chunk, engine: req.engine.id, state: 'queued', outputs: [],
      by: { name: req.by.name, color: req.by.color },
      queuedAt: new Date().toISOString(), finishedAt: null, ms: null,
    };
    let cancel!: () => void;
    const cancelled = new Promise<typeof CANCELLED>((resolve) => (cancel = () => resolve(CANCELLED)));
    const queue = this.queues.get(path) ?? [];
    queue.push({ record, engine: req.engine, code: req.code, header: req.header, cancel, cancelled });
    this.queues.set(path, queue);
    this.o.broadcast(path, { type: 'run', run: record });
    void this.pump(path);
    return record;
  }

  /** Tell everyone how a live session is doing; nothing once it has been dropped. */
  private setInfo(s: Session, state: 'starting' | 'ready' | 'busy', message: string | null = s.info.message): void {
    if (this.sessions.get(s.key) !== s) return;
    s.info = { path: s.path, engine: s.engine.id, environment: s.environment.id, state, message, id: s.id, steps: [...s.history] };
    this.o.broadcast(s.path, { type: 'run-session', session: s.info });
  }

  /** Drop a session that is still the document's, telling everyone why. Its process is stopped by whoever drops it, if it is not already gone. */
  private forget(s: Session, state: 'stopped' | 'failed', why: string | null): boolean {
    if (this.sessions.get(s.key) !== s) return false;
    this.sessions.delete(s.key);
    s.dropped = true;
    s.info = { path: s.path, engine: s.engine.id, environment: s.environment.id, state, message: why, id: null, steps: [] };
    this.o.broadcast(s.path, { type: 'run-session', session: s.info });
    return true;
  }

  /** Stop a session's process, even one still opening (it then never starts). */
  private stopSession(s: Session): Promise<void> {
    s.dropped = true;
    return s.session ? s.session.stop().catch((e: Error) => this.o.log(`could not stop ${s.engine.id} (${s.path}): ${e.message}`)) : Promise.resolve();
  }

  /** The document's session for an engine, opening it if needed. */
  private sessionFor(path: string, engine: Engine): Session {
    const key = `${path}\0${engine.id}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const s: Session = {
      key, path, id: randomBytes(6).toString('hex'), engine, environment: this.env!,
      session: null, opened: null!, dropped: false, ready: false, history: [], info: NO_SESSION(path),
    };
    this.sessions.set(key, s);
    this.setInfo(s, 'starting', null);
    s.opened = this.open(s);
    s.opened.catch((e: Error) => this.forget(s, 'failed', e.message));
    return s;
  }

  private async open(s: Session): Promise<EngineSession> {
    const { engine, path } = s;
    await this.available();
    const config = await this.config();
    // A fresh clone, or another machine: install what the workspace's manifest lists.
    if (engine.packages && this.o.options?.allowInstalls) {
      const pkgs = engine.packages;
      const restored = await this.queueInstall(async () => {
        const pctx = await this.packageContext(engine, null);
        return pkgs.restore({ ...pctx, status: (m) => this.setInfo(s, 'starting', m) });
      }).catch((e: Error) => ({ ok: false, message: e.message, log: '', restart: false }));
      if (restored && !restored.ok) this.o.log(`${engine.id} (${path}): restoring packages failed: ${restored.message}\n${restored.log}`);
    }
    // Restarted (or the host closed) while the packages were restored: open nothing.
    if (s.dropped) throw new Error('The session was stopped before it started.');
    const byNow = () => this.active.get(path)?.record.by ? { ...this.active.get(path)!.record.by, email: '' } : null;
    // Scratch of its own, emptied: what an earlier session left (all it was allowed to write, say) is not this one's.
    const scratch = join(this.o.stateDir, 'run', 'scratch', `${createHash('sha1').update(path).digest('hex').slice(0, 12)}-${engine.id}`);
    await mkdir(scratch, { recursive: true });
    await emptyDir(scratch);
    if (s.dropped) throw new Error('The session was stopped before it started.');
    const session = engine.open({
      ...this.context(engine, config),
      scratch,
      install: (refs) => this.installPackages(engine.id, refs, byNow()),
      remove: (names) => this.removePackages(engine.id, names, byNow()),
      usedFromEnvironment: (used) => {
        const fresh = used.filter((p) => !this.recorded.has(`${engine.id}:${p.name}@${p.version}`));
        if (!fresh.length || !engine.packages) return;
        for (const p of fresh) this.recorded.add(`${engine.id}:${p.name}@${p.version}`);
        const by = byNow();
        void this.queueInstall(async () => engine.packages!.recordUsed(await this.packageContext(engine, by), fresh))
          .catch((e: Error) => this.o.log(`could not record packages: ${e.message}`));
      },
      log: (m) => this.o.log(`${engine.id} (${path}): ${m}`),
      status: (m) => this.setInfo(s, s.ready ? (s.info.state as 'ready' | 'busy') : 'starting', m),
    });
    s.session = session;
    void session.ended.then((why) => this.forget(s, s.ready ? 'stopped' : 'failed', why));
    return session;
  }

  /** `p`, unless the job is interrupted first. */
  private async unlessCancelled<T>(job: Job, p: Promise<T>): Promise<T> {
    const r = await Promise.race([p, job.cancelled]);
    if (r === CANCELLED) throw CANCELLED;
    return r as T;
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
      await this.execute(path, job);
    } catch (e) {
      // Interrupted before the session could run it: it never ran, as if it had still been queued.
      if (e === CANCELLED) record.state = 'cancelled';
      else {
        record.state = 'failed';
        record.outputs.push({ type: 'error', text: (e as Error).message });
      }
    }
    record.ms = Date.now() - started;
    record.finishedAt = new Date().toISOString();
    this.active.delete(path);
    this.o.broadcast(path, { type: 'run', run: record });
    await this.remember(record).catch((e) => this.o.log(`could not cache outputs: ${e}`));
    void this.pump(path);
  }

  private async execute(path: string, job: Job): Promise<void> {
    const { record } = job;
    const s = this.sessionFor(path, job.engine);
    const session = await this.unlessCancelled(job, s.opened);
    const version = await this.unlessCancelled(job, session.ready);
    if (!s.ready) {
      s.ready = true;
      this.setInfo(s, 'ready', version);
    }
    record.basis = { session: s.id, steps: [...s.history] };
    this.setInfo(s, 'busy');
    try {
      const result = await session.run({ id: record.id, code: job.code, header: job.header, dir: dirname(resolve(this.o.root, path)) });
      record.outputs = tidy(result.outputs);
      record.state = result.interrupted ? 'interrupted' : record.outputs.some((o) => o.type === 'error') ? 'failed' : 'done';
      if (result.interrupted) record.outputs.push({ type: 'note', text: 'Interrupted.' });
    } finally {
      const { label, index, codeHash, partial } = record.chunk;
      addStep(s.history, { label, index, codeHash, complete: !partial && record.state === 'done' }, !!partial);
      this.setInfo(s, 'ready');
    }
  }

  /** Keep the latest run of each chunk: same label, or same position among unlabelled chunks, or same code. */
  private async remember(record: RunRecord): Promise<void> {
    if (record.state === 'cancelled') return;
    const c = record.chunk;
    const same = (r: RunRecord) =>
      (c.label !== null && r.chunk.label === c.label) ||
      (c.label === null && r.chunk.label === null && r.chunk.index === c.index) ||
      r.chunk.codeHash === c.codeHash;
    await this.changeCache(record.path, (runs) => [...runs.filter((r) => !same(r)), record]);
  }

  /** Forget one chunk's output, or all of a document's. */
  async clear(path: string, chunk?: ChunkRef): Promise<void> {
    await this.changeCache(path, (runs) => chunk
      ? runs.filter((r) => !(r.chunk.index === chunk.index && r.chunk.label === chunk.label && r.chunk.codeHash === chunk.codeHash))
      : []);
  }

  /** Stop what is running for a document, and drop what is queued. */
  interrupt(path: string): void {
    for (const job of this.queues.get(path)?.splice(0) ?? []) {
      job.record.state = 'cancelled';
      job.record.finishedAt = new Date().toISOString();
      this.o.broadcast(path, { type: 'run', run: job.record });
    }
    this.active.get(path)?.cancel();
    for (const s of this.sessionsOf(path)) s.session?.interrupt();
  }

  /** Fresh sessions for a document: everything defined so far is gone. */
  async restart(path: string): Promise<void> {
    this.interrupt(path);
    const sessions = this.sessionsOf(path);
    for (const s of sessions) this.sessions.delete(s.key);
    await Promise.all(sessions.map((s) => this.stopSession(s)));
    this.o.broadcast(path, { type: 'run-session', session: NO_SESSION(path, 'Restarted.') });
  }

  /** A document's sessions have been idle for idleMs: stop them to give the memory back. */
  private scheduleIdle(path: string): void {
    clearTimeout(this.idle.get(path));
    this.idle.set(path, setTimeout(() => {
      this.idle.delete(path);
      if (this.active.has(path) || this.queues.get(path)?.length) return;
      for (const s of this.sessionsOf(path)) {
        // Its history goes with it: everyone must see that nothing has run now (decision 0024).
        this.forget(s, 'stopped', 'Stopped after a while without runs. The next run starts afresh.');
        void this.stopSession(s).then(() => this.o.log(`stopped idle ${s.engine.id} session for ${path}`));
      }
    }, this.o.idleMs ?? 60 * 60 * 1000).unref());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.idle.values()) clearTimeout(t);
    this.idle.clear();
    for (const path of new Set([...this.queues.keys(), ...this.active.keys()])) this.interrupt(path);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => this.stopSession(s)));
  }
}

/** Merge adjacent text, and cap its size and the number of outputs. */
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
  if (out.length > MAX_OUTPUTS) out.splice(MAX_OUTPUTS, Infinity, { type: 'note', text: `${out.length - MAX_OUTPUTS} more outputs not shown.` });
  return out;
}

/** Remove what is in a folder, keeping the folder (Podman on a Mac can see one removed and made again as missing). */
async function emptyDir(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(join(dir, n), { recursive: true, force: true })));
}
