// The owner's settings: what a person running the app on their own computer
// would otherwise pass as flags (decisions 0046 and 0047). One model for every
// shell: the hub keeps it (SettingsStore), the desktop app in its
// preferences.json, `pnpm host` in settings.json with the app's data. The app
// calls them Preferences. A flag given at start still wins over its setting, and
// is reported as such.
//
// What is never a setting, because it decides what code runs with the owner's
// rights: --component, --allow-unsandboxed and --podman. Those stay flags.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseSize } from '@kuraa/run-kit';
import { HttpError } from './errors.js';
import type { HostTimings } from './host.js';
import { DATA_MARKER, defaultDataDir as hostDataDir, markDataDir, type RunOptions } from './runner.js';

export { DATA_MARKER };

export interface Settings {
  /** Sync every workspace with the other computers it is on (--peer). Workspaces shared by an invite link always do. */
  syncDevices: boolean;
  /** Servers to find other computers through, host:port (--bootstrap); empty for the public ones. */
  bootstrap: string[];
  /** Run code in documents: the R engine (--engine r; --engine none turns it off). */
  runCode: boolean;
  /** Where code runs, by environment id (--env); null for the only one loaded. */
  environment: string | null;
  /** Base images a workspace may name for R, besides the default (--r-image). */
  rImages: string[];
  /** The most memory a code session may use, as '4g' (--memory); null for the default. */
  memory: string | null;
  /** How many CPUs a code session may use (--cpus); null for the default. */
  cpus: number | null;
  /** The most a code session may write (--disk); null for the default. */
  disk: string | null;
  /** Let a workspace ask for write access to its own folder (--allow-write). */
  allowWrite: boolean;
  /** Let a workspace ask for the network while its code runs (--allow-network). */
  allowNetwork: boolean;
  /** Let people install packages and download tools (--allow-installs). */
  allowInstalls: boolean;
  /** Where package versions and tools are kept (--data-dir); null for the app's data folder. */
  dataDir: string | null;
  /** Document types that are on, by id (--format); null for all. */
  formats: string[] | null;
  /** Seconds of quiet before edits are written to the file (--flush-ms); null for the default. */
  saveSeconds: number | null;
  /** Seconds of quiet before a version is saved (--commit-ms); null for the default. */
  versionSeconds: number | null;
  /** Where new workspaces go (--workspaces); null for Documents/kuraa. */
  workspaces: string | null;
}

/** What GET /hub/api/settings answers: what the Preferences dialog shows. */
export interface SettingsView {
  settings: Settings;
  /** Those set by flags, which win over the settings. */
  fromFlags: (keyof Settings)[];
  /** What the limits and timings are when left empty. */
  defaults: { memory: string; cpus: number; disk: string; saveSeconds: number; versionSeconds: number };
  /** Where new workspaces go if none is chosen. */
  defaultWorkspaces: string;
  /** Where packages and tools are kept if no folder is chosen. */
  defaultDataDir: string;
  /** Where code could run, and whether it can now. */
  environments: { id: string; label: string; available: boolean; message: string }[];
  /** The document types the app has. */
  formats: { id: string; label: string }[];
  /** New workspaces can be added here (not a server of one folder): where they go is a setting. */
  canAdd: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  syncDevices: false, bootstrap: [],
  runCode: true, environment: null, rImages: [], memory: null, cpus: null, disk: null,
  allowWrite: false, allowNetwork: false, allowInstalls: true, dataDir: null,
  formats: null, saveSeconds: null, versionSeconds: null, workspaces: null,
};

/** What packages and tools put in the data folder (runner.ts, tools.ts): a folder holding only these is one. */
const DATA_ENTRIES = new Set([DATA_MARKER, 'engines', 'tools', '.DS_Store']);

/** A size as the limits take them ('2g', '512m'). */
export const isSize = (s: string) => (parseSize(s) ?? 0) > 0;
/** host:port, as Hyperswarm's bootstrap nodes are named. */
export const isHostPort = (s: string) => /^[^\s:/]+:\d{1,5}$/.test(s) && Number(s.split(':')[1]) <= 65535;

