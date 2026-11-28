// Where its parts are (decisions 0107, 0113): pandoc's WebAssembly build, Typst's
// (typst.ts: its module and the glue it is driven by) and the fonts Typst comes with.
//
//   KURAA_PANDOC_WASM, KURAA_TYPST_WASM,   named by whoever starts the host (the
//   KURAA_TYPST_FONTS                       desktop app: the copies in its resources)
//   render/ beside this module              a bundle that carries them (the server's)
//   the cache folder, the dependency        where scripts/fetch-render-tools.mjs keeps
//                                           pandoc and the fonts, once per computer, and
//                                           typst.ts as installed (development)
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PANDOC_VERSION = '3.14';
/** Typst's version (typst.ts 0.8.0-rc4 builds it), and the tag of its fonts. */
export const TYPST_VERSION = '0.15.1';
const GLUE = 'typst_ts_web_compiler.mjs';
const MODULE = 'typst_ts_web_compiler_bg.wasm';

/** The folder scripts/fetch-render-tools.mjs keeps them in (as it has it). */
export function cacheDir(): string {
  if (process.env.KURAA_RENDER_TOOLS) return resolve(process.env.KURAA_RENDER_TOOLS);
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_CACHE_HOME || join(homedir(), '.cache'));
  return join(base, 'kuraa', 'render-tools');
}

/** A path beside this module, as a bundle carries it; null where this module is not a file. */
function beside(...parts: string[]): string | null {
  try {
    return fileURLToPath(new URL(['.', ...parts].join('/'), import.meta.url));
  } catch {
    return null;
  }
}

const first = (...paths: (string | null | undefined)[]): string | null => paths.find((p): p is string => !!p && existsSync(p)) ?? null;

/** pandoc.wasm, if it is here. */
export function pandocWasm(): string | null {
  return first(process.env.KURAA_PANDOC_WASM, beside('render', 'pandoc', 'pandoc.wasm'), join(cacheDir(), `pandoc-${PANDOC_VERSION}`, 'pandoc.wasm'));
}

/** typst.ts as installed with this package, if it is (not in a bundle). */
function installed(): string | null {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('@myriaddreamin/typst-ts-web-compiler/package.json')), 'pkg');
  } catch {
    return null;
  }
}

/** Typst's compiler (its module and glue) and its fonts, if all are here. */
export function typstParts(): { glue: string; module: string; fonts: string } | null {
  const dir = first(process.env.KURAA_TYPST_WASM, beside('render', 'typst'), installed());
  const fonts = first(process.env.KURAA_TYPST_FONTS, beside('render', 'typst-fonts'), join(cacheDir(), `typst-fonts-v${TYPST_VERSION}`));
  if (!dir || !fonts || !existsSync(join(dir, GLUE)) || !existsSync(join(dir, MODULE))) return null;
  return { glue: join(dir, GLUE), module: join(dir, MODULE), fonts };
}
