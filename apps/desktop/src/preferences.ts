// The app's preferences: what a person opening the app by double-clicking it
// would otherwise have to pass as flags. Kept as JSON with the app's own data.
// A flag given on the command line still wins over its preference (for tests,
// and for anyone who starts the app from a terminal).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Preferences {
  /** Sync every workspace with its paired devices (--peer). Workspaces joined from an invitation or link always do. */
  syncDevices: boolean;
  /** Run code in documents: the R engine (--engine r; --engine none turns it off). */
  runCode: boolean;
  /** Base images a workspace may name for R, besides the default (--r-image). */
  rImages: string[];
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
  /** Where code would run, and whether it can now. */
  environments: { label: string; available: boolean; message: string }[];
}

/** The Preferences window's side of the bridge, as window.kuraaApp. */
export interface AppBridge {
  preferences(): Promise<PreferencesView>;
  savePreferences(p: Preferences): Promise<void>;
  /** A folder the person picks, or null. */
  chooseFolder(): Promise<string | null>;
}

export const DEFAULT_PREFERENCES: Preferences = { syncDevices: false, runCode: true, rImages: [], workspaces: null };

/** Preferences from untrusted JSON: each field kept only if it is the right kind, else its default. */
export function preferencesFrom(v: unknown): Preferences {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFERENCES;
  return {
    syncDevices: typeof o.syncDevices === 'boolean' ? o.syncDevices : d.syncDevices,
    runCode: typeof o.runCode === 'boolean' ? o.runCode : d.runCode,
    rImages: Array.isArray(o.rImages) ? [...new Set(o.rImages.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : d.rImages,
    workspaces: typeof o.workspaces === 'string' && o.workspaces.trim() ? o.workspaces.trim() : d.workspaces,
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
