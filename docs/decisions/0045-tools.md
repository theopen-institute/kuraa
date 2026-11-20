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