const strings = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : null);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Settings from untrusted JSON. Leniently (a file on disk), each field is kept
 * only if it is the right kind, else its default. Strictly (what the app saves),
 * a value that is there but wrong is refused, with what is wrong in plain words.
 */
export function settingsFrom(v: unknown, strict = false): Settings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const problem = (message: string) => {
    if (strict) throw new HttpError(400, message);
  };
  const flag = (k: keyof Settings) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (d[k] as boolean));

  let memory = text(o.memory);
  if (memory && !isSize(memory)) {
    problem(`The memory limit should be a size such as 4g or 512m, not “${memory}”.`);
    memory = null;
  }
  let disk = text(o.disk);
  if (disk && !isSize(disk)) {
    problem(`The disk limit should be a size such as 2g or 500m, not “${disk}”.`);
    disk = null;
  }
  let cpus = o.cpus === null || o.cpus === '' ? null : number(o.cpus);
  if (cpus !== null && cpus < 0.1) {
    problem('The number of CPUs should be at least 0.1.');
    cpus = null;
  }
  const seconds = (key: 'saveSeconds' | 'versionSeconds', what: string, min: number) => {
    const n = o[key] === null || o[key] === '' ? null : number(o[key]);
    if (n !== null && (n < min || n > 3600)) {
      problem(`${what} should be between ${min} and 3600 seconds.`);
      return null;
    }
    return n;
  };
  const folder = (key: 'dataDir' | 'workspaces', what: string) => {
    const p = text(o[key]);
    if (p && !isAbsolute(p)) {
      problem(`${what} should be a whole path, starting from the top of the computer's folders, not “${p}”.`);
      return null;
    }
    return p;
  };
  const bootstrap = (strings(o.bootstrap) ?? d.bootstrap).filter((b) => {
    if (isHostPort(b)) return true;
    problem(`“${b}” is not a server address; write it as host:port, such as node.example.org:49737.`);
    return false;
  });
  let formats = Array.isArray(o.formats) ? strings(o.formats) : null;
  if (formats && formats.length === 0) {
    problem('Turn on at least one kind of document.');
    formats = null;
  }
  return {
    syncDevices: flag('syncDevices'),
    bootstrap,
    runCode: flag('runCode'),
    environment: text(o.environment),
    rImages: strings(o.rImages) ?? d.rImages,
    memory, cpus, disk,
    allowWrite: flag('allowWrite'),
    allowNetwork: flag('allowNetwork'),
    allowInstalls: flag('allowInstalls'),
    dataDir: folder('dataDir', 'The folder for packages and tools'),
    formats,
    saveSeconds: seconds('saveSeconds', 'Writing edits to the file', 0.2),
    versionSeconds: seconds('versionSeconds', 'Saving a version', 1),
    workspaces: folder('workspaces', 'The folder for new workspaces'),
  };
}

