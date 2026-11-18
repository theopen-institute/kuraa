// An environment component from outside the repository's packages: three places
// to "run" processes, which run nothing but report what they were asked, as
// the process's output. One is sandboxed, one is not, one is unavailable.
import { PassThrough, Readable } from 'node:stream';

const environment = (id, { sandboxed = true, available = true } = {}) => ({
  id,
  label: `in ${id}`,
  description: `The ${id} test environment.`,
  sandboxed,
  async check() {
    return { available, message: available ? `${id} is here` : `${id} is switched off` };
  },
  async start(req) {
    const view = { workspace: '/work', scratch: '/scratch', files: '/files', inside: (p) => p, outside: (p) => p };
    const { argv, cwd } = req.command(view);
    const said = `${argv.join(' ')} [in ${id}, cwd ${cwd}, workspace ${req.policy.workspace}, network ${req.policy.network}]`;
    return {
      stdin: new PassThrough(), stdout: Readable.from([said]), stderr: Readable.from([]), view,
      interrupt() {}, kill() {}, exited: Promise.resolve({ code: 0, signal: null }),
    };
  },
});

export default {
  apiVersion: 1,
  name: 'test-environments',
  environments: [environment('fake'), environment('bare', { sandboxed: false }), environment('down', { available: false })],
};
