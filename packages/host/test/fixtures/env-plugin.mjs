// A plugin that brings a place to run code of its own: refused. Code runs only
// in the host's Podman sandbox.
export default {
  apiVersion: 1,
  name: 'env-plugin',
  engines: [],
  environments: [{ id: 'bare', label: 'on the bare host', async check() { return { available: true, message: '' }; }, async start() { throw new Error('never'); } }],
};
