// TinyTeX, as a tool (decision 0045): TeX for PDFs made with LaTeX, downloaded
// when someone asks, kept once on the computer, and seen read-only by the
// renders that use it, with its bin folder on their PATH.
//
// What it installs: TinyTeX's "TinyTeX-1" bundle (about 54 MB; the packages
// R Markdown's pdf_document needs), the release TINYTEX_VERSION, for Linux on x86_64 or
// aarch64, checked against its SHA-256. TinyTeX publishes both architectures,
// so a Mac's Podman machine (aarch64) and an Intel one get the same thing.
// LaTeX packages a document needs beyond those are added with tlmgr from CTAN,
// which checks what it downloads (missing.ts reads what a log says is missing;
// scripts.ts has the installer's scripts).
//
// The installer's image is Ubuntu 24.04, the base of the default R image
// (rocker/tidyverse), so its layers are already on the computer, with perl
// (tlmgr), curl, xz, fontconfig and gpg (tlmgr verifies CTAN's signature with
// it). It is small and does not change when the R image does.
import { defineRunComponent, type Tool } from '@kuraa/run-kit';
import { ADD_SH, INSTALL_SH } from './scripts.js';
import { missingParts, validPart } from './missing.js';

export { missingParts, validPart } from './missing.js';

/** The TinyTeX release, from github.com/rstudio/tinytex-releases. */
export const TINYTEX_VERSION = '2026.11';
/** Its TinyTeX-1 bundle for each architecture (as `uname -m` names it): file and SHA-256. */
const BUNDLES: Record<string, { file: string; sha256: string; bytes: number }> = {
  x86_64: { file: `TinyTeX-1-linux-x86_64-v${TINYTEX_VERSION}.tar.xz`, sha256: '5b75befa848deae702ae6fa12ff0eef3f110d7e4e2a979ae99f101eba3c9c70d', bytes: 53_616_060 },
  aarch64: { file: `TinyTeX-1-linux-arm64-v${TINYTEX_VERSION}.tar.xz`, sha256: 'b351c365e4085a179c8d76fddadff612d4e4fd16a946953fb8b9d331f4f7344a', bytes: 53_792_928 },
};
const INSIDE = '/opt/kuraa/tools/tinytex';

const INSTALLER_IMAGE = [
  'FROM docker.io/library/ubuntu:24.04',
  'RUN apt-get update && apt-get install -y --no-install-recommends perl curl xz-utils ca-certificates fontconfig gpg \\',
  ' && rm -rf /var/lib/apt/lists/*',
  '',
].join('\n');

const install = INSTALL_SH
  .replace('@CASES@', Object.entries(BUNDLES).map(([arch, b]) => `  ${arch}) file=${b.file}; sum=${b.sha256};;`).join('\n'))
  .replaceAll('@VERSION@', TINYTEX_VERSION)
  .replace('@MB@', String(Math.round(Math.max(...Object.values(BUNDLES).map((b) => b.bytes)) / 1e6)));

export const tinytex: Tool = {
  id: 'tinytex',
  label: 'PDF with LaTeX',
  description: 'TeX (TinyTeX), for documents whose header asks for LaTeX to make their PDF (xelatex, pdflatex or lualatex). Downloaded once for this computer; the LaTeX packages documents need are added as they need them.',
  version: TINYTEX_VERSION,
  downloadBytes: Math.max(...Object.values(BUNDLES).map((b) => b.bytes)),
  architectures: Object.keys(BUNDLES),
  inside: INSIDE,
  path: (arch) => [`${INSIDE}/bin/${arch}-linux`],
  // Its own folder is read-only where it is used: what TeX caches (luaotfload's
  // font names, fonts made on the fly) goes to the process's temporary folder.
  env: () => ({ TEXMFVAR: '/tmp/texmf-var' }),
  installer: {
    image: { containerfile: INSTALLER_IMAGE },
    files: { 'install.sh': install, 'add.sh': ADD_SH },
    install: (view) => ({ argv: ['sh', `${view.files}/install.sh`], env: { KURAA_TARGET: INSIDE, KURAA_WORK: view.scratch } }),
  },
  parts: {
    label: 'LaTeX packages',
    record: '.kuraa/tex-packages.json',
    valid: validPart,
    missing: missingParts,
    add: (view, o) => ({ argv: ['sh', `${view.files}/add.sh`], env: { KURAA_TARGET: INSIDE, KURAA_NAMES: o.names.filter(validPart).join(',') } }),
  },
};

export default defineRunComponent({ name: '@kuraa/tool-tinytex', tools: [tinytex] });
