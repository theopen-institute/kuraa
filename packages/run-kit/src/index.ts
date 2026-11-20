// The contract for running code, as components.
//
// The host knows no language and no place to run code. Both come from components,
// which the operator loads and turns on with flags:
//
//   Engine       a language: how to run its code and report what it produced
//                (engine-r: R through evaluate, as knitr does)
//   Environment  a place processes run, and what they may touch there
//                (env-podman: a locked-down container; others could run them
//                on this computer, or on a remote server)
//
// The two never know each other's implementation. They meet only through this
// contract: an engine asks the environment it is given to start a process
// (StartRequest: a command, the folders it needs, a Policy, and optionally how
// to provision a container), and gets back a running process (SandboxProcess:
// its streams, how to interrupt or end it, and how its paths look from inside).
//
// People using the app are trusted with document content only, so the policy
// matters: an environment says whether it enforces it (`sandboxed`), and a host
// uses one that does not only if its operator says so (--allow-unsandboxed).
//
// A component module exports a RunComponent, with engines, environments or both:
// `export default defineRunComponent({ name, engines, environments })`. The host
// refuses a component whose apiVersion differs from RUN_API_VERSION.
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, posix, win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ChunkOutput } from '@kuraa/session/model';

export type { ChunkOutput };

/** Bumped whenever this contract changes incompatibly. */
export const RUN_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Policy: what a process may touch. Sandboxed environments enforce it.

export interface Policy {
  /** How the process sees the workspace; 'none' for helpers that must not see it (package installers). */
  workspace: 'read-only' | 'read-write' | 'none';
  /** Whether it may use the network. */
  network: boolean;
  /** Memory limit, e.g. '4g'. */
  memory: string;
  /** CPU limit, in CPUs. */
  cpus: number;
  /** Most processes it may run at once. */
  pids: number;
  /**
   * The most it may write to the folders it writes (scratch, and any private
   * temporary space), e.g. '2g': the computer's disk is not its to fill. Folders
   * an engine mounts read-write for itself (a package cache) and a workspace the
   * operator lets it write are not counted. An environment past it ends the
   * process, saying why (SandboxProcess.exited's reason).
   */
  disk: string;
  /**
   * Workspace paths it must not see at all. `.git` by default: code that could
   * write a git hook there would escape the sandbox the next time git runs.
   */
  hide: string[];
}

export const DEFAULT_POLICY: Policy = { workspace: 'read-only', network: false, memory: '4g', cpus: 2, pids: 512, disk: '2g', hide: ['.git'] };

// ---------------------------------------------------------------------------
// Environments

/**
 * The three folders a process gets, as it sees them, and how to translate. On
 * the host they are the workspace, a scratch folder (writable: plots, temporary
 * files), and the engine's files (read-only: a driver script). An environment
 * makes them, and any further mounts, visible to the process at the paths it
 * reports, with the access asked for. One that runs processes elsewhere (a
 * remote server) copies or syncs them; what the process writes to scratch must
 * be back on the host by the time the process reports it (the engine reads
 * plots from there).
 */
export interface PathView {
  workspace: string;
  scratch: string;
  files: string;
  /** A host path inside one of the three folders, as the process sees it. */
  inside(hostPath: string): string;
  /** A path the process gave, as a host path (to read what it wrote to scratch). */
  outside(insidePath: string): string;
}

/** A further host folder the process sees, at a fixed path inside (a package library, say). */
export interface Mount {
  host: string;
  inside: string;
  access: 'read-only' | 'read-write';
}

/**
 * How to provision a container with what an engine's command needs (R and its
 * packages, say). Environments that run containers build it; others ignore it
 * and must already have the program.
 */
export interface ImageRecipe {
  /** A Containerfile. */
  containerfile: string;
  /** Files to put next to it (the build context), by name. */
  context?: Record<string, string>;
}

export interface StartRequest {
  /** A short name, for logs and container names. */
  name: string;
  /** Host folders: see PathView. */
  workspace: string;
  scratch: string;
  files: string;
  /** Further folders, e.g. a package library and cache. */
  mounts?: Mount[];
  policy: Policy;
  /**
   * The command, built once the environment's view of the paths is known.
   * argv[0] is a program name the environment resolves (on its PATH).
   */
  command(view: PathView): { argv: string[]; cwd: string; env?: Record<string, string> };
  /** How to provision a container for the command, for environments that use containers. */
  image?: ImageRecipe;
  log(message: string): void;
  /** Progress the user should see, e.g. while an image builds. */
  status(message: string): void;
}

export interface SandboxProcess {
  /** May fail once the process has ended (EPIPE); an environment keeps such errors from crashing the host. */
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  view: PathView;
  /** Ask the running code to stop (SIGINT). The process should survive it. */
  interrupt(): void;
  /** End the process. */
  kill(): void;
  /**
   * Resolves once the process has ended and what it wrote to stdout and stderr
   * has been read. Never rejects. `reason` says, for people, why the environment
   * ended it, if it did (it went past a limit of the policy).
   */
  exited: Promise<{ code: number | null; signal: string | null; reason?: string }>;
}

