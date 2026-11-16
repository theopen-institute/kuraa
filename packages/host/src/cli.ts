// kuraa-host --dir <workspace> [--init] [--port 4321] [--host 127.0.0.1] [--token T] [--static dir] [--upstream origin]
import { parseArgs } from 'node:util';
import { startHost } from './index.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: '.' },
    init: { type: 'boolean', default: false },
    port: { type: 'string', default: '4321' },
    host: { type: 'string', default: '127.0.0.1' },
    token: { type: 'string' },
    static: { type: 'string' },
    upstream: { type: 'string' },
    'flush-ms': { type: 'string' },
    'commit-ms': { type: 'string' },
  },
});

const running = await startHost({
  dir: values.dir!,
  init: values.init,
  port: Number(values.port),
  host: values.host!,
  token: values.token ?? process.env.KURAA_TOKEN,
  staticDir: values.static,
  upstream: values.upstream,
  timings: {
    ...(values['flush-ms'] ? { flushMs: Number(values['flush-ms']) } : {}),
    ...(values['commit-ms'] ? { idleCommitMs: Number(values['commit-ms']) } : {}),
  },
  log: (m) => console.log(`[kuraa] ${m}`),
});
console.log(`[kuraa] workspace: ${running.host.dir}`);
console.log(`[kuraa] url:       ${running.url}`);
console.log(`[kuraa] token:     ${running.token}`);
if (values.static) console.log(`[kuraa] open:      ${running.url}/?token=${running.token}`);
console.log(`[kuraa] git clone: git clone http://kuraa:${running.token}@${running.url.replace(/^https?:\/\//, '')}/git ${running.host.workspace}`);

// Write and commit pending edits, then exit. A signal often arrives twice at once
// (from the terminal to the whole process group, and relayed by a supervisor such
// as tsx watch), so repeats are ignored; a second Ctrl+C a moment later forces exit.
let stopping = 0;
const stop = (signal: string) => {
  if (stopping) {
    if (Date.now() - stopping > 1000) {
      console.log(`[kuraa] ${signal} again: exiting without waiting`);
      process.exit(1);
    }
    return;
  }
  stopping = Date.now();
  console.log('[kuraa] stopping: writing and committing pending edits');
  void running.close().then(
    () => process.exit(0),
    (e: Error) => {
      console.error(`[kuraa] stopping failed: ${e.message}`);
      process.exit(1);
    },
  );
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
