// The container image the R engine runs in (for environments that build images).
// Built from: a base (the starter set: rocker/tidyverse by default, or what the
// workspace names), the system libraries ragg needs to draw plots, the driver's
// packages and pak, then what the workspace asks for in .kuraa/run.json and the
// system libraries its package installs added. Names are validated so they
// cannot smuggle in commands.
//
// A workspace may name only a base image the operator allows (the engine's
// option `images`, from --r-image; the default image always): an image is code.
// Its ENTRYPOINT is overridden where it runs, but its ONBUILD instructions run
// when the image is built, with the network, so allow only images you trust.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageRecipe } from '@kuraa/run-kit';
import { MANIFEST, readManifest } from './packages.js';

/** The starter set: R with the tidyverse (and the system libraries most packages need). */
export const DEFAULT_IMAGE = 'docker.io/rocker/tidyverse:4.5';
// Never starting with '-', so a name cannot pass for an option to apt-get or install2.r.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const IMAGE = /^[A-Za-z0-9./:@_-]+$/;

interface Requirements { image?: unknown; packages?: unknown; system?: unknown; renv?: unknown }

/** The operator's options for the R engine. */
export interface ROptions {
  /** Base images a workspace may name in .kuraa/run.json, besides the default. */
  images?: string[];
}

const names = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && NAME.test(x))) throw new Error(`${what} must be a list of plain package names.`);
  return v as string[];
};

/** A container image with R, the driver's packages, and what the workspace asks for. */
export function imageRecipe(requirements: unknown, workspace: string, options?: unknown): ImageRecipe {
  const req = (requirements ?? {}) as Requirements;
  const image = req.image === undefined ? DEFAULT_IMAGE : String(req.image);
  if (!IMAGE.test(image)) throw new Error('.kuraa/run.json: r.image is not an image name.');
  const allowed = [DEFAULT_IMAGE, ...((options as ROptions | undefined)?.images ?? [])];
  if (!allowed.includes(image)) {
    throw new Error(`.kuraa/run.json asks for the image ${image}, which this host does not allow. It allows ${allowed.join(', ')}; whoever runs the host can allow more with --r-image.`);
  }
  const packages = names(req.packages, '.kuraa/run.json: r.packages');
  // System libraries: what the workspace asks for, and what package installs added (its manifest).
  const system = [...new Set([...names(req.system, '.kuraa/run.json: r.system'), ...names(readManifest(workspace).system, `${MANIFEST}: system`)])];
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
    // Its content, not a placeholder: sessions and the installer must build the same image.
    context['renv.lock'] = readFileSync(lockfile, 'utf8');
    lines.push(
      'COPY renv.lock /tmp/renv.lock',
      `RUN R -q -e 'install.packages("renv"); renv::restore(lockfile = "/tmp/renv.lock", library = .libPaths()[1], prompt = FALSE)'`,
    );
  }
  return { containerfile: `${lines.join('\n')}\n`, context };
}
