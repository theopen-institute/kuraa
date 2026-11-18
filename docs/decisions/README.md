# Decisions

One short note per deviation from, or interpretation of, the prototype build spec.

| # | Decision |
|---|----------|
| [0001](0001-node-only-typecheck.md) | One root TypeScript config; packages export their TypeScript source |
| [0002](0002-declarative-node-views.md) | Format packages describe node views as data; the client implements them |
| [0003](0003-pandoc-extension-point.md) | `createPandocType` is the extension point R Markdown builds on |
| [0004](0004-oracle-known-differences.md) | Pandoc constructs the parser does not yet match, and the oracle allow-list |
| [0005](0005-fuzz-normalisation.md) | What the fuzz test treats as equal |
| [0006](0006-client-shells.md) | The shell supplies document types; one client build loads from a host, Vite or `file://` |
| [0007](0007-history-paths.md) | History entries carry the file's path at each commit, so versions from before a rename open |
| [0008](0008-markdown-cues.md) | No toolbar or top bar; formatting comes from typing markdown; history starts closed |
| [0009](0009-shell-boundary.md) | The host does all file and git work; the client sees its shell through one interface; `pnpm dev` |
| [0010](0010-text-format.md) | One Text file type for source and data files: a ProseMirror node per line, highlighted by file name |
| [0011](0011-running-chunks.md) | Running R chunks: one R session per document on the host, shared outputs, never in the file |
| [0012](0012-format-editor-modules.md) | Each format brings its editor behaviour in an editor module; the client keeps only what is generic |
| [0013](0013-run-plugins-and-sandboxing.md) | Running code through engine and environment plugins (see 0018, 0019) |
| [0014](0014-packages.md) | Packages: declared per workspace in a committed manifest, stored once per host, installed apart from the data |
| [0015](0015-editable-source.md) | The Source view is editable, with character-level merging against the rich view |
| [0016](0016-vue-client.md) | The client's components are Vue; editor objects are never made reactive; plugins stay framework-free |
| [0017](0017-components-panel.md) | Components… shows the host's engines, environments and formats, and turns your own editing behaviour on and off |
| [0018](0018-untrusted-users.md) | People using the app are not trusted: code runs only in Podman, nothing in a document runs in the app, configuration is flags |
| [0019](0019-engine-and-environment-components.md) | Engines and environments are separate components meeting through run-kit; the host imports none; unsandboxed needs a flag |
| [0020](0020-components.md) | What extends the app (formats, engines, environments) is called a component, in the interface and the code |
| [0021](0021-document-header.md) | A document's YAML header is edited in a Header dialog (right-click the file), not in the page |
| [0022](0022-titles-and-filenames.md) | Documents are known by their title; filenames are made from it, safe for every file system and git |
| [0023](0023-file-icons.md) | Each document type defines its files' small icon; the client draws them all alike |
| [0024](0024-out-of-date-outputs.md) | Every run records what its session had run before it, so outputs computed from code that has since changed are flagged, and Rebuild above runs only what is behind |
| [0025](0025-merging.md) | Merges read documents (blocks, then words), never stop, and keep a conflict in the document as a block with both versions; the same merge commit on every device |
