// A worker thread for one step of a render (pandoc, Typst): its script given as
// text (a bundle need carry no file for it), stopped at the render's time limit
// or when the render is stopped. What it answers is its last message.
import { Worker } from 'node:worker_threads';

export interface WorkerRun<T> {
  /** What it answered; null if it was stopped or failed. */
  answer: T | null;
  /** Why it gave no answer, if it did not. */
  stopped: string | null;
}

export function runWorker<T>(script: string, workerData: unknown, o: { timeLimitMs: number; signal: AbortSignal; what: string }): Promise<WorkerRun<T>> {
  if (o.signal.aborted) return Promise.resolve({ answer: null, stopped: 'The render was stopped.' });
  const worker = new Worker(script, { eval: true, workerData });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: WorkerRun<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const stop = (why: string) => {
      void worker.terminate();
      finish({ answer: null, stopped: why });
    };
    const timer = setTimeout(() => stop(`The render took longer than ${Math.round(o.timeLimitMs / 1000)} seconds, the most this host allows, and was stopped.`), o.timeLimitMs);
    const onAbort = () => stop('The render was stopped.');
    o.signal.addEventListener('abort', onAbort);
    worker.once('message', (m: T) => finish({ answer: m, stopped: null }));
    worker.once('error', (e: Error) => finish({ answer: null, stopped: `${o.what} stopped unexpectedly: ${e.message}` }));
    worker.once('exit', () => finish({ answer: null, stopped: `${o.what} stopped unexpectedly.` }));
  });
}
