# 0014 · Packages: declared per workspace, stored once per host

People install and remove packages themselves: `install.packages()` in a chunk, or the
**Packages** panel (status bar). Engines manage packages through `run-kit`'s `PackageManager`;
R's is `packages/engine-r/src/packages.ts`.

**Where things live.**

| What | Where | Who writes it |
| --- | --- | --- |
| Each package version, once | the host's data folder (`~/Library/Application Support/kuraa`, `~/.local/share/kuraa`, or `--data-dir`): `engines/r/cache/<name>_<version>_<hash>/` | the installer |
| A workspace's library | `engines/r/libs/<workspace>/`: relative links into the cache | the installer |
| What a workspace uses | `.kuraa/r-packages.json` in the workspace, committed automatically | the host |

So installing a version another workspace already has costs nothing, workspaces can use
different versions, and the manifest travels with the repository: on a fresh clone or another
machine, the host installs what it lists before the first run. The cache key is the package,
version, build stamp and (for GitHub) commit, not the whole DESCRIPTION, which records how an
install was asked for.

**The manifest** lists what people asked for (`requested`), every package in the workspace's
library with a ref that installs that exact version again (`packages`), packages a session used
from the environment itself (`environment`, recorded as code loads them, so the workspace works
where the environment lacks them), and system libraries installs needed (`system`, added to the
environment's image).

**Installing apart from the data.** Installs need the network; the code under analysis must not
have it. So installs run in a separate process (in Podman, its own container) with the network,
the library and cache writable, and no workspace at all. Sessions see the library and cache
read-only, so code cannot plant something the installer later runs. `install.packages()` and
`remove.packages()` are replaced in R's `utils` (namespace and search path) by functions that ask
the host and wait; the chunk then continues, and `library()` finds the package in the same chunk.
Requests reach the host on the process's real standard output: inside a chunk, `stdout()` is
captured by `evaluate`.

**Where packages may come from.** A request could carry data out in what it asks to fetch, so
only plain refs are accepted: CRAN names (`dplyr`, `dplyr@1.1.4`), `bioc::name`, and GitHub
`owner/repo[@ref]`. URLs, paths and options are refused before anything runs. The installer uses
pak, which installs binaries where it can and knows each package's system requirements: if
system libraries are missing, they are added to the manifest, the image is rebuilt, and the
install is tried again (R must then be restarted to use them).

**Linking rules.** pak installs into an empty staging library; then requested packages are
linked, as are packages not otherwise available, and newer versions a linked package needs.
Versions the workspace already links, and packages the environment provides, are kept otherwise,
so installing one package does not quietly upgrade others.

**The starter set** is the environment's image: `rocker/tidyverse` by default (with pak), so most
work needs no installs; a workspace may name another base in `.kuraa/run.json`.

**Who may.** `--allow-installs` on a host (the desktop app and `pnpm dev` turn it on). Installs run
one at a time per workspace; everyone with a document open sees progress and results.

**Tests.** `packages/host/test/packages.test.ts` installs a real CRAN package with the local
environment (the manifest and its commit, the cache shared by two workspaces, `install.packages()`
in a chunk, restoring on a "new machine", removing, refusals); `runner.test.ts` does it in Podman
(the tidyverse from the image, installing from a chunk, the session still offline with a
read-only library); `tests/e2e/run.spec.ts` drives the Packages panel.

**Not yet:** `renv.lock` as the manifest; removing cache entries nothing uses; pak, remotes or
devtools installs called directly (only `install.packages()` is routed); packages for engines other
than R.
