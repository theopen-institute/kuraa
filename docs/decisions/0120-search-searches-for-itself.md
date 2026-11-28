# 0120 · Search searches for itself

The second step of the review of the core ([0119](0119-what-a-document-is-its-type-says.md)):
Search's client half was a component ([0089](0089-preview-search-and-outline-are-components.md)),
but the searching was the host's ([0042](0042-search.md)). It was reached through a service of the
core's (`CoreHost.search`), whose result types were part of the feature contract. A component can't
add a service to the core, so no third party could have written Search, or a different search.

Now `@kuraa/search` searches in its host half, using only the feature contract, and its panel asks
its own route (`GET /api/features/search/search?q=…&case=1`). `/api/search`, the host's
`search.ts`, `CoreHost.search`, `SearchService` and the `Search*` types in `@kuraa/feature-kit` are
gone. The types are now `@kuraa/search`'s own.

## What the contract gains

Each addition is general, not Search's alone:

- **`FeatureContext.live(path)`**: a document's text as its room here has it now (what was typed
  a moment ago, before it reaches the file), or null where it has no room here.
- **`FeatureContext.read(path, { maxBytes })`**: null for a file larger than that, which is then
  not read at all.
- **`FeatureContext.belongsTo(path)`**: the document any file is kept beside (any feature's
  companion, or a document's own files, [0109](0109-a-documents-own-files.md)), or null.
  `documentOf` answers only for the feature's own companions.

`read` now returns null for a link, as its description always said, instead of throwing (the
host's path check refuses links before the file is opened). Search found this; any feature that
read every file in `list()` would have hit it.

## What Search does, as before

The files this device holds (`list()`: as `.gitignore` leaves them, with the spaces it holds), each
open document as its room has it now, and each other file read as text: in UTF-8, not through a
link, no larger than 2 MB, with no NUL byte (what git's `-I` left out as binary). Left out are
what is kept beside documents and the app's own files in folders (`.kuraa-*`). There are at most
100 matches a file and 1,000 in all, lines cut to 240 characters around the match, and a 400 for
an empty phrase, one over 500 characters, or one of more than one line. A file's type and title
are as its type reads them (0119), a document's title from its text as searched.

## What changed

- **Files are read by the feature, not grepped by git.** Measured on a workspace of 500 documents
  and 200 CSV files (28 MB), a search took 55 to 72 ms through the route. `git grep` alone took
  16 ms; the old route also listed and checked every file before grepping. Two things made that
  figure possible. A file's whole text is checked for the phrase before its lines are gone
  through. And `live` asks git which branch is checked out only for a path with a room: at first
  it asked for every file, a git process each, and the same search took over a second. A workspace
  much larger than that is slower to search than before. Should that matter, the answer is an
  index kept by the feature, not a search in the core.
- **Search goes through the files `list()` gives**, not also through the rooms open here. A draft
  ([0097](0097-starting-to-write.md)) has its file made as soon as anything is written in it, so
  one with words to find is found as before.
- **`FEATURE_API_VERSION` is 2**: a service was taken out of `CoreHost`, which is an incompatible
  change to the contract. Every feature is built with this repository, so nothing else changes.
