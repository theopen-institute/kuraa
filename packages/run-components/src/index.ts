// The run components that ship with kuraa, for the programs that start a host (the
// host's command line, the desktop app, `pnpm dev`) to load, as the formats list
// is for document types. The host itself imports none of them.
//
//   @kuraa/engine-r     the R language
//   @kuraa/env-podman   locked-down Podman containers
//   @kuraa/render-pandoc Markdown rendered with no environment: pandoc.wasm,
//                       and Typst for PDFs (decision 0107)
//   @kuraa/tool-tinytex TeX, for PDFs made with LaTeX, downloaded on request
//                       (decision 0045)
//   @kuraa/sync-git     the online copy: a git server the workspace is kept on
//                       and synced with (decisions 0039, 0059)
//
// No environment that runs code on the host's computer itself ships; one can be
// written against @kuraa/run-kit and loaded with --component (and, being
// unsandboxed, used only with --allow-unsandboxed).
import type { RunComponent } from '@kuraa/run-kit';
import rComponent from '@kuraa/engine-r';
import pandocComponent from '@kuraa/render-pandoc';
import podmanComponent from '@kuraa/env-podman';
import tinytexComponent from '@kuraa/tool-tinytex';
import syncGitComponent from '@kuraa/sync-git';

export const standardRunComponents: RunComponent[] = [rComponent, podmanComponent, pandocComponent, tinytexComponent, syncGitComponent];
