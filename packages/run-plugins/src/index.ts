// The run plugins that ship with kuraa, for the programs that start a host (the
// host's command line, the desktop app, `pnpm dev`) to load, as the formats list
// is for document types. The host itself imports none of them.
//
//   @kuraa/engine-r     the R language
//   @kuraa/env-podman   locked-down Podman containers
//
// No environment that runs code on the host's computer itself ships; one can be
// written against @kuraa/run-kit and loaded with --plugin (and, being
// unsandboxed, used only with --allow-unsandboxed).
import type { RunPlugin } from '@kuraa/run-kit';
import rPlugin from '@kuraa/engine-r';
import podmanPlugin from '@kuraa/env-podman';

export const standardRunPlugins: RunPlugin[] = [rPlugin, podmanPlugin];
