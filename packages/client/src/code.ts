// The open document's code session as components see it (0092): the chunk
// runner (runs.ts) behind the contract's CodeSession. Running a chunk from the
// document stays the core's; running all, stopping, restarting and the
// workspace's packages are a component's (@kuraa/code), through this.
import type { CodeSession } from '@kuraa/feature-kit/client';
import type { ChunkRunner } from './runs.js';

const made = new WeakMap<ChunkRunner, CodeSession>();

/** The runner's session, the same object for the same runner. */
export function codeSessionOf(r: ChunkRunner): CodeSession {
  let s = made.get(r);
  if (!s) {
    s = {
      status: () => {
        const env = r.info.environment;
        return {
          engine: r.engineLabel,
          state: r.session.state,
          message: r.session.message ?? null,
          environment: env ? { label: env.label, sandboxed: env.sandboxed, available: env.available, ...(env.message ? { message: env.message } : {}) } : null,
          unavailable: r.unavailable,
          busy: r.busy,
          runnable: r.hasRunnableChunks,
          packageEngine: r.packageEngine,
          engines: r.info.engines.map((e) => ({ id: e.id, label: e.label })),
          allowInstalls: !!r.info.allowInstalls,
          packageNews: r.packageNews,
        };
      },
      onChange: (fn) => r.subscribe(fn),
      runAll: () => r.runAll(),
      interrupt: () => r.interrupt(),
      restart: () => r.restart(),
      listPackages: (engine) => r.listPackages(engine),
      installPackages: (engine, refs) => r.installPackages(engine, refs),
      removePackages: (engine, names) => r.removePackages(engine, names),
    };
    made.set(r, s);
  }
  return s;
}
