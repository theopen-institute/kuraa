// The app's preferences: what a person opening the app by double-clicking it
// would otherwise have to pass as flags to a host. Kept as JSON with the app's
// own data. A flag given on the command line still wins over its preference
// (for tests, and for anyone who starts the app from a terminal). What stays a
// flag only, and why: docs/decisions/0046-desktop-preferences.md.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseSize } from '@kuraa/run-kit';

export interface Preferences {
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
  /** The Podman program (--podman); null to find it. */
  podman: string | null;
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

/** What the Preferences window gets. */
export interface PreferencesView {
  preferences: Preferences;
  /** Those set by flags, which win over the preferences. */
  fromFlags: (keyof Preferences)[];
  /** Where new workspaces go if none is chosen. */
  defaultWorkspaces: string;
  /** Where packages and tools are kept if no folder is chosen. */
  defaultDataDir: string;
  /** What the limits and timings are when left empty. */
  defaults: { memory: string; cpus: number; disk: string; saveSeconds: number; versionSeconds: number };
  /** Where code could run, and whether it can now. */
  environments: { id: string; label: string; available: boolean; message: string }[];
  /** The document types the app has. */
  formats: { id: string; label: string }[];
}

/** The Preferences window's side of the bridge, as window.kuraaApp. */
export interface AppBridge {
  preferences(): Promise<PreferencesView>;
  savePreferences(p: Preferences): Promise<void>;
  /** A folder the person picks (for new workspaces, or for packages and tools), or null. */
  chooseFolder(purpose?: 'workspaces' | 'data'): Promise<string | null>;
  /** A program the person picks, or null. */
  chooseFile(): Promise<string | null>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  syncDevices: false, bootstrap: [],
  runCode: true, environment: null, rImages: [], memory: null, cpus: null, disk: null,
  allowWrite: false, allowNetwork: false, allowInstalls: true, podman: null, dataDir: null,
  formats: null, saveSeconds: null, versionSeconds: null, workspaces: null,
};

/** A size as the limits take them ('2g', '512m'). */
export const isSize = (s: string) => (parseSize(s) ?? 0) > 0;
/** host:port, as Hyperswarm's bootstrap nodes are named. */
export const isHostPort = (s: string) => /^[^\s:/]+:\d{1,5}$/.test(s) && Number(s.split(':')[1]) <= 65535;

const strings = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : null);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Preferences from untrusted JSON. Leniently (a file on disk), each field is kept
 * only if it is the right kind, else its default. Strictly (what the window saves),
 * a value that is there but wrong is refused, with what is wrong in plain words.
 */
export function preferencesFrom(v: unknown, strict = false): Preferences {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFERENCES;
  const problem = (message: string) => {
    if (strict) throw new Error(message);
  };
  const flag = (k: keyof Preferences) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (d[k] as boolean));

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
    podman: text(o.podman),
    dataDir: text(o.dataDir),
    formats,
    saveSeconds: seconds('saveSeconds', 'Writing edits to the file', 0.2),
    versionSeconds: seconds('versionSeconds', 'Saving a version', 1),
    workspaces: text(o.workspaces),
  };
}

export function readPreferences(file: string): Preferences {
  if (!existsSync(file)) return { ...DEFAULT_PREFERENCES };
  try {
    return preferencesFrom(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function writePreferences(file: string, p: Preferences): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(p, null, 2)}\n`);
  await rename(tmp, file);
}
