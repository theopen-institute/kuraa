// An engine plugin from outside the repository's packages, as a third party
// would write one: plain JavaScript, no imports. The "echo" language runs
// `echo <code>` through whatever environment it is given, knowing nothing of it:
// the two meet only through the run-kit contract.
export default {
  apiVersion: 1,
  name: 'echo-engine',
  engines: [{
    id: 'echo',
    label: 'Echo',
    handles: ['echo'],
    open(ctx) {
      return {
        ready: Promise.resolve('echo 1.0'),
        ended: new Promise(() => {}),
        async run(req) {
          const proc = await ctx.environment.start({
            name: 'echo',
            workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy,
            command: (view) => ({ argv: ['echo', req.code], cwd: view.workspace }),
            log: ctx.log, status: ctx.status,
          }, ctx.environmentOptions);
          let out = '';
          proc.stdout.setEncoding('utf8');
          for await (const chunk of proc.stdout) out += chunk;
          await proc.exited;
          return { outputs: [{ type: 'text', text: `${out.trim()} (asked ${JSON.stringify(ctx.requirements ?? null)})` }], interrupted: false };
        },
        interrupt() {},
        async stop() {},
      };
    },
  }],
};
