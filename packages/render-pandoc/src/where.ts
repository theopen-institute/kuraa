// Where the programs are (decision 0107): pandoc's WebAssembly build and Typst.
//
//   KURAA_PANDOC_WASM, KURAA_TYPST   named by whoever starts the host (the
//                                     desktop app: the copies in its resources)
//   render/ beside this module        a bundle that carries them (the server's)
//   the cache folder                  where scripts/fetch-render-tools.mjs keeps
//                                     them, once per computer (development)
//   PATH                              Typst only: one the computer has
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '@kuraa/run-kit';

export const PANDOC_VERSION = '3.14';
export const TYPST_VERSION = '0.15.1';

const OS: Record<string, string> = { darwin: 'mac', win32: 'win', linux: 'linux' };

/** The folder scripts/fetch-render-tools.mjs keeps them in (as it has it). */
export function cacheDir(): string {
  if (process.env.KURAA_RENDER_TOOLS) return resolve(process.env.KURAA_RENDER_TOOLS);
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_CACHE_HOME || join(homedir(), '.cache'));
  return join(base, 'kuraa', 'render-tools');
}

/** A file beside this module, as a bundle carries it; null where this module is not a file (or the file not there). */
function beside(...parts: string[]): string | null {
  try {
    const file = fileURLToPath(new URL(['.', ...parts].join('/'), import.meta.url));
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

const first = (...paths: (string | null | undefined)[]): string | null => paths.find((p): p is string => !!p && existsSync(p)) ?? null;

/** pandoc.wasm, if it is here. */
export function pandocWasm(): string | null {
  return first(process.env.KURAA_PANDOC_WASM, beside('render', 'pandoc.wasm'), join(cacheDir(), `pandoc-${PANDOC_VERSION}`, 'pandoc.wasm'));
}

/** The Typst program, if there is one. */
export function typstProgram(): string | null {
  const exe = process.platform === 'win32' ? 'typst.exe' : 'typst';
  const target = `${OS[process.platform] ?? process.platform}-${process.arch}`;
  return first(process.env.KURAA_TYPST, beside('render', target, exe), join(cacheDir(), `typst-${TYPST_VERSION}-${target}`, exe)) ?? findExecutable('typst');
}
