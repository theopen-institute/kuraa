// Run components: engines (languages) and environments (places processes run),
// separate components that meet only through @kuraa/run-kit. The host imports
// none: whoever starts it passes them (the command line, the desktop app and
// `pnpm dev` pass @kuraa/run-components, plus any named with --component). A component
// runs inside the host process with the host's rights, so only the operator
// names components, never a workspace or a person using the app.
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_API_VERSION, type Engine, type Environment, type RunComponent } from '@kuraa/run-kit';

export interface RunComponents {
  engines: Map<string, Engine>;
  environments: Map<string, Environment>;
}

function check(component: unknown, from: string): RunComponent {
  const p = component as Partial<RunComponent> | null;
  if (!p || typeof p !== 'object' || typeof p.apiVersion !== 'number') throw new Error(`${from} is not a kuraa run component: it should export one made with defineRunComponent().`);
  if (p.apiVersion !== RUN_API_VERSION) throw new Error(`${from} was written for version ${p.apiVersion} of the run component API; this host speaks version ${RUN_API_VERSION}.`);
  for (const e of p.engines ?? []) {
    if (typeof e?.id !== 'string' || !Array.isArray(e.handles) || typeof e.open !== 'function') throw new Error(`${from}: an engine needs an id, handles and open().`);
  }
  for (const e of p.environments ?? []) {
    if (typeof e?.id !== 'string' || typeof e.check !== 'function' || typeof e.start !== 'function') throw new Error(`${from}: an environment needs an id, check() and start().`);
    if (typeof e.sandboxed !== 'boolean') throw new Error(`${from}: the environment "${e.id}" must say whether it is sandboxed.`);
  }
  return p as RunComponent;
}

/** Load a component by path (relative to the working folder) or package name. */
async function importComponent(spec: string): Promise<unknown> {
  let target: string;
  if (spec.startsWith('.') || isAbsolute(spec)) target = pathToFileURL(resolve(spec)).href;
  else {
    // A package installed where the host is run from, else wherever Node finds it.
    try {
      target = pathToFileURL(createRequire(join(process.cwd(), 'noop.js')).resolve(spec)).href;
    } catch {
      target = spec;
    }
  }
  try {
    const mod = (await import(target)) as { default?: unknown };
    return mod.default ?? mod;
  } catch (e) {
    throw new Error(`Could not load the run component ${spec}: ${(e as Error).message}`, { cause: e });
  }
}

/** Components given as modules already loaded, or as a path or package name to load. */
export async function loadRunComponents(components: (RunComponent | string)[] = []): Promise<RunComponents> {
  const out: RunComponents = { engines: new Map(), environments: new Map() };
  for (const entry of components) {
    const from = typeof entry === 'string' ? entry : (entry as Partial<RunComponent>)?.name ?? 'a run component';
    const component = check(typeof entry === 'string' ? await importComponent(entry) : entry, from);
    for (const e of component.engines ?? []) {
      if (out.engines.has(e.id)) throw new Error(`Two run components define the engine "${e.id}" (the second is ${from}).`);
      out.engines.set(e.id, e);
    }
    for (const e of component.environments ?? []) {
      if (out.environments.has(e.id)) throw new Error(`Two run components define the environment "${e.id}" (the second is ${from}).`);
      out.environments.set(e.id, e);
    }
  }
  return out;
}
