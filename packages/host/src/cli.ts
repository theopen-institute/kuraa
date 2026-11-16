// kuraa-host --dir <workspace> [--port 4321] [--host 127.0.0.1] [--token T] [--static dir] [--upstream origin]
import { parseArgs } from 'node:util';
import { startHost } from './index.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: '.' },
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

const stop = async () => {
  await running.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
