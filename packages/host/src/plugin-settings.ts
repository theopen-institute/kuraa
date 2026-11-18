// Which plugins are on: run plugins (engines, environments) and document
// formats. The host's options say what is on at the start; on a host its owner
// runs (the desktop app, `pnpm dev`, `--allow-plugin-changes`), the Plugins
// panel can change that, and the choices are kept in a file of the host's,
// never in a workspace. Choices made in the panel win over the options.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PluginChoices {
  /** Engines on or off, by id. */
  engines?: Record<string, boolean>;
  /** Environments on or off, by id. */
  environments?: Record<string, boolean>;
  /** Where code runs unless a workspace asks for another environment that is on. */
  defaultEnvironment?: string;
  /** Document formats on or off, by type id. */
  formats?: Record<string, boolean>;
}

const isFlags = (v: unknown): v is Record<string, boolean> =>
  !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'boolean');

/** Only what is well formed; anything else is dropped. */
export function cleanChoices(raw: unknown): PluginChoices {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...(isFlags(o.engines) ? { engines: o.engines } : {}),
    ...(isFlags(o.environments) ? { environments: o.environments } : {}),
    ...(typeof o.defaultEnvironment === 'string' ? { defaultEnvironment: o.defaultEnvironment } : {}),
    ...(isFlags(o.formats) ? { formats: o.formats } : {}),
  };
}

export async function readChoices(file: string, log: (m: string) => void): Promise<PluginChoices> {
  try {
    return cleanChoices(JSON.parse(await readFile(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`${file} is not valid JSON; ignoring it (${(e as Error).message})`);
    return {};
  }
}

export async function writeChoices(file: string, choices: PluginChoices): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(choices, null, 2)}\n`);
  await rename(tmp, file);
}

/** What is on, given everything there is, what the options turn on, and the choices. */
export function resolveOn(all: string[], fromOptions: string[], choices: Record<string, boolean> | undefined): string[] {
  return all.filter((id) => choices?.[id] ?? fromOptions.includes(id));
}

/** Environments that are on, the default first: the chosen one if it is on, else the options' order. */
export function orderEnvironments(on: string[], fromOptions: string[], chosenDefault: string | undefined): string[] {
  const rank = (id: string) => (id === chosenDefault ? -1 : fromOptions.includes(id) ? fromOptions.indexOf(id) : fromOptions.length);
  return [...on].sort((a, b) => rank(a) - rank(b));
}
