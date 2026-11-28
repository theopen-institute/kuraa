# 0113 · Typst sealed in WebAssembly

**Status: built.** PDFs made without Podman ([0107](0107-rendering-without-podman.md)) are made by
typst.ts, Typst's compiler built to WebAssembly, instead of Typst's own program. It runs in a
JavaScript context that has nothing of Node's in it, and it is given only copies of what it may
read. The native Typst program is gone from the app, the scripts and CI. The server download now
makes PDFs too.

The owner asked whether Typst had a WebAssembly module, as pandoc does. Told it doesn't publish one,
they were also told that native Typst's boundary was its own checks (its root folder, a proxy that
answers nothing), not one imposed from outside as WASI imposes pandoc's. They asked for typst.ts to
be tried ("yes, try typst.ts in a worktree"). Shown the trial, they said: "yes, go ahead."

## What is decided

**typst.ts 0.8.0-rc4** (`@myriaddreamin/typst-ts-web-compiler`, Apache-2.0) is a dependency of
`@kuraa/render-pandoc`, pinned by the lockfile. It builds Typst 0.15.1, the version the native
program was, and makes the same PDFs: the 108,000-word novel came to 881,232 bytes against 881,242,
in 0.68 seconds against 0.47. It is a release candidate: 0.7.0, the latest stable release, builds
Typst 0.14.2. It moves to 0.8.0 when that is out.

**Sealed** (`packages/render-pandoc/src/typst.ts`). The module imports nothing but wasm-bindgen's
glue to JavaScript, and that glue reaches whatever the JavaScript global holds, including
`new Function`. So the boundary is the context it runs in, which is made like this:

- **A `vm` context whose global object is its own** (`vm.constants.DONT_CONTEXTIFY`). No object of
  the host's realm, so no way to its `Function`, is within reach. The first trial gave the context a
  global object made outside it, and the probe found `process` through
  `globalThis.constructor.constructor`. This closes that.
- **No code from strings** (`codeGeneration.strings: false`), so no `eval` or `new Function`, and
  **no dynamic imports**.
- **The glue's own `new Function`** builds five fixed functions: its default file access and package
  registry, which Kuraa replaces before use. Those five are made in advance and anything else is
  refused. A typst.ts that makes or loads code in any other way is refused as a whole (`sealGlue`),
  so an upgrade can't quietly widen this.
- **No files.** Typst reads through a file access Kuraa gives it, over a map inside the context that
  holds the render's copies (0107's: only what the host let the document read) and nothing else.
  There is no file system to escape to; a `../` path is refused by Typst itself.
- **No packages.** The registry Kuraa gives it refuses every one, and nothing is fetched.
- **Copies only.** Bytes go in as copies made inside the context: the module, the fonts and the
  files. No buffer of the host's is ever handed to it.
- **What Node would give as globals** and the glue uses (`TextEncoder`, `TextDecoder`, `console`,
  `queueMicrotask`) are written inside the context.

It runs in a worker thread of its own for each PDF, stopped at the render's time limit or when the
render is stopped, as pandoc's does.

**Fonts.** Typst sees only the fonts it comes with: typst-assets at v0.15.1, which are Libertinus
Serif, New Computer Modern (text and maths) and DejaVu Sans Mono. That is 17 files and 9 MB, each
fetched and checked against its SHA-256 by `scripts/fetch-render-tools.mjs` and each under its own
licence. So a PDF is the same on every computer. A document asking for a font the computer has
(`mainfont: Helvetica`) falls back to Typst's own.

**Where it is.**

- **The desktop app** carries typst.ts's module and glue and the fonts in `render/typst` and
  `render/typst-fonts` (`KURAA_TYPST_WASM`, `KURAA_TYPST_FONTS`). They are the same for every
  platform: 98 MB for rendering in all, against 107 MB with a native Typst per platform.
- **The server download** carries them too, so a host started from it makes PDFs (39 MB in all).
- **In a checkout**, the dependency and the cache.

### Not yet

- Fonts from the workspace, as copies the document's readers may read, like its images.
- typst.ts 0.8.0, when released.
