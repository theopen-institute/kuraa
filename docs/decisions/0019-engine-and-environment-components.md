# 0019 · Engines and environments are separate components

Running code takes two kinds of component, which never know each other's implementation and meet
only through the contract in `@kuraa/run-kit`:

| Kind | Answers | Ships |
| --- | --- | --- |
| **Engine** | A language: how to run its code and report the outputs | `@kuraa/engine-r` |
| **Environment** | A place processes run, and what they may touch there | `@kuraa/env-podman` |

**The contract between them.** An engine is given one environment (`EngineContext.environment`)
and starts every process through it: a `StartRequest` says what to run (`command(view)`, built
once the environment says how paths look from inside), which host folders the process needs and
with what access (workspace, scratch, the engine's files, further mounts), the `Policy` (network,
limits, hidden paths), and optionally how to provision a container (`image`). The environment
answers with a `SandboxProcess`: stdin, stdout and stderr, `interrupt()`, `kill()`, `exited`, and
the `PathView`. An environment that runs processes elsewhere (a remote server) makes the folders
visible there and brings scratch back. Neither package may import the other (a lint rule).

**The host knows neither.** The host core imports no run component (a lint rule): the program that
starts it passes them, as modules or by path or package name. The command line, the desktop app
and `pnpm dev` pass `@kuraa/run-components` (R and Podman) plus any `--component`. Tests pass their own.

**Choosing.** `--engine` turns engines on; `--env` chooses the environment, by default the only one
loaded (with several, the host asks for `--env`; with none and engines on, it refuses to start).
A workspace does not choose.

**Sandboxing is declared and gated.** Each environment says whether it enforces the policy
(`sandboxed`); the host refuses to start with one that does not unless the operator passes
`--allow-unsandboxed`. Per [0018](0018-untrusted-users.md), people using the app are trusted with
document content only, so no environment that runs code on the host's computer ships. One can be
written (a local environment, say) and loaded with `--component`; the panel and the menu mark it
"not sandboxed".

This restores what [0013](0013-run-plugins-and-sandboxing.md) began, without its Local environment,
and replaces 0018's "environments are not plugins".