/** Settings from a file: what is wrong in it, or a file that cannot be read, is the default. */
export function readSettings(file: string): Settings {
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    return settingsFrom(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(file: string, s: Settings): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * A folder may hold packages and tools if it is new, empty, the app's own data
 * folder, or already holds them (it has the marker, or only what packages and
 * tools put there): never a folder with other things in it, which the app would
 * fill and could clear. Marked once accepted (and by the runner when packages or
 * tools first use a folder).
 */
export async function checkDataDir(dir: string, defaultDir: string): Promise<void> {
  const folder = resolve(dir);
  if (folder === resolve(defaultDir)) return;
  if (existsSync(folder)) {
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch (e) {
      throw new HttpError(400, `${folder} cannot be used for packages and tools: ${(e as Error).message}`);
    }
    if (!entries.includes(DATA_MARKER) && !entries.every((e) => DATA_ENTRIES.has(e))) {
      throw new HttpError(400, `${folder} already has other things in it. Choose an empty folder, or one the app already keeps packages and tools in.`);
    }
  }
  try {
    await markDataDir(folder);
  } catch (e) {
    throw new HttpError(400, `${folder} cannot be used for packages and tools: ${(e as Error).message}`);
  }
}

/**
 * The settings a hub keeps: a JSON file, and the flags given at start, which win.
 * `current` is what applies.
 */
export class SettingsStore {
  private stored: Settings;

  constructor(
    /** The file they are kept in. */
    readonly file: string,
    /** Those set by flags at start: they win, and the app says so. */
    readonly flags: Partial<Settings> = {},
    /** Where packages and tools are kept when no folder is chosen (accepted without the marker). */
    readonly defaultDataDir: string = hostDataDir(),
  ) {
    this.stored = readSettings(file);
  }

  /** What is saved, without the flags. */
  get saved(): Settings {
    return this.stored;
  }

  /** What applies: what is saved, with the flags winning. */
  get current(): Settings {
    return { ...this.stored, ...this.flags };
  }

  get fromFlags(): (keyof Settings)[] {
    return (Object.keys(this.flags) as (keyof Settings)[]).filter((k) => this.flags[k] !== undefined);
  }

  /** Check and keep new settings; whether what applies changed. A wrong value is refused (HttpError 400) and nothing is kept. */
  async save(v: unknown): Promise<boolean> {
    const next = settingsFrom(v, true);
    if (next.dataDir && next.dataDir !== this.stored.dataDir) await checkDataDir(next.dataDir, this.defaultDataDir);
    const before = JSON.stringify(this.current);
    await writeSettings(this.file, next);
    this.stored = next;
    return JSON.stringify(this.current) !== before;
  }
}

/** What runs, which formats are on, the timings and syncing, for every host of a hub, from its settings. */
export interface FromSettings {
  run: RunOptions;
  formats: string[] | undefined;
  timings: Partial<HostTimings>;
  peers: { everywhere: boolean; bootstrap?: string[] };
}

/**
 * Host options from settings. `fixed` is what only flags set (the components,
 * --allow-unsandboxed, the Podman program, engines named with --engine) and
 * timings that win over the settings (tests). An engine, environment or format
 * the host does not have is passed over, not an error at every start.
 */
export function fromSettings(
  s: Settings,
  fixed: { run?: Partial<RunOptions>; timings?: Partial<HostTimings>; engines?: string[]; environments?: string[]; formats?: string[] } = {},
): FromSettings {
  const environment = s.environment && (!fixed.environments || fixed.environments.includes(s.environment)) ? s.environment : undefined;
  const formats = s.formats?.filter((id) => !fixed.formats || fixed.formats.includes(id));
  const r = fixed.run ?? {};
  return {
    run: {
      ...r,
      engines: (r.engines ?? (s.runCode ? ['r'] : []).filter((e) => !fixed.engines || fixed.engines.includes(e))).filter((e) => e !== 'none'),
      environment,
      allowInstalls: s.allowInstalls,
      allowWorkspaceWrite: s.allowWrite,
      allowNetwork: s.allowNetwork,
      dataDir: s.dataDir ?? r.dataDir,
      memory: s.memory ?? undefined,
      cpus: s.cpus ?? undefined,
      disk: s.disk ?? undefined,
      options: { ...r.options, r: { ...(r.options?.r as object | undefined), images: s.rImages } },
    },
    formats: formats?.length ? formats : undefined,
    timings: {
      ...(s.saveSeconds !== null ? { flushMs: Math.round(s.saveSeconds * 1000) } : {}),
      ...(s.versionSeconds !== null ? { idleCommitMs: Math.round(s.versionSeconds * 1000) } : {}),
      ...fixed.timings,
    },
    peers: { everywhere: s.syncDevices, ...(s.bootstrap.length ? { bootstrap: s.bootstrap } : {}) },
  };
}
