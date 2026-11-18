// The contract for running code, as plugins.
//
// The host knows nothing about any language or sandbox. It runs chunks through
// two kinds of plugin, which it loads and the operator turns on:
//
//   Engine       how to run code in a language and report what it produced
//                (engine-r: R through evaluate, as knitr does)
//   Environment  where a process runs, and what it may touch (env-podman: a
//                locked-down container; env-local: a plain process, no sandbox)
//
// A plugin module exports a RunPlugin: `export default definePlugin({ ... })`.
// The host refuses a plugin whose apiVersion differs from RUN_API_VERSION.
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ChunkOutput } from '@kuraa/session/model';

export type { ChunkOutput };

/** Bumped whenever this contract changes incompatibly. */
export const RUN_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Policy: what a process may touch. Environments that sandbox enforce it.

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
   * Workspace paths it must not see at all. `.git` by default: code that could
   * write a git hook there would escape the sandbox the next time git runs.
   */
  hide: string[];
}

export const DEFAULT_POLICY: Policy = { workspace: 'read-only', network: false, memory: '4g', cpus: 2, pids: 512, hide: ['.git'] };

// ---------------------------------------------------------------------------
// Environments

/**
 * The three folders a process gets, as it sees them, and how to translate. On
 * the host they are the workspace, a scratch folder (writable: plots, temporary
 * files), and the engine's files (read-only: a driver script).
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

/** How to build an image the engine runs in, for environments that use images. */
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
   * argv[0] is a program name (or an absolute path) the environment resolves.
   */
  command(view: PathView): { argv: string[]; cwd: string; env?: Record<string, string> };
  /** Where the program may be on a plain machine, besides PATH. */
  searchPaths?: string[];
  /** How to build an image to run in. */
  image?: ImageRecipe;
  log(message: string): void;
  /** Progress the user should see, e.g. while an image builds. */
  status(message: string): void;
}

export interface SandboxProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  view: PathView;
  /** Ask the running code to stop (SIGINT). The process should survive it. */
  interrupt(): void;
  /** End the process. */
  kill(): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface EnvironmentStatus {
  available: boolean;
  /** What to tell the user: why it is unavailable, or what it is. */
  message: string;
}

export interface Environment {
  id: string;
  /** Where code runs, as a phrase: 'in a Podman container'. */
  label: string;
  /** A sentence for people choosing it (the Plugins panel): what it is, what it shields. */
  description?: string;
  /** Whether it enforces the policy. A plain process on the host does not. */
  sandboxed: boolean;
  check(options: unknown): Promise<EnvironmentStatus>;
  start(req: StartRequest, options: unknown): Promise<SandboxProcess>;
}

// ---------------------------------------------------------------------------
// Engines

export interface EngineContext {
  environment: Environment;
  /** The engine's own folder on the host, shared by every workspace (a package cache, say). */
  dataDir: string;
  /** A stable short id for the workspace, for per-workspace things kept in dataDir. */
  workspaceKey: string;
  /** Install packages for the workspace (the host checks it is allowed, and runs one install at a time). */
  install(refs: string[]): Promise<PackageResult>;
  /** Remove packages from the workspace's library. */
  remove(names: string[]): Promise<PackageResult>;
  /** Packages the session loaded from the environment itself (not the workspace's library), to record. */
  usedFromEnvironment(packages: { name: string; version: string }[]): void;
  /** The operator's options for the environment, to pass to its start(). */
  environmentOptions: unknown;
  /** Host folders: see PathView. */
  workspace: string;
  scratch: string;
  files: string;
  policy: Policy;
  /** What the workspace asks of this engine (its section of .kuraa/run.json). Unvalidated. */
  requirements: unknown;
  /** The operator's options for this engine. */
  options: unknown;
  log(message: string): void;
  status(message: string): void;
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

export interface EngineSession {
  /** Resolves once the session can run code, with a description (e.g. the R version). */
  ready: Promise<string>;
  run(req: RunRequest): Promise<RunResult>;
  interrupt(): void;
  stop(): Promise<void>;
  /** Resolves when the session ends by itself (it exited, or crashed), with why. */
  ended: Promise<string>;
}

export interface Engine {
  id: string;
  label: string;
  /** A sentence for people choosing it (the Plugins panel). */
  description?: string;
  /** Chunk engine names it runs, as in a knitr header: ['r']. */
  handles: string[];
  open(ctx: EngineContext): EngineSession;
  /** If the engine manages packages for a workspace. */
  packages?: PackageManager;
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

export interface PackageContext {
  environment: Environment;
  environmentOptions: unknown;
  workspace: string;
  files: string;
  dataDir: string;
  workspaceKey: string;
  policy: Policy;
  requirements: unknown;
  options: unknown;
  log(message: string): void;
  status(message: string): void;
  /** Commit files the manager changed in the workspace (its manifest), crediting whoever asked. */
  commit(paths: string[], message: string): Promise<void>;
}

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
// Plugins

export interface RunPlugin {
  apiVersion: number;
  name: string;
  engines?: Engine[];
  environments?: Environment[];
}

export function definePlugin(plugin: Omit<RunPlugin, 'apiVersion'>): RunPlugin {
  return { apiVersion: RUN_API_VERSION, ...plugin };
}

// ---------------------------------------------------------------------------
// Helpers for plugins

/** A program on PATH or in one of `dirs` (apps started from the macOS Dock get a short PATH). */
export function findExecutable(name: string, dirs: string[] = []): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const exe = process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name;
  for (const d of [...(process.env.PATH ?? '').split(delimiter), ...dirs, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']) {
    if (d && existsSync(join(d, exe))) return join(d, exe);
  }
  return null;
}

/** A PathView over fixed folders inside, mapping host folders (and mounts) onto them. */
export function mappedView(host: { workspace: string; scratch: string; files: string }, inside: { workspace: string; scratch: string; files: string }, mounts: Mount[] = []): PathView {
  const pairs = [
    ...mounts.map((m) => [m.host, m.inside] as const),
    ...(['workspace', 'scratch', 'files'] as const).map((k) => [host[k], inside[k]] as const),
  ];
  const swap = (path: string, from: 0 | 1) => {
    for (const pair of pairs) {
      const a = pair[from];
      const b = pair[from === 0 ? 1 : 0];
      if (path === a) return b;
      if (path.startsWith(a.endsWith('/') ? a : `${a}/`)) return b + path.slice(a.length);
    }
    throw new Error(`Not in a shared folder: ${path}`);
  };
  return { ...inside, inside: (p) => swap(p, 0), outside: (p) => swap(p, 1) };
}
