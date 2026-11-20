// The run components that ship with kuraa, for the programs that start a host (the
// host's command line, the desktop app, `pnpm dev`) to load, as the formats list
// is for document types. The host itself imports none of them.
//
//   @kuraa/engine-r     the R language
//   @kuraa/env-podman   locked-down Podman containers
//   @kuraa/tool-tinytex TeX, for PDFs made with LaTeX, downloaded on request
//                       (decision 0045)
//
// No environment that runs code on the host's computer itself ships; one can be
// written against @kuraa/run-kit and loaded with --component (and, being
// unsandboxed, used only with --allow-unsandboxed).
import type { RunComponent } from '@kuraa/run-kit';
import rComponent from '@kuraa/engine-r';
import podmanComponent from '@kuraa/env-podman';
import tinytexComponent from '@kuraa/tool-tinytex';

export const standardRunComponents: RunComponent[] = [rComponent, podmanComponent, tinytexComponent];