export interface EnvironmentStatus {
  available: boolean;
  /** What to tell the user: why it is unavailable, or what it is. */
  message: string;
}

/** A place processes run. Engines start every process through one; see the top of this file. */
export interface Environment {
  id: string;
  /** Where code runs, as a phrase: 'in a Podman container'. */
  label: string;
  /** A sentence on what it is and what it shields (the Components panel). */
  description?: string;
  /**
   * Whether it enforces the Policy, keeping code away from the computer the
   * host runs on. A host uses one that does not only with --allow-unsandboxed.
   */
  sandboxed: boolean;
  /** Whether it can run processes now, and what to tell people (why not, or what it is). */
  check(options: unknown): Promise<EnvironmentStatus>;
  /** Start a process. `options` are the operator's, for this environment. */
  start(req: StartRequest, options: unknown): Promise<SandboxProcess>;
}

// ---------------------------------------------------------------------------
// Engines

/** What the host gives an engine for one workspace: its sessions and its package manager both get this. */
export interface ComponentContext {
  /** Where its processes run: start every one through this. */
  environment: Environment;
  /** The operator's options for the environment, to pass to its start(). */
  environmentOptions: unknown;
  /** The workspace, on the host. */
  workspace: string;
  /** The engine's files for this workspace (read-only to its processes): see PathView. */
  files: string;
  /** The engine's own folder on the host, shared by every workspace (a package cache, say). */
  dataDir: string;
  /** A stable short id for the workspace, for per-workspace things kept in dataDir. */
  workspaceKey: string;
  /** What the workspace's processes may touch, as the operator allows. */
  policy: Policy;
  /**
   * What the workspace asks of this engine (its section of .kuraa/run.json).
   * Unvalidated, and written by people the host does not trust: check it before
   * it reaches a command, a Containerfile or a path.
   */
  requirements: unknown;
  /** The operator's options for this engine. */
  options: unknown;
  log(message: string): void;
  /** Progress people should see. */
  status(message: string): void;
}

export interface EngineContext extends ComponentContext {
  /** The session's scratch folder on the host (writable by its processes): see PathView. */
  scratch: string;
  /** Install packages for the workspace (the host checks it is allowed, and runs one install at a time). */
  install(refs: string[]): Promise<PackageResult>;
  /** Remove packages from the workspace's library. */
  remove(names: string[]): Promise<PackageResult>;
  /** Packages the session loaded from the environment itself (not the workspace's library), to record. */
  usedFromEnvironment(packages: { name: string; version: string }[]): void;
}

export interface RunRequest {
  id: string;
  code: string;
  /** The chunk header, e.g. `r label, fig.width = 6`. */
  header: string;
  /** The document's folder, on the host. */
  dir: string;
}

export interface RunResult {
  outputs: ChunkOutput[];
  interrupted: boolean;
}

/**
 * A running session. The host calls run() one request at a time, and may call
 * interrupt() or stop() at any moment, also while the session is still starting:
 * stop() then must keep its process from starting at all. A session that cannot
 * start rejects `ready` and resolves `ended`.
 */
export interface EngineSession {
  /** Resolves once the session can run code, with a description (e.g. the R version). */
  ready: Promise<string>;
  /**
   * Run code. What the code produced is untrusted: an engine passes on only
   * outputs it has checked, and reads files the process names only inside scratch.
   */
  run(req: RunRequest): Promise<RunResult>;
  interrupt(): void;
  stop(): Promise<void>;
  /** Resolves when the session ends by itself (it exited, or crashed), with why. */
  ended: Promise<string>;
}

export interface Engine {
  id: string;
  label: string;
  /** A sentence on what it does (the Components panel). */
  description?: string;
  /** Chunk engine names it runs, as in a knitr header: ['r']. */
  handles: string[];
  open(ctx: EngineContext): EngineSession;
  /** If the engine manages packages for a workspace. */
  packages?: PackageManager;
  /** If the engine renders documents (R: R Markdown and Markdown, to HTML, Word and PDF). */
  render?: DocumentRenderer;
}

// ---------------------------------------------------------------------------
// Rendering documents: a whole document to a file people read elsewhere (knitting).
// Like a run, a render's processes start through the environment, with the
// workspace read-only and no network, whatever the workspace asks for.

export type RenderFormat = 'html' | 'docx' | 'pdf';

export interface RenderContext extends ComponentContext {
  /**
   * An empty folder on the host for this render, writable by its processes
   * (see PathView): intermediate files and the output go here, never into the
   * workspace.
   */
  scratch: string;
  /**
   * The longest its processes may run once started, in ms (building an image
   * does not count): past it, the renderer ends them and says so.
   */
  timeLimitMs: number;
  /** Aborted when the render is no longer wanted (the host is closing): end its processes. */
  signal: AbortSignal;
}

export interface RenderRequest {
  /** The document, on the host (inside the workspace). */
  input: string;
  format: RenderFormat;
}

