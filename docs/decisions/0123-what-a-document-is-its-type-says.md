# 0123 · What a document is, its type says

The owner asked for a review of the core, to "suggest if anything there should be moved to a
contract-based component", and then: "Yes, begin working through this." This is the first step.

## What was wrong

Whether a file was a document, in the sense of having words, header fields, or being part of a
book, was decided by its name, the same pattern written out eight times:
`/\.(md|markdown|qmd|rmd)$/i`, in the host (setting header fields, today's words, a folder's book,
the word log) and in three components (compile, details, corkboard).

- **A format from elsewhere could not take part.** A third party's prose format (AsciiDoc, say)
  would have no words, no details, no corkboard cards and no header fields, whatever its type
  could do. The direction is that every kind of component may come from a third party
  ([0091](0091-the-feature-runtime-commands-and-places.md), *Features come from this repository,
  for now*).
- **The kernel knew Markdown.** `markdownWords`, which says what a reader reads of Markdown, was
  in the kernel, whose first line says it "knows nothing about any file format".
- **The names were not the types.** `.qmd` was counted as a document, but no format opens it: it
  opens as Text. A `.md` file was counted even where the host has Pandoc markdown turned off.

## What a type says now

`DocumentType` (the kernel's contract for formats) gains three optional parts. Each is the type's
answer to one question that a file name was being asked:

- **`prose(text)`**: what a reader reads of the text: not its header, code, markup, addresses or
  citation keys. A type with it is a document of prose. Its words are counted everywhere the same
  way (`proseWords(type, text)` and `wordChange` in the kernel, which now count prose given to
  them and know no format). Without it, a file has no words: word counts, targets, today's words
  and the corkboard pass it over.
- **`header`**: its header's fields, read (`read(text)`: the fields by name, `{}` for no header,
  `null` for one that cannot be read as fields) and written (`write(text, fields)`, as the host's
  `withHeaderFields` did: only the named fields change). Details, targets and what the corkboard
  edits use it. Without it, there are no fields to show or set, and the host refuses to set them
  (400, as before).
- **`markdown: true`**: its text is pandoc's Markdown with a YAML header, so documents of it can
  be joined into one book ([0093](0093-order-and-compile-over-folders.md)). Compile's joining
  shifts Markdown headings and drops YAML headers, so this is about the text itself, not only
  being prose.

Pandoc markdown and R Markdown (`createPandocType`) give all three. Their Markdown prose rules
(`markdownProse`, `markdownWords`) and header fields (`pandocHeader`, `withHeaderFields`) moved
from the kernel and the host into `@kuraa/format-pandoc`, with their tests.

## Components ask the type

Both feature contexts gain **`typeOf(path)`**: the file's `DocumentType` as this side opens it
(among the formats the host has on), or undefined.

- On the host (`FeatureContext.typeOf`): the host's own `typeFor` (its name, or the first line of
  a file with no extension).
- In the client (`FeatureClientContext.typeOf`): the type the file list gives the file, else the
  type its name would have among those the host has on.

Compile (which documents can be left out of a book, and its marks), details (which documents have
details, and reading them) and the corkboard (which files are cards, their words and target) ask
it. The host asks its own types the same things: setting header fields, today's words (open
documents and the word log), a folder's book and its outline's word counts.

## What changes for people

Nothing for `.md`, `.markdown` and `.Rmd` files while their formats are on. A `.qmd` file, which
opens as Text, is no longer counted as a document: no words, no details, not in a compiled book.
The word log's cache (`.git/kuraa/words.json`) goes to version 2, so past commits are counted
again by this rule, once.

The word log counts each commit with the types the host has on when it counts it. A format turned
on or off later does not count past commits again. That was already true of the name pattern, and
a commit's words are kept once counted.

## Contracts

These are additions, so no version changes: `DocumentType`'s new parts are optional, and
`typeOf` is new on both feature contexts. `FEATURE_API_VERSION` stays 1.
