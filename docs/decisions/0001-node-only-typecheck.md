# 0001 · One TypeScript config, source exports

Packages export `./src/*.ts` directly instead of building to `dist/`. Vite, Vitest and tsx all read
TypeScript, so there is no build step between packages. `pnpm typecheck` runs one `tsc --noEmit`
over the whole repository. Only the shipping artefacts are bundled: the web client by Vite and the
Electron main process (which embeds the host) by esbuild.

Why: fewer moving parts in a prototype, and package boundaries are still enforced by lint
(`eslint.config.js`), not by build outputs.
