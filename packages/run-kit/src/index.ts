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
//   Tool         a toolchain those processes may use, downloaded on request and
//                kept once per computer (tool-tinytex: TeX, for PDFs with LaTeX)
//   Sync         a place the workspace keeps a copy and syncs with, beyond its
//                own devices (sync-git: the online copy). Not about running
//                code, but loaded the same way, so it lives in this contract.
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
// A component module exports a RunComponent, with engines, environments, tools,
// or several: `export default defineRunComponent({ name, engines, environments })`. The host
// refuses a component whose apiVersion differs from RUN_API_VERSION.
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, posix, win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ChunkOutput } from '@kuraa/session/model';

export type { ChunkOutput };
export { readWorkspaceFile, readWorkspaceFileSync, writeWorkspaceFile } from './workspace-files.js';

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
  /**
   * The architecture its processes run on, as `uname -m` names it ('x86_64',
   * 'aarch64'), if it knows: a tool is installed for it, and used only there.
   */
  arch?: string;
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

export type RenderFormat = 'html' | 'docx' | 'pdf' | 'epub';

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
  /**
   * Tools this render may use (TeX, say): see Tool. Absent on a host that offers
   * none. Parts a tool lacks (read from the log of a failed render) are the
   * host's to add: it renders again once they are there.
   */
  tools?: RenderTools;
}

/** Tools for one render. */
export interface RenderTools {
  /**
   * Use a tool in this render: the mounts, PATH and environment variables its
   * processes need, or why it cannot be used. Adds the parts the workspace
   * records first, where the host allows it.
   */
  use(id: string): Promise<ToolUse>;
}

export type ToolUse =
  | {
    ok: true;
    /** Read-only. */
    mounts: Mount[];
    /** Folders inside, to put first on PATH. */
    path: string[];
    env: Record<string, string>;
  }
  | {
    ok: false;
    /** Why not, in plain words. */
    reason: string;
    /**
     * People here may download it (installs are allowed, it exists for this
     * architecture): a renderer then answers with `needs` rather than make do
     * without it.
     */
    canDownload: boolean;
  };

export interface RenderRequest {
  /**
   * The document, on the host: inside the workspace, or, joined from several
   * (0093), a file the host made, with the files it names beside it (a Word
   * template, a cover: 0106), which a renderer reads as they are.
   */
  input: string;
  format: RenderFormat;
  /**
   * Folders on the host (inside the workspace) where what the document refers
   * to (images, a bibliography) is found, besides its own: a folder compiled
   * from documents in several (0093). Renderers that cannot use them leave them.
   */
  resources?: string[];
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
  /**
   * What the document needs that this computer does not have yet, and people
   * here may download: the app offers to, and renders again when it is there.
   */
  needs?: { tool: string };
}

/**
 * A renderer (decision 0107): renders documents without an environment, so
 * without Podman, running no code of theirs. It is given what it reads: the
 * document, and the files of the workspace it refers to only as the host lets
 * it have them (`RendererContext.read`). Where both a renderer and an engine
 * render a file type, the renderer does, unless it says the engine should
 * (`prefersEngine`: a PDF asking for LaTeX) and one is there.
 */
export interface Renderer {
  /** Lower-case letters, digits and dashes. */
  id: string;
  label: string;
  /** File extensions it renders, lower case, with the dot: ['.md']. */
  extensions: string[];
  formats: RenderFormat[];
  /** Why it cannot render to a format here (a program it needs is not on this computer), or null. */
  unavailable(format: RenderFormat): Promise<string | null>;
  /** Why this render is better made where code runs (a PDF asking for LaTeX), or null. */
  prefersEngine?(req: RenderRequest): Promise<string | null>;
  render(ctx: RendererContext, req: RenderRequest): Promise<RenderResult>;
  /**
   * File extensions it converts into Markdown, lower case, with the dot
   * (['.docx', '.rtf']): an import (0116). With `convert`.
   */
  convertsFrom?: string[];
  /**
   * A file of one of those types (`input`, in scratch, put there by the host)
   * as Markdown, with the media it held (images) written under scratch, where
   * the Markdown names them by `media` paths. Given nothing of the workspace.
   */
  convert?(ctx: RendererContext, req: ConvertRequest): Promise<ConvertResult>;
}

