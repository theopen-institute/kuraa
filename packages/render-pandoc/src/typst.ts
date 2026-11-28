// Typst run sealed (decision 0113): typst.ts, Typst's compiler built to
// WebAssembly, in a worker thread, inside a `vm` context that has nothing of
// Node's:
//
//   - its global object is its own (vm.constants.DONT_CONTEXTIFY), so no object
//     of the host's realm, and no way to its Function, is within reach;
//   - code from strings is off (no eval, no new Function) and so are dynamic
//     imports; the glue's few uses of new Function (its default file access and
//     package registry, five fixed bodies) are given functions made in advance,
//     anything else refused;
//   - it reads no file: what it may have (the copies the render made of what the
//     document refers to, and the fonts) is put into a map inside the context,
//     which the file access Kuraa gives it reads; there is nothing else;
//   - no package: the registry Kuraa gives it refuses every one;
//   - bytes go in only as copies made inside the context, so no buffer of the
//     host's is ever handed to it.
//
// Typst sees only the fonts it comes with (typst-assets), so a PDF is the same
// on every computer.
import { readFile } from 'node:fs/promises';
import { runWorker } from './worker.js';

/** What Node gives as globals and the glue uses, written inside the context (nothing of the host's). */
const PRELUDE = String.raw`
var __said = [];
var console = { log: (...a) => __said.push(a.join(' ')), info: (...a) => __said.push(a.join(' ')), warn: (...a) => __said.push(a.join(' ')), error: (...a) => __said.push(a.join(' ')), debug() {} };
var queueMicrotask = (f) => { Promise.resolve().then(f); };
var __FIXED = new Map([
  ['return 0', () => 0],
  ['return true', () => true],
  ['path\u0000return path', (path) => path],
  ["throw new Error('Dummy AccessModel, please initialize compiler with withAccessModel()')", () => { throw new Error('no file access'); }],
  ["throw new Error('Dummy Registry, please initialize compiler with withPackageRegistry()')", () => { throw new Error('no packages'); }],
]);
var __fixed = (body, args) => {
  const f = __FIXED.get(args === undefined ? body : args + '\u0000' + body);
  if (!f) throw new Error('refused: code from a string');
  return f;
};
class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(s = '') {
    const out = [];
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  encodeInto(s, dest) {
    const bytes = this.encode(s);
    if (bytes.length > dest.length) throw new RangeError('encodeInto: no room');
    dest.set(bytes);
    return { read: String(s).length, written: bytes.length };
  }
}
class TextDecoder {
  decode(b) {
    if (!b) return '';
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    const parts = [];
    let s = '';
    for (let i = 0; i < u.length;) {
      const c = u[i++];
      let cp;
      if (c < 0x80) cp = c;
      else if (c < 0xe0) cp = ((c & 31) << 6) | (u[i++] & 63);
      else if (c < 0xf0) cp = ((c & 15) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63);
      else cp = ((c & 7) << 18) | ((u[i++] & 63) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63);
      s += String.fromCodePoint(cp);
      if (s.length > 8192) { parts.push(s); s = ''; }
    }
    parts.push(s);
    return parts.join('');
  }
}
`;

/** What the worker drives, inside the context: its last expression is the API. */
const DRIVER = String.raw`
var __files = new Map();
var __builder = null;
var __compiler = null;
var __pending = [];
({
  init(bytes) { initSync({ module: new Uint8Array(bytes) }); },
  begin() {
    __builder = new TypstCompilerBuilder();
    // The only files it can have: those in __files (copies), by path; nothing else exists.
    __builder.set_access_model({}, (p) => (__files.has(p) ? 1 : 0), (p) => __files.has(p), (p) => p, (p) => {
      const f = __files.get(p);
      if (!f) throw new Error('not found: ' + p);
      return f;
    });
    // No packages: none is fetched or read.
    __builder.set_package_registry({}, function () { throw new Error('packages are not available when rendering here'); });
  },
  font(bytes) { __pending.push(__builder.add_raw_font(new Uint8Array(bytes))); },
  build() { return Promise.all(__pending).then(() => __builder.build()).then((c) => { __compiler = c; }); },
  file(path, bytes) { __files.set(String(path), new Uint8Array(bytes)); },
  compile(main, source) {
    __compiler.add_source(String(main), String(source));
    try {
      const r = __compiler.compile(String(main), [], 'pdf', 1);
      return { pdf: r.result, said: __said.join('\n') };
    } catch (e) {
      return { error: String((e && e.message) || e), said: __said.join('\n') };
    }
  },
})
`;

