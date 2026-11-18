// A run plugin from outside the repository's packages, as a third party would
// write one: plain JavaScript, no imports. An "echo" engine that reports where
// it was asked to run and under which policy, without starting any process.
export default {
  apiVersion: 1,
  name: 'echo-plugin',
  engines: [{
    id: 'echo',
    label: 'Echo',
    handles: ['echo'],
    open(ctx) {
      return {
        ready: Promise.resolve('echo 1.0'),
        ended: new Promise(() => {}),
        async run(req) {
          const where = `${ctx.environment.id}, workspace ${ctx.policy.workspace}, network ${ctx.policy.network}`;
          return { outputs: [{ type: 'text', text: `${req.code} (${where}; asked ${JSON.stringify(ctx.requirements ?? null)})` }], interrupted: false };
        },
        interrupt() {},
        async stop() {},
      };
    },
  }],
};
