// pandoc.wasm run (decision 0107): in a worker thread, so a long book never
// holds up the host, under WASI with only the folders it is given (preopens),
// no network, no programs to start, no environment variables. What it says
// goes to a log file. The module is compiled once and shared.
import { readFile } from 'node:fs/promises';
import { runWorker } from './worker.js';

// A script of its own (no file to find in a bundle): CommonJS, as eval'd workers are.
const WORKER = String.raw`
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
// WASI's "experimental" notice, once per worker, would fill the host's log.
process.emitWarning = () => {};
const { WASI } = require('node:wasi');
const { module, args, preopens, log, stdin } = workerData;
const out = fs.openSync(log, 'a');
const input = fs.openSync(stdin, 'r');
let code = 1;
try {
  const wasi = new WASI({ version: 'preview1', args: ['pandoc', ...args], env: {}, preopens, stdin: input, stdout: out, stderr: out, returnOnExit: true });
  const instance = new WebAssembly.Instance(module, wasi.getImportObject());
  code = wasi.start(instance);
} catch (e) {
  fs.writeSync(out, '\n' + String(e && e.message || e) + '\n');
} finally {
  fs.closeSync(out);
  fs.closeSync(input);
}
parentPort.postMessage({ code });
`;

let compiled: { path: string; module: Promise<WebAssembly.Module> } | null = null;

/** The module, compiled once for the host's life. */
function moduleOf(path: string): Promise<WebAssembly.Module> {
  if (compiled?.path !== path) {
    const module = readFile(path).then((bytes) => WebAssembly.compile(bytes));
    module.catch(() => (compiled = null));
    compiled = { path, module };
  }
  return compiled.module;
}

export interface PandocRun {
  /** Its exit status; null if it was stopped. */
  code: number | null;
  /** Why it was stopped, if it was. */
  stopped: string | null;
}

/**
 * Run pandoc with these arguments, seeing only `preopens` (inside → folder on
 * this computer). What it prints is appended to `log`; `stdin` is a file it
 * may read as its input (empty: it is given its input by name).
 */
export async function runPandoc(wasm: string, args: string[], o: { preopens: Record<string, string>; log: string; stdin: string; timeLimitMs: number; signal: AbortSignal }): Promise<PandocRun> {
  const module = await moduleOf(wasm);
  const r = await runWorker<{ code: number }>(WORKER, { module, args, preopens: o.preopens, log: o.log, stdin: o.stdin }, { timeLimitMs: o.timeLimitMs, signal: o.signal, what: 'pandoc' });
  return { code: r.answer?.code ?? null, stopped: r.stopped };
}
