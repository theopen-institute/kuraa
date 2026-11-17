# 0013 · Running code through plugins, sandboxed by default

The host no longer knows about R. Running code goes through two kinds of plugin, with the
contract in `@kuraa/run-kit`:

| Kind | Answers | Built in |
| --- | --- | --- |
| **Engine** | How to run code in a language and report the outputs | `@kuraa/engine-r` (R through `evaluate`, as before: 0011) |
| **Environment** | Where a process runs, and what it may touch | `@kuraa/env-podman` (a locked-down container), `@kuraa/env-local` (a plain process, not sandboxed) |

The host's runner (`packages/host/src/runner.ts`) is generic: per document and engine it opens a
session in an environment, queues runs, broadcasts progress and outputs, and caches the latest
output of each chunk in `.git/kuraa/outputs`. The output protocol (`ChunkOutput`) is shared, so
the client shows any engine's output. The client was already engine-neutral; it now also shows
where code runs ("R ready · in a Podman container"; "on this computer (not sandboxed)" with a
warning mark).

**Turning it on.** Nothing runs unless the operator turns on at least one engine and one
environment: `--engine r --env podman` (repeatable; the first environment is the default), or
`run: { engines, environments }` in `startHost`. Unknown ids stop the host at startup.

**External plugins.** `--plugin <path or package>` loads a module whose default export is a
`RunPlugin` (`definePlugin({ name, engines, environments })`). The host refuses a plugin built for
another `RUN_API_VERSION`, and two plugins defining the same id. Plugins run in the host process
with the host's rights, so only the operator names them; a workspace cannot.
`packages/host/test/fixtures/echo-plugin.mjs` is a complete example in plain JavaScript.

**A workspace can ask; only the operator can allow.** `.kuraa/run.json` in a workspace may ask
for one of the allowed environments (`"environment": "podman"`), say what each engine needs (for
R: `"r": { "image", "packages", "system", "renv" }`), and ask for more access
(`"access": { "workspace": "read-write", "network": true }`). It gets an environment only if the
operator allowed it (else the operator's default), and more access only if the operator passed
`--allow-write` / `--allow-network`. If the environment is unavailable, nothing runs and the user
is told why; there is no fallback to a weaker one.

**The policy** (`run-kit`'s `Policy`) is what an environment enforces: workspace read-only by
default, no network, 4 GB memory, 2 CPUs, 512 processes, and `.git` hidden. Hiding `.git` matters:
code that could write a git hook there would escape the sandbox the next time git ran on the host.

**Podman** turns the policy into `podman run` flags: `--network=none`, `--read-only` with a private
`/tmp`, `--cap-drop=all`, `--security-opt=no-new-privileges`, limits, `--userns=keep-id` (the
user's id, not root), the workspace at `/work` (read-only) with an empty, inaccessible tmpfs over
`/work/.git` (`notmpcopyup`: by default Podman would copy the directory's contents into the
tmpfs, defeating the point; found by the integration test), a scratch folder at `/scratch`, and
the engine's files read-only at `/kuraa`. Nothing else of the host is mounted. Images come from
the engine's recipe (R: `rocker/r-ver` with the driver's packages and whatever the workspace asks
for, names validated so they cannot inject commands), are tagged by a hash of the recipe, and are
built once. On macOS, Podman runs containers in its own Linux virtual machine, a second boundary.

**The local environment** enforces nothing and says so. `pnpm dev` and the browser tests use it;
`KURAA_DEV_ENV=podman pnpm dev` tries the container.

**The desktop app** has a **Run Code** menu: in a Podman container (the default), on this computer
(not sandboxed), or off. It is the app user's setting (kept in the app's own settings), applied to
folders the app opens; changing it reopens the folder.

**Tests.** `packages/host/test/plugins.test.ts` (loading, versions, environment choice, access,
unavailability) with the fixture plugin; `packages/env-podman/test` (flags, tags, messages, the
build-then-run sequence against a stand-in `podman`); `packages/engine-r/test` (the recipe);
`packages/host/test/runner.test.ts` and a desktop test run R in a real container where Podman is
installed and running: it cannot see `/Users`, write the workspace, open `.git`, or reach the
network, and still draws plots.

**Not yet:** other engines (Python would be a plugin), a sandbox on Windows without Podman, macOS's
built-in sandbox or webR as environments, per-workspace image caching policies (old images are not
cleaned up), and streaming output while a chunk runs.
