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
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_POLICY, parseSize,
  type ChunkOutput, type ComponentContext, type Engine, type EngineSession, type Environment, type EnvironmentStatus,
  type DocumentRenderer, type PackageContext, type PackageInfo, type PackageResult, type Policy, type RenderContext, type RenderTools, type RunComponent,
  type Tool, type ToolUse,
} from '@kuraa/run-kit';
import type { ChunkRef, PresenceUser, RoomMessage, RunRecord, RunSessionInfo, RunStep } from '@kuraa/session/server';
import type { RunComponents } from './components.js';
import { renameOver } from './files.js';
import { ToolStore, type ToolEnv, type ToolInfo, type ToolResult } from './tools.js';

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
   * panel) and download tools and add to them (TeX and its packages, decision
   * 0045). Installs run apart from the workspace, with the network.
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

/** The small file that marks a folder as one kuraa keeps packages and tools in (settings.ts checks for it). */
export const DATA_MARKER = '.kuraa-data';

/** Mark a folder as one kuraa keeps packages and tools in (made if need be); once is enough. */
export async function markDataDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, DATA_MARKER), 'kuraa keeps packages and tools in this folder.\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
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
    this.tools = ToolStore.at(this.dataDir);
    this.unsubscribeTools = this.tools.subscribe(() => o.broadcastAll({ type: 'tools', at: new Date().toISOString() }));
  }

  /** Tools, kept once per computer in the data folder (tools.ts). */
  private readonly tools: ToolStore;
  private readonly unsubscribeTools: () => void;

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
  /** The data folder marked as kuraa's, the first time packages or tools use it. */
  private marked: Promise<void> | null = null;
  private markData(): void {
    this.marked ??= markDataDir(this.dataDir).catch((e: Error) => this.o.log(`could not mark ${this.dataDir} as the data folder: ${e.message}`));
  }
  private recorded = new Set<string>();

  /** What an engine's sessions and its package manager both get, for this workspace. */
  private context(engine: Engine, config: WorkspaceRunConfig): ComponentContext {
    const environment = this.env!;
    this.markData();
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
  async renderContext(engine: Engine, scratch: string, signal: AbortSignal, status: (m: string) => void, tools?: RenderTools): Promise<RenderContext> {
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
      ...(tools ? { tools } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Tools (decision 0045; tools.ts keeps them)

  /** Whether people here may download tools and add to them (and install packages). */
  get allowInstalls(): boolean {
    return !!this.o.options?.allowInstalls;
  }

  tool(id: string): Tool | undefined {
    return this.o.components.tools.get(id);
  }

  /** Where installers run, and the environment's architecture. Throws, saying why, if code cannot run here. */
  private async toolEnv(): Promise<ToolEnv> {
    if (!this.enabled) throw new Error('Running code is turned off on this server, and tools are used only where code runs.');
    const environment = await this.available();
    const { arch } = await this.status(environment);
    return {
      environment,
      options: this.o.options?.options?.[environment.id],
      policy: this.policy({}),
      arch: arch ?? null,
      log: (m) => this.o.log(`tools: ${m}`),
    };
  }

  /** Every tool the components offer, and how each stands on this computer. */
  async listTools(): Promise<{ allowInstalls: boolean; arch: string | null; tools: ToolInfo[] }> {
    const arch = this.enabled ? ((await this.status(this.env!)).arch ?? null) : null;
    const tools = await Promise.all([...this.o.components.tools.values()].map((t) => this.tools.info(t, arch)));
    return { allowInstalls: this.allowInstalls && this.enabled, arch, tools };
  }

  /** Start downloading a tool (or join its download). Resolves once it has started; `done` when it has finished. */
  async downloadTool(id: string): Promise<{ ok: boolean; message: string; done: Promise<ToolResult> }> {
    const tool = this.toolOrThrow(id);
    if (!this.allowInstalls) return refused('Downloading tools is turned off in this server’s Preferences (Let documents install packages and download tools).');
    const env = await this.toolEnv();
    const why = this.tools.cannotInstall(tool, env.arch);
    if (why) return refused(why);
    this.markData();
    const done = this.tools.install(tool, env);
    void done.then((r) => this.o.log(`tools: ${r.message}${r.ok ? '' : `\n${r.log}`}`), (e: Error) => this.o.log(`tools: ${tool.id}: ${e.message}`));
    return { ok: true, message: `Downloading ${tool.label}…`, done };
  }

  async removeTool(id: string): Promise<{ ok: boolean; message: string; done: Promise<ToolResult> }> {
    const tool = this.toolOrThrow(id);
    if (!this.allowInstalls) return refused('Removing tools is turned off in this server’s Preferences (Let documents install packages and download tools).');
    const done = this.tools.remove(tool);
    void done.catch((e: Error) => this.o.log(`tools: could not remove ${tool.id}: ${e.message}`));
    return { ok: true, message: `Removing ${tool.label}…`, done };
  }

  /** Add parts to a tool (LaTeX packages), and record them in the workspace, crediting `by`. */
  async addToolParts(id: string, names: string[], by: PresenceUser | null, status?: (m: string) => void): Promise<ToolResult & { added: string[] }> {
    const tool = this.toolOrThrow(id);
    if (!tool.parts) return { ok: false, message: `${tool.label} has no parts to add.`, log: '', added: [] };
    if (!this.allowInstalls) return { ok: false, message: `Adding ${tool.parts.label} is turned off in this server’s Preferences (Let documents install packages and download tools).`, log: '', added: [] };
    const result = await this.tools.addParts(tool, names, await this.toolEnv(), status);
    if (result.added.length) await this.recordParts(tool, result.added, by).catch((e: Error) => this.o.log(`could not record ${tool.parts!.label}: ${e.message}`));
    return result;
  }

  private toolOrThrow(id: string): Tool {
    const tool = this.tool(id);
    if (!tool) throw new Error(`This server has no tool called "${id}".`);
    return tool;
  }

  /** The parts of a tool the workspace records (its documents needed them), checked as the tool would. */
  private async recordedParts(tool: Tool): Promise<string[]> {
    if (!tool.parts) return [];
    try {
      const parsed = JSON.parse(await readFile(join(this.o.root, tool.parts.record), 'utf8')) as { packages?: unknown };
      return Array.isArray(parsed.packages) ? parsed.packages.filter((p): p is string => typeof p === 'string' && tool.parts!.valid(p)) : [];
    } catch {
      return [];
    }
  }

  /** Add parts to the workspace's record (`{ "packages": [...] }`, sorted), and commit it. */
  private async recordParts(tool: Tool, names: string[], by: PresenceUser | null): Promise<void> {
    const parts = tool.parts!;
    const now = await this.recordedParts(tool);
    const fresh = names.filter((n) => !now.includes(n));
    if (!fresh.length) return;
    const file = join(this.o.root, parts.record);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ packages: [...new Set([...now, ...fresh])].sort() }, null, 2)}\n`);
    await this.o.commit([parts.record], `${parts.label}: add ${fresh.join(', ')}`, by);
  }

  /**
   * The tools one render may use (RenderContext.tools), for whoever asked for it:
   * what it used is released when the render has finished, and `repair` adds
   * the parts a failed render's log says were missing.
   */
  renderTools(by: PresenceUser | null, status: (m: string) => void): RenderTools & {
    repair(log: string): Promise<{ ok: boolean; message: string; added: string[] } | null>;
    release(): void;
  } {
    const used = new Map<string, Tool>();
    const releases: (() => void)[] = [];
    const tried = new Set<string>();
    const have = new Map<string, string[]>();
    return {
      use: async (id: string): Promise<ToolUse> => {
        const tool = this.tool(id);
        if (!tool) return { ok: false, reason: 'This server does not offer it.', canDownload: false };
        let env: ToolEnv;
        try {
          env = await this.toolEnv();
        } catch (e) {
          return { ok: false, reason: (e as Error).message, canDownload: false };
        }
        const unsupported = this.tools.cannotInstall(tool, env.arch);
        if (unsupported) return { ok: false, reason: unsupported, canDownload: false };
        // What the workspace's documents needed before (on another computer, say): added first, where allowed.
        const record = env.arch ? await this.tools.record(tool, env.arch) : null;
        if (record && tool.parts && this.allowInstalls) {
          const missing = (await this.recordedParts(tool)).filter((p) => !record.parts.includes(p));
          if (missing.length) {
            status(`Adding the ${tool.parts.label} this workspace uses: ${missing.join(', ')}…`);
            const added = await this.tools.addParts(tool, missing, env, status).catch((e: Error) => ({ ok: false, message: e.message, log: '', added: [] }));
            if (!added.ok) this.o.log(`tools: ${added.message}\n${added.log}`);
          }
        }
        const held = await this.tools.acquire(tool, env.arch);
        if (!held) {
          const busy = this.tools.busy(tool);
          const reason = busy === 'downloading' ? `${tool.label} is being downloaded.`
            : busy === 'removing' ? `${tool.label} is being removed from this computer.`
              : this.allowInstalls ? `${tool.label} is not on this computer yet.`
                : `${tool.label} is not on this computer, and downloading it is turned off on this server.`;
          return { ok: false, reason, canDownload: this.allowInstalls && busy !== 'removing' };
        }
        releases.push(held.release);
        used.set(tool.id, tool);
        have.set(tool.id, held.record.parts);
        const arch = held.record.arch;
        return { ok: true, mounts: [{ host: held.files, inside: tool.inside, access: 'read-only' }], path: tool.path(arch), env: tool.env?.(arch) ?? {} };
      },
      repair: async (log: string) => {
        for (const tool of used.values()) {
          const parts = tool.parts;
          if (!parts) continue;
          const names = parts.missing(log).filter((n) => parts.valid(n) && !tried.has(n) && !have.get(tool.id)?.includes(n));
          if (!names.length) continue;
          if (!this.allowInstalls) {
            return { ok: false, message: `It needs ${parts.label} this computer does not have: ${names.join(', ')}. Adding them is turned off in this server’s Preferences (Let documents install packages and download tools).`, added: [] };
          }
          for (const n of names) tried.add(n);
          status(`Adding ${parts.label}: ${names.join(', ')}…`);
          const result = await this.addToolParts(tool.id, names, by, status).catch((e: Error) => ({ ok: false, message: e.message, log: '', added: [] as string[] }));
          if (!result.added.length) return { ok: false, message: result.message, added: [] };
          have.set(tool.id, [...(have.get(tool.id) ?? []), ...result.added]);
          return { ok: true, message: result.message, added: result.added };
        }
        return null;
      },
      release: () => {
        for (const r of releases.splice(0)) r();
      },
    };
  }

  /** What to offer people for a tool a render needs: its name and size, if they may download it here. */
  toolOffer(id: string): { tool: string; label: string; downloadBytes: number } | null {
    const tool = this.tool(id);
    return tool && this.allowInstalls ? { tool: tool.id, label: tool.label, downloadBytes: tool.downloadBytes } : null;
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
    if (!this.o.options?.allowInstalls) return { ok: false, message: 'Installing packages is turned off in this server’s Preferences (Let documents install packages and download tools).', log: '', restart: false };
    const engine = this.packagesOf(engineId);
    const result = await this.queueInstall(async () => engine.packages.install(await this.packageContext(engine, by), refs));
    this.o.broadcastAll({ type: 'packages', engine: engine.id, message: result.message });
    return result;
  }

  async removePackages(engineId: string, names: string[], by: PresenceUser | null): Promise<PackageResult> {
    if (!this.o.options?.allowInstalls) return { ok: false, message: 'Changing packages is turned off in this server’s Preferences (Let documents install packages and download tools).', log: '', restart: false };
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

  /** Cache files as last read, by name: read again only once changed (another device's publish asks for all of them). */
  private readonly parsed = new Map<string, { mtimeMs: number; size: number; path: string; runs: RunRecord[] }>();

  /** Every document's cached runs (for sharing them with the workspace's other devices: peers/outputs.ts). */
  async cached(): Promise<{ path: string; runs: RunRecord[] }[]> {
    const dir = join(this.o.stateDir, 'outputs');
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
    const out: { path: string; runs: RunRecord[] }[] = [];
    for (const name of names) {
      try {
        const file = join(dir, name);
        const { mtimeMs, size } = await stat(file);
        let c = this.parsed.get(name);
        if (!c || c.mtimeMs !== mtimeMs || c.size !== size) {
          const v = JSON.parse(await readFile(file, 'utf8')) as { path?: unknown; runs?: unknown };
          if (typeof v.path !== 'string' || !Array.isArray(v.runs)) continue;
          c = { mtimeMs, size, path: v.path, runs: v.runs as RunRecord[] };
          this.parsed.set(name, c);
        }
        out.push({ path: c.path, runs: c.runs });
      } catch { /* being written, or not one */ }
    }
    for (const name of this.parsed.keys()) if (!names.includes(name)) this.parsed.delete(name);
    return out;
  }

  private readonly runListeners = new Set<(run: RunRecord) => void>();

  /** Hear of every change to a run (queued, running, finished, cancelled), as people with its document open do. */
  onRun(fn: (run: RunRecord) => void): () => void {
    this.runListeners.add(fn);
    return () => this.runListeners.delete(fn);
  }

  /** Tell people with the document open how a run stands, and whoever listens (peers/outputs.ts: the other devices). */
  private tellRun(path: string, record: RunRecord): void {
    this.o.broadcast(path, { type: 'run', run: record });
    for (const fn of this.runListeners) {
      try {
        fn(record);
      } catch (e) {
        this.o.log(`telling of a run failed: ${(e as Error).message}`);
      }
    }
  }

  private readonly cacheListeners = new Set<(path: string) => void>();

  /** Hear of every change to the cached runs, by document. */
  onCacheChanged(fn: (path: string) => void): () => void {
    this.cacheListeners.add(fn);
    return () => this.cacheListeners.delete(fn);
  }

  private readonly cacheChanges = new Map<string, Promise<unknown>>();

  /**
   * Change a document's cached runs. One change at a time per document (a run
   * finishing and a clear would otherwise each write over the other), each
   * written whole, so a reader never finds half a file and loses every output.
   */
  private changeCache(path: string, change: (runs: RunRecord[]) => RunRecord[]): Promise<void> {
    const next = (this.cacheChanges.get(path) ?? Promise.resolve()).then(async () => {
      const before = await this.outputs(path);
      const runs = change(before);
      if (runs.length === before.length && runs.every((r, i) => r === before[i])) return;
      const file = this.cacheFile(path);
      // Read again next time, whatever its time and size say (a filesystem's times may be coarse).
      this.parsed.delete(basename(file));
      if (!runs.length) await rm(file, { force: true });
      else {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ path, runs }));
        await renameOver(tmp, file);
      }
      for (const fn of this.cacheListeners) fn(path);
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
    this.tellRun(path, record);
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
    this.tellRun(path, record);
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
    this.tellRun(path, record);
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

  /** Forget one chunk's output, or all of a document's. Returns the runs forgotten, by id. */
  async clear(path: string, chunk?: ChunkRef): Promise<string[]> {
    const gone = (r: RunRecord) => !chunk || (r.chunk.index === chunk.index && r.chunk.label === chunk.label && r.chunk.codeHash === chunk.codeHash);
    const ids: string[] = [];
    await this.changeCache(path, (runs) => runs.filter((r) => {
      if (!gone(r)) return true;
      ids.push(r.id);
      return false;
    }));
    return ids;
  }

  /** Forget these runs, wherever they are cached (another device's person cleared them). */
  async forgetRuns(ids: Set<string>): Promise<{ path: string; ids: string[] }[]> {
    const out: { path: string; ids: string[] }[] = [];
    for (const { path, runs } of await this.cached()) {
      if (!runs.some((r) => ids.has(r.id))) continue;
      const gone: string[] = [];
      await this.changeCache(path, (now) => now.filter((r) => {
        if (!ids.has(r.id)) return true;
        gone.push(r.id);
        return false;
      }));
      if (gone.length) out.push({ path, ids: gone });
    }
    return out;
  }

  /** Stop what is running for a document, and drop what is queued. */
  interrupt(path: string): void {
    for (const job of this.queues.get(path)?.splice(0) ?? []) {
      job.record.state = 'cancelled';
      job.record.finishedAt = new Date().toISOString();
      this.tellRun(path, job.record);
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
    this.unsubscribeTools();
    for (const t of this.idle.values()) clearTimeout(t);
    this.idle.clear();
    for (const path of new Set([...this.queues.keys(), ...this.active.keys()])) this.interrupt(path);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => this.stopSession(s)));
  }
}

function refused(message: string): { ok: false; message: string; done: Promise<ToolResult> } {
  return { ok: false, message, done: Promise.resolve({ ok: false, message, log: '' }) };
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