export interface RenderResult {
  ok: boolean;
  /**
   * Where the output is, relative to scratch ('out/document.html'). The host
   * reads it from there, refusing links and anything but a plain file: the
   * process that made it ran people's code.
   */
  output?: string;
  /** What to tell people, in plain words: what was made, or why not. */
  message: string;
  /** What the tools said (rmarkdown's and pandoc's log), for when something went wrong. */
  log: string;
}

/** Renders documents of some file types to some formats, through the engine's environment. */
export interface DocumentRenderer {
  /** File extensions it renders, lower case, with the dot: ['.rmd', '.md']. */
  extensions: string[];
  formats: RenderFormat[];
  render(ctx: RenderContext, req: RenderRequest): Promise<RenderResult>;
}

// ---------------------------------------------------------------------------
// Packages: declared per workspace, stored once per host.

export interface PackageInfo {
  name: string;
  version: string;
  /** In the workspace's own library, or part of the environment (its image). */
  source: 'workspace' | 'environment';
}

export interface PackageResult {
  ok: boolean;
  /** What to tell the user. */
  message: string;
  /** The installer's output, for when something went wrong. */
  log: string;
  /** A fresh session is needed to use what changed (e.g. system libraries were added). */
  restart: boolean;
}

export interface PackageContext extends ComponentContext {
  /** Commit files the manager changed in the workspace (its manifest), crediting whoever asked. */
  commit(paths: string[], message: string): Promise<void>;
}

/**
 * Packages for a workspace. Refs and names come from people the host does not
 * trust (the app, code in a chunk, a manifest in the workspace): a manager
 * checks them before they reach an installer or a path.
 */
export interface PackageManager {
  list(ctx: PackageContext): Promise<PackageInfo[]>;
  install(ctx: PackageContext, refs: string[]): Promise<PackageResult>;
  remove(ctx: PackageContext, names: string[]): Promise<PackageResult>;
  /** Bring the workspace's library in line with its manifest (a fresh clone, another machine). Null if nothing to do. */
  restore(ctx: PackageContext): Promise<PackageResult | null>;
  /** Record packages a session used from the environment, so the workspace works where the environment lacks them. */
  recordUsed(ctx: PackageContext, packages: { name: string; version: string }[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Components

export interface RunComponent {
  apiVersion: number;
  name: string;
  /** Languages. */
  engines?: Engine[];
  /** Places to run processes. */
  environments?: Environment[];
}

export function defineRunComponent(component: Omit<RunComponent, 'apiVersion'>): RunComponent {
  return { apiVersion: RUN_API_VERSION, ...component };
}

// ---------------------------------------------------------------------------
// Helpers for components

/** A program on PATH or in one of `dirs` (apps started from the macOS Dock get a short PATH). */
export function findExecutable(name: string, dirs: string[] = []): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const exe = process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name;
  for (const d of [...(process.env.PATH ?? '').split(delimiter), ...dirs, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']) {
    if (d && existsSync(join(d, exe))) return join(d, exe);
  }
  return null;
}

/**
 * A PathView over fixed folders inside, mapping host folders (and mounts) onto
 * them. The longest folder that holds a path wins (scratch may lie inside the
 * workspace on the host), and a path that climbs out of every folder with `..`
 * is refused: a process names paths for the host to read. Host paths follow the
 * host's rules (`hostPaths`; on Windows C:\… with backslashes), paths inside
 * are POSIX.
 */
export function mappedView(host: { workspace: string; scratch: string; files: string }, inside: { workspace: string; scratch: string; files: string }, mounts: Mount[] = [], hostPaths: typeof posix = process.platform === 'win32' ? win32 : posix): PathView {
  const rules = [hostPaths, posix] as const;
  const pairs = [
    ...mounts.map((m) => [hostPaths.normalize(m.host), m.inside] as const),
    ...(['workspace', 'scratch', 'files'] as const).map((k) => [hostPaths.normalize(host[k]), inside[k]] as const),
  ];
  const swap = (p: string, from: 0 | 1) => {
    const { sep } = rules[from];
    const clean = rules[from].normalize(p);
    let best: readonly [string, string] | null = null;
    for (const pair of pairs) {
      const a = pair[from];
      const within = clean === a || clean.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
      if (within && (!best || a.length > best[from].length)) best = pair;
    }
    if (!best) throw new Error(`Not in a shared folder: ${p}`);
    // The rest of the path, with the other side's separators.
    return best[from === 0 ? 1 : 0] + clean.slice(best[from].length).split(sep).join(rules[from === 0 ? 1 : 0].sep);
  };
  return { ...inside, inside: (p) => swap(p, 0), outside: (p) => swap(p, 1) };
}

/** A size as policies give them ('2g', '512m', '100k', or bytes), in bytes; null if it is not one. */
export function parseSize(size: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(size);
  if (!m) return null;
  return Math.floor(Number(m[1]) * 1024 ** ' kmgt'.indexOf((m[2] || ' ').toLowerCase()));
}
