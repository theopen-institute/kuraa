# 0045 · Tools: downloaded on demand, stored once per computer, used only where code runs

Some documents need more than the R image has. The first case is a PDF made with LaTeX: a header
that asks for `xelatex`, a journal's LaTeX template, `header-includes` with LaTeX commands. Typst
stays the PDF engine by default ([0041](0041-rendering.md)), but these documents need TeX, and a
TeX installation is far too big to put in every image for everyone. So TeX becomes a **tool**: a
toolchain the app downloads when someone asks for it, keeps once on the computer, and makes
visible inside the environment only to the processes that use it. TinyTeX is the first tool. The
same mechanism can later carry Typst, Quarto or others, so the base image can shrink rather than
grow.

**Tools run only where code runs.** A tool is never run by the host or the app. It is installed
by a process in the environment and used by processes in the environment, under the same policy
as runs and renders ([0018](0018-untrusted-users.md)). That is what makes it reasonable to fetch
on request: downloading a component that the *host* would load is a different question (it would
run with the host's rights) and is not decided here.

**A fourth kind of run component.** Engines are languages, environments are where processes run
([0019](0019-engine-and-environment-components.md)), and tools are toolchains those processes may
use. A `RunComponent` may list `tools` beside `engines` and `environments`; `@kuraa/run-kit`
gains a `Tool` contract, with only optional members added elsewhere, so `RUN_API_VERSION` stays
1. A tool says:

- its id, a plain label ("PDF with LaTeX"), a sentence on what it is for, and roughly how much
  it downloads;
- how to install it: an image recipe for its installer and the command that installs into an
  empty folder, given the network;
- how to add to it, if it has parts of its own (LaTeX packages), and how to read a failed log for
  parts that were missing;
- how a process uses it: where its folder is mounted inside and what to add to `PATH`.

The host knows no tool by name. The tools that ship are in `@kuraa/run-components`, like the
engines and environments that ship.

**Stored once per computer.** Like package versions ([0014](0014-packages.md)), a tool lives in
the host's data folder, not in a workspace or an image: `tools/<id>/<version>-<arch>/`, with a
`tool.json` recording what was installed, for which architecture, when, and what was added to it
since. A workspace and every other workspace on the computer share it, and it survives image
rebuilds. Installs go to a staging folder that is renamed into place only when they finish, so a
half-installed tool is never used. One install per tool at a time; everyone with a workspace open
sees its progress.

**Mounted, read-only, where it is used.** A render that needs a tool gets its folder mounted
read-only (env-podman already takes extra mounts) and its `bin` added to `PATH`. Processes that
did not ask for it do not see it. Only the tool's own installer, with the network and no
workspace at all, can write to its folder, just as only the package installer writes the package
cache. A tool records its architecture, and is mounted only into an environment of the same
architecture. TeX Live's binaries need only a common C library, which every image the host allows
by default has. On another kind of image the tool says it cannot be used there instead of failing
somewhere inside a render.

**Parts added on demand, without the network.** TeX is installed small and grows by the packages
documents use. Renders run with the network off, so a render cannot fetch a missing `.sty` the way
TinyTeX normally would. Instead it is two steps, as for R packages:

1. The render fails. The tool reads the log for files it lacks (``! LaTeX Error: File `x.sty' not
   found``, missing fonts) and names the packages that provide them, asking `tlmgr` in its
   installer if it must.
2. Where the host allows installs, the installer adds those packages with the network, and the
   render runs once more. Otherwise the message lists what is missing.

A workspace records the LaTeX packages its documents needed in `.kuraa/tex-packages.json`,
committed like `.kuraa/r-packages.json`, so a collaborator or another computer adds them before
the first PDF rather than after a failed one.

**Asked for by people, allowed by the operator.** Downloading a tool and adding to it are
installs: they fetch from the network. They are allowed where the host allows installs
(`--allow-installs`, on in the desktop app and `pnpm dev`), and nowhere else. A workspace cannot
loosen that. Where they are allowed:

- **Components…** lists the tools the host knows, whether each is downloaded, how big it is, and
  offers **Download** and **Remove**.
- A render that asks for a LaTeX engine the environment lacks no longer quietly falls back to
  Typst: its message offers **Download PDF with LaTeX** (about the size), and renders again when
  it is ready. Without the tool and without permission, it falls back to Typst as before and says
  why.

Removing a tool deletes its folder once no render is using it. Documents still render, with Typst.

**Sources are pinned.** The TinyTeX release is pinned by version and checked against its SHA-256
for each architecture, as the image's Typst is. LaTeX packages come from CTAN through `tlmgr`,
which checks what it downloads.

**Not decided here.** Downloadable components the host itself loads (formats, engines,
environments), which need signing and a publisher the operator trusts. Moving Typst out of the
image into a tool. Tools for environments that are not Podman.

## As built

**The contract** (`@kuraa/run-kit`, only optional members, `RUN_API_VERSION` still 1): `Tool`
(id, label, description, pinned `version`, `downloadBytes`, `architectures`, the `inside` path it
is mounted at, `path(arch)`, `env(arch)`, an `installer` with its image, scripts and `install`
command, and optional `parts`: a label, the workspace `record` file, `valid(name)`,
`missing(log)` and an `add` command); `RunComponent.tools`; `RenderContext.tools.use(id)`, which
returns the read-only mounts, PATH and environment, or why not and whether people may download it;
`RenderResult.needs`; and `EnvironmentStatus.arch` (env-podman reports `podman info`'s, as `uname -m`
names it). An installer answers on its last line of standard output (`TOOL_REPLY_PREFIX` and JSON).

**The host** (`packages/host/src/tools.ts`, routes in `tool-routes.ts`): `GET /api/tools`,
`POST /api/tools/download`, `/remove` and `/parts`, the last three only with `--allow-installs`.
Stores are shared by every host in the process with the same data folder; a `tools` room message
tells clients to ask again. The renderer asks for the tool by id (`tinytex`) before starting its
process, having read the header for `latex_engine` or `pdf-engine`.

**TinyTeX** (`packages/tool-tinytex`): release 2026.11, its `TinyTeX-1` bundle (the packages R
Markdown's `pdf_document` needs; 54 MB to download, 180 MB unpacked), with a SHA-256 for each of
`x86_64` and `aarch64`: TinyTeX publishes Linux builds for both, so no TeX Live installer of our own
was needed. The installer's image is Ubuntu 24.04 (the base of `rocker/tidyverse`, so its layers
are usually there already) with perl, curl, xz, fontconfig and gpg; the R image would have done but
changes with every workspace's packages. Mounted at `/opt/kuraa/tools/tinytex`, `bin/<arch>-linux`
on PATH, `TEXMFVAR` in the process's `/tmp`. Missing files are read from the log (`.sty`, `.cls`,
`.def`, `.ldf`, metrics, bitmap fonts, fonts fontspec looks for by name) and named by a built-in map
for common ones, else looked up with `tlmgr search --global --file` in the installer.

Where this differs from the text above, or adds to it:

- **Renders again a few times, not once.** After adding what a log named, the render runs again up
  to four times, as long as each round adds something new: a package's own needs show only once it
  loads. (tlmgr installs a package's declared dependencies, so tcolorbox took one round.)
- **The host drives it.** The renderer only uses the tool and reports `needs`; the host reads the
  failed log through the tools the render used, adds, records and renders again.
- **Parts are added in place**, not staged: tlmgr adds files and rewrites its list, and a render
  running meanwhile at worst misses what is being added. Downloads are staged as decided.
- **tlmgr** first updates itself (it refuses to add packages while CTAN has a newer tlmgr), uses
  one CTAN mirror for the whole addition, and once a newer TeX Live is out falls back to this year's
  frozen `tlnet-final` in TeX Live's historic archive.
- **The record** is `{ "packages": [...] }`, sorted, at the path the tool names; names in it are
  checked as the tool checks them before anything is installed.
- **Another kind of image** is caught inside the render, not before it: a LaTeX program that is
  there but cannot start makes the PDF with Typst, saying so. TinyTeX's own installer refuses musl.
- **tinytex does not install packages itself**: version 0.59 has no option for it, but decides so
  because its folder is not writable; the render script also replaces its `tlmgr_writable()` with
  one that says no.
- **A bug in 0041's LaTeX path**: rmarkdown runs LaTeX from the document's folder, which is
  read-only, so LaTeX could write nothing; the render script runs it beside the `.tex` in scratch.

**Tests.** `packages/host/test/tools.test.ts` with a tool, environment and renderer from outside
the packages (`fixtures/tools.mjs`): staging and layout, progress, one install at a time, refused
without `--allow-installs`, architectures, removal waiting for a render, mounts and PATH, the
offer, added parts and their record, restoring them. `packages/tool-tinytex/test/missing.test.ts`:
the log parser. `packages/host/test/tinytex-podman.test.ts` (with `KURAA_TEST_TINYTEX=1`): the real
download, R Markdown and Markdown with xelatex, and tcolorbox added and recorded.
`tests/e2e/tools.spec.ts`: the dialog lists TinyTeX; a fake tool downloaded and removed there, and
offered by the preview for a PDF.
