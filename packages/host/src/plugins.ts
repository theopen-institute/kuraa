// Run plugins: engines (languages) and environments (where code runs). The host
// ships three, which do nothing until the operator turns them on; more can be
// loaded by path or package name. A plugin runs inside the host process with
// the host's rights, so only the operator names plugins, never a workspace.
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_API_VERSION, type Engine, type Environment, type RunPlugin } from '@kuraa/run-kit';
import rPlugin from '@kuraa/engine-r';
import localPlugin from '@kuraa/env-local';
import podmanPlugin from '@kuraa/env-podman';

export const BUILTIN_PLUGINS: RunPlugin[] = [rPlugin, localPlugin, podmanPlugin];

export interface RunPlugins {
  engines: Map<string, Engine>;
  environments: Map<string, Environment>;
}

function check(plugin: unknown, from: string): RunPlugin {
  const p = plugin as Partial<RunPlugin> | null;
  if (!p || typeof p !== 'object' || typeof p.apiVersion !== 'number') throw new Error(`${from} is not a kuraa run plugin: it should export one made with definePlugin().`);
  if (p.apiVersion !== RUN_API_VERSION) throw new Error(`${from} was written for version ${p.apiVersion} of the run plugin API; this host speaks version ${RUN_API_VERSION}.`);
  for (const e of p.engines ?? []) {
    if (typeof e?.id !== 'string' || !Array.isArray(e.handles) || typeof e.open !== 'function') throw new Error(`${from}: an engine needs an id, handles and open().`);
  }
  for (const e of p.environments ?? []) {
    if (typeof e?.id !== 'string' || typeof e.check !== 'function' || typeof e.start !== 'function') throw new Error(`${from}: an environment needs an id, check() and start().`);
  }
  return p as RunPlugin;
}

/** Load a plugin by path (relative to the working folder) or package name. */
async function importPlugin(spec: string): Promise<unknown> {
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
    throw new Error(`Could not load the run plugin ${spec}: ${(e as Error).message}`, { cause: e });
  }
}

export async function loadRunPlugins(specs: string[] = [], builtins: RunPlugin[] = BUILTIN_PLUGINS): Promise<RunPlugins> {
  const out: RunPlugins = { engines: new Map(), environments: new Map() };
  const add = (plugin: RunPlugin, from: string) => {
    for (const e of plugin.engines ?? []) {
      if (out.engines.has(e.id)) throw new Error(`Two run plugins define the engine "${e.id}" (the second is ${from}).`);
      out.engines.set(e.id, e);
    }
    for (const e of plugin.environments ?? []) {
      if (out.environments.has(e.id)) throw new Error(`Two run plugins define the environment "${e.id}" (the second is ${from}).`);
      out.environments.set(e.id, e);
    }
  };
  for (const p of builtins) add(check(p, p.name), p.name);
  for (const spec of specs) add(check(await importPlugin(spec), spec), spec);
  return out;
}