/** The worker: makes the sealed context, gives it the module, fonts and files (copies), compiles, writes the PDF. */
const WORKER = String.raw`
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { code, module, fonts, scratch } = workerData;
(async () => {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: true } });
  const api = vm.runInContext(code, context, { filename: 'typst-ts.js' });
  api.init(fs.readFileSync(module));
  api.begin();
  for (const name of fs.readdirSync(fonts).filter((n) => /\.(otf|ttf|ttc)$/i.test(n)).sort()) api.font(fs.readFileSync(path.join(fonts, name)));
  await api.build();
  // What the render copied in, at the paths pandoc's Typst names them by.
  const walk = (dir, at) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), at + '/' + e.name);
      else if (e.isFile()) api.file(at + '/' + e.name, fs.readFileSync(path.join(dir, e.name)));
    }
  };
  walk(path.join(scratch, 'work'), '/work');
  const r = api.compile('/out/document.typ', fs.readFileSync(path.join(scratch, 'out', 'document.typ'), 'utf8'));
  if (r.pdf) {
    fs.writeFileSync(path.join(scratch, 'out', 'document.pdf'), Buffer.from(r.pdf));
    parentPort.postMessage({ ok: true, said: String(r.said || '') });
  } else parentPort.postMessage({ ok: false, error: String(r.error), said: String(r.said || '') });
})().catch((e) => parentPort.postMessage({ ok: false, error: String((e && e.message) || e), said: '' }));
`;

/**
 * The glue as a script for the context: its exports kept inside, import.meta
 * gone (it is given the module's bytes), new Function only for the fixed few.
 * Throws if it makes code from strings in any other way.
 */
export function sealGlue(glue: string): string {
  const out = glue
    .replace(/^export (class|function|async function) /gm, '$1 ')
    .replace(/^export \{[^}]*\};?$/gm, '')
    .replace(/import\.meta\.url/g, 'undefined')
    .replace('const ret = new Function(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));', 'const ret = __fixed(getStringFromWasm0(arg2, arg3), getStringFromWasm0(arg0, arg1));')
    .replace('const ret = new Function(getStringFromWasm0(arg0, arg1));', 'const ret = __fixed(getStringFromWasm0(arg0, arg1));');
  if (/\bnew Function\b|\beval\s*\(|\bimport\s*\(|\brequire\s*\(/.test(out)) throw new Error('This typst.ts makes or loads code in a way Kuraa does not expect; it is not used.');
  if (!/\bfunction initSync\b/.test(out) || !/\bclass TypstCompilerBuilder\b/.test(out)) throw new Error('This typst.ts is not one Kuraa knows how to drive.');
  return out;
}

let sealed: { path: string; code: Promise<string> } | null = null;

/** The context's whole script, made once per glue. */
export function codeOf(gluePath: string): Promise<string> {
  if (sealed?.path !== gluePath) {
    const code = readFile(gluePath, 'utf8').then((g) => `${PRELUDE}\n${sealGlue(g)}\n${DRIVER}`);
    code.catch(() => (sealed = null));
    sealed = { path: gluePath, code };
  }
  return sealed.code;
}

/** Typst's diagnostics, in words: the messages its errors give. */
export function typstMessages(error: string): string {
  const messages = [...error.matchAll(/message: "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(["\\])/g, '$1'));
  return messages.length ? [...new Set(messages)].join('; ') : error.slice(0, 300);
}

/**
 * scratch/out/document.typ to scratch/out/document.pdf, Typst seeing only the
 * files under scratch/work (as /work/…) and its fonts.
 */
export async function runTypst(parts: { glue: string; module: string; fonts: string }, scratch: string, o: { timeLimitMs: number; signal: AbortSignal }): Promise<{ ok: boolean; message: string; said: string }> {
  const code = await codeOf(parts.glue);
  const r = await runWorker<{ ok: boolean; error?: string; said: string }>(WORKER, { code, module: parts.module, fonts: parts.fonts, scratch }, { ...o, what: 'Typst' });
  if (!r.answer) return { ok: false, message: r.stopped ?? 'Typst stopped unexpectedly.', said: '' };
  return { ok: r.answer.ok, message: r.answer.ok ? '' : `Typst: ${typstMessages(r.answer.error ?? '')}`, said: r.answer.said };
}
