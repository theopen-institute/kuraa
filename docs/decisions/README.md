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
