// pandoc.wasm run (decision 0107): in a worker thread, so a long book never
// holds up the host, under WASI with only the folders it is given (preopens),
// no network, no programs to start, no environment variables. What it says
// goes to a log file. The module is compiled once and shared.
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

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
  if (o.signal.aborted) return { code: null, stopped: 'The render was stopped.' };
  const worker = new Worker(WORKER, { eval: true, workerData: { module, args, preopens: o.preopens, log: o.log, stdin: o.stdin } });
  return await new Promise<PandocRun>((resolve) => {
    let done = false;
    const finish = (r: PandocRun) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const stop = (why: string) => {
      void worker.terminate();
      finish({ code: null, stopped: why });
    };
    const timer = setTimeout(() => stop(`The render took longer than ${Math.round(o.timeLimitMs / 1000)} seconds, the most this host allows, and was stopped.`), o.timeLimitMs);
    const onAbort = () => stop('The render was stopped.');
    o.signal.addEventListener('abort', onAbort);
    worker.once('message', (m: { code: number }) => finish({ code: m.code, stopped: null }));
    worker.once('error', (e: Error) => finish({ code: null, stopped: `pandoc stopped unexpectedly: ${e.message}` }));
    worker.once('exit', (code) => finish({ code: code === 0 ? 0 : null, stopped: code === 0 ? null : 'pandoc stopped unexpectedly.' }));
  });
}