/** A file to convert into Markdown (0116). */
export interface ConvertRequest {
  /** The file, in the render's scratch folder. */
  input: string;
}

export interface ConvertResult {
  ok: boolean;
  /** The Markdown (pandoc's), its images named by the paths in `media`. */
  markdown?: string;
  /** Media it held: each one's path as the Markdown names it, and where it is, relative to scratch. */
  media?: { name: string; file: string }[];
  /** In plain words: what was made, or why not. */
  message: string;
  log: string;
}

/** What the host gives a renderer for one render. */
export interface RendererContext {
  /** An empty folder for this render: the output goes here (`RenderResult.output`, relative to it). */
  scratch: string;
  /** The workspace's folder: what the document refers to is relative to it, or to `RenderRequest.resources`. */
  workspace: string;
  /**
   * A file of the workspace (a path relative to it) as this render may have
   * it: inside the workspace, not in .git, through no link, not hidden from
   * the document's readers (0066); null if not, or not there.
   */
  read(path: string): Promise<Buffer | null>;
  /** The longest the render may take, in ms: past it, the renderer stops and says so. */
  timeLimitMs: number;
  signal: AbortSignal;
  log(message: string): void;
  /** What is happening now, for people waiting. */
  status(message: string): void;
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
// Tools: toolchains downloaded when someone asks, kept once per computer, and
// seen, read-only, only by the processes that use them (decision 0045). The
// host keeps them in its data folder (tools/<id>/<version>-<arch>/), installs
// them through the environment, with the network and no workspace, and only
// where installs are allowed; it knows none by name.

/** What a tool's installer prints last on standard output, before its answer as JSON. */
export const TOOL_REPLY_PREFIX = '\u001fkuraa-tool\u001f';

/** A command for a tool's installer, run in its image. argv[0] is a program on its PATH. */
export interface ToolCommand {
  argv: string[];
  env?: Record<string, string>;
}

/**
 * A toolchain processes may use: TeX, say. Its installer runs in a container
 * of its own (`image`), with the network, its files at view.files, and the
 * tool's folder writable at `inside`, the path processes later see it at; it
 * answers with a last line on standard output: TOOL_REPLY_PREFIX and JSON,
 *   install: { ok, message?, arch?, parts?: string[] }   (parts: what it has now)
 *   add:     { ok, message?, added?: string[] }          (part names added)
 * What it prints to standard error is shown to people as progress.
 */
export interface Tool {
  /** A short id: 'tinytex'. Renderers ask for it by this. */
  id: string;
  /** What it is for, plainly, as a name: 'PDF with LaTeX'. */
  label: string;
  /** A sentence on what it is for (the Components panel). */
  description: string;
  /** The version it installs (pinned): folder names and tool.json record it. */
  version: string;
  /** Roughly how much it downloads, in bytes. */
  downloadBytes: number;
  /** Architectures it has builds for, as `uname -m` names them. */
  architectures: string[];
  /** Where processes see its folder, read-only: '/opt/kuraa/tools/tinytex'. */
  inside: string;
  /** Folders inside to put first on PATH, for an architecture. */
  path(arch: string): string[];
  /** Environment variables for processes that use it. */
  env?(arch: string): Record<string, string>;
  installer: {
    /** The installer's container image. */
    image: ImageRecipe;
    /** Its scripts, by file name, made visible read-only at view.files. */
    files: Record<string, string>;
    /** The command that installs into the empty folder `inside`. `arch` is the environment's, if it said. */
    install(view: PathView, o: { arch: string | null }): ToolCommand;
  };
  /** If it has parts of its own, added on demand (LaTeX packages). */
  parts?: ToolParts;
}

export interface ToolParts {
  /** What they are, in plain words, plural: 'LaTeX packages'. */
  label: string;
  /** Where a workspace records the parts its documents needed, committed with it: '.kuraa/tex-packages.json'. */
  record: string;
  /**
   * Whether a name is one to give the installer. Names come from people and
   * from logs of people's documents: anything else is refused.
   */
  valid(name: string): boolean;
  /** What a failed process's log says is missing, as names `add` takes. */
  missing(log: string): string[];
  /** The command that adds parts to the tool at `inside`. */
  add(view: PathView, o: { arch: string; names: string[] }): ToolCommand;
}

// ---------------------------------------------------------------------------
// Syncs: places a workspace keeps a copy of itself beyond its own devices, and
// syncs with (decision 0059). The personal backup (sync-git: GitHub, GitLab, any
// git server) is the first. Unlike engines, environments and tools, a sync runs in
// the host, with the host's rights and its person's git credentials: it is given
// the workspace's repository, never a process to start. A sync is its person's
// (0115): what it brings in (`bringIn`) is judged as work from one of their own
// devices, this one, so it is no way for other people to meet.

/** The workspace's git repository, as a sync may use it. */
export interface SyncGit {
  /** The workspace folder. */
  readonly dir: string;
  /** Run git there. Fails (throws) on a non-zero exit unless `allowFail`; past `timeoutMs`, git and what it started are stopped. */
  run(args: string[], opts?: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** What the host gives a sync for one workspace. */
export interface SyncContext {
  git: SyncGit;
  /** Environment for git talking to other computers: never a prompt for a password or a host key. */
  nonInteractive: Record<string, string>;
  /** Push this long after the last commit. */
  delayMs: number;
  /** Fetch, merge and push this often (0: never on its own). */
  everyMs: number;
  log(message: string): void;
  /** Run in turn with the host's commits and merges (reading which commits the branches are at, so none is half made). */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Bring the branches fetched into refs/remotes/<name>/ into the workspace's,
   * merging as every device does, in turn with the host's other git work.
   * Returns what the merge into the open branch kept, to say. Absent where no
   * host runs (the command line): the work is left for a host to bring in.
   */
  bringIn?(name: string): Promise<string>;
}

/** One place a sync keeps a copy: an online copy, say. */
export interface SyncTargetStatus {
  /** Its name (a git remote, for sync-git). */
  name: string;
  /** Where, with any password in it left out. */
  url: string;
  /** When this device and it last had the same work (ISO), if they have. */
  lastSync: string | null;
  /** Why the last sync with it did not go through, if it did not. */
  error: string | null;
  /** Syncing with it now. */
  busy: boolean;
  /** Commits here it does not have yet, as far as this device knows (from its last fetch or push); null if unknown. */
  pending?: number | null;
}

/** A sync opened for one workspace. */
export interface SyncSession {
  /** Sync on its own from now (every `everyMs`). */
  start(): void;
  /** The names of its targets. */
  names(): Promise<string[]>;
  list(): Promise<SyncTargetStatus[]>;
  /** Add a target (an address, say), synced with at once. Returns its name. Throws, in words for people, if it cannot be. */
  add(target: string): Promise<string>;
  /** No longer a target. The copy there is not touched. */
  remove(name: string): Promise<void>;
  /** Something was committed. */
  changed(): void;
  /** Sync with every target now: what each brought, or why it did not go through. */
  syncAll(): Promise<{ ok: boolean; messages: string[] }>;
  /** Sync with one target: fetching first unless `fetchFirst` is false (only pushing). What it said, or null if it did not go through. */
  sync(name: string, fetchFirst?: boolean): Promise<string | null>;
  /** Push what the targets lack, waiting at most `ms` (the host is stopping, its last saves just made). */
  pushPending?(ms: number): Promise<void>;
  close(): void;
}

export interface Sync {
  /** Its id, which the API names it by: 'online'. */
  id: string;
  /** What people call it: 'Personal backup'. */
  label: string;
  /** A sentence on what it does. */
  description?: string;
  /** For adding a target in the app: an example address, and how to get one. */
  placeholder?: string;
  help?: string;
  /** Open it for one workspace. */
  open(ctx: SyncContext): SyncSession;
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
  /** Toolchains processes may use, downloaded on request (decision 0045). */
  tools?: Tool[];
  /** Places the workspace keeps a copy and syncs with: the online copy (decision 0059). */
  syncs?: Sync[];
  /** Renderers of documents that need no environment (decision 0107). */
  renderers?: Renderer[];
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
