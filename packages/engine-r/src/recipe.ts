// The container image the R engine runs in (for environments that build images).
// Built from: a base (the starter set: rocker/tidyverse by default, or what the
// workspace names), the system libraries ragg needs to draw plots, the driver's
// packages and pak, then what the workspace asks for in .kuraa/run.json and the
// system libraries its package installs added. Names are validated so they
// cannot smuggle in commands.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageRecipe } from '@kuraa/run-kit';
import { readManifest } from './packages.js';

/** The starter set: R with the tidyverse (and the system libraries most packages need). */
export const DEFAULT_IMAGE = 'docker.io/rocker/tidyverse:4.5';
const NAME = /^[A-Za-z0-9._+-]+$/;
const IMAGE = /^[A-Za-z0-9./:@_-]+$/;

interface Requirements { image?: unknown; packages?: unknown; system?: unknown; renv?: unknown }

const names = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && NAME.test(x))) throw new Error(`.kuraa/run.json: r.${what} must be a list of plain package names.`);
  return v as string[];
};

/** A container image with R, the driver's packages, and what the workspace asks for. */
export function imageRecipe(requirements: unknown, workspace: string): ImageRecipe {
  const req = (requirements ?? {}) as Requirements;
  const image = req.image === undefined ? DEFAULT_IMAGE : String(req.image);
  if (!IMAGE.test(image)) throw new Error('.kuraa/run.json: r.image is not an image name.');
  const packages = names(req.packages, 'packages');
  // System libraries: what the workspace asks for, and what package installs added (its manifest).
  const system = [...new Set([...names(req.system, 'system'), ...names(readManifest(workspace).system, 'system')])];
  // System libraries ragg needs to draw plots, then the driver's packages.
  const lines = [
    `FROM ${image}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    `    ${['libfontconfig1-dev', 'libfreetype6-dev', 'libharfbuzz-dev', 'libfribidi-dev', 'libpng-dev', 'libtiff5-dev', 'libjpeg-dev', 'libwebp-dev', ...system].join(' ')} \\`,
    ' && rm -rf /var/lib/apt/lists/*',
    `RUN install2.r --error --skipinstalled evaluate jsonlite knitr ragg ${packages.join(' ')}`.trimEnd(),
    // pak installs packages for the workspace (see packages.ts), with their system requirements known.
    `RUN R -q -e 'install.packages("pak", repos = sprintf("https://r-lib.github.io/p/pak/stable/%s/%s/%s", .Platform$pkgType, R.Version()$os, R.Version()$arch))'`,
  ];
  const context: Record<string, string> = {};
  const lockfile = join(workspace, 'renv.lock');
  if (req.renv === true && existsSync(lockfile)) {
    context['renv.lock'] = '';
    lines.push(
      'COPY renv.lock /tmp/renv.lock',
      `RUN R -q -e 'install.packages("renv"); renv::restore(lockfile = "/tmp/renv.lock", library = .libPaths()[1], prompt = FALSE)'`,
    );
  }
  return { containerfile: `${lines.join('\n')}\n`, context };
}
