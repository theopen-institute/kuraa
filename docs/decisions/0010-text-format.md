# 0010 · Source files: the text format

`packages/format-text` is the general format for plain-text and source files, as
`format-pandoc` is for markdown. `createTextType` is its extension point; the package defines
types for R, Python, Julia, shell, YAML, JSON, TOML, settings files, LaTeX, BibTeX, XML/CSL,
HTML, CSS/SCSS, JavaScript/TypeScript, Lua, SQL, Stan, diffs, Dockerfiles, and plain text
(`.txt`, `.csv`, `LICENSE`, `Makefile`, …, at a lower priority than everything else).
Matching is by extension and file name; a file with no extension may be matched by its
`#!` line, which the host reads only for such files.

**One ProseMirror node per line, not one CodeMirror block.** The document is a sequence of
`line` nodes holding the line's text, with its terminator (`\n`, `\r\n`, `\r`, or none for the
last line) in an `eol` attribute. So:

- a round trip is exact for any input, mixed line endings and byte-order marks included, with no
  need for the previous text;
- an edit changes only the lines it touches, and outside merges apply line by line;
- collaborators' cursors and presence work as in prose. A single CodeMirror node view would hide
  them (ProseMirror's cursor decorations do not reach inside node views), and would turn every
  outside merge into one large text replacement.

A line with no terminator that is not the last (the first half after a split) is written with
the file's usual terminator. Line breaks that arrive in text (paste, drop) become new lines with
that terminator.

**The type declares a layout, as data.** The kernel's `EditorContribution.layout` is
`{ kind: 'lines', line, eolAttr, language }`, in the spirit of 0002. The client implements it in
`packages/client/src/lines.ts`: a monospaced, numbered layout; Enter keeps the line's
indentation; Tab and Shift+Tab indent by the file's unit (a tab, or its smallest run of leading
spaces); copying gives single newlines; no markdown commands or cues.

**Highlighting** runs CodeMirror's parsers (full grammars for Python, YAML and markdown; legacy
modes for the rest, and a small BibTeX mode written for this) over the document text outside any
CodeMirror editor, re-parsing incrementally after each change, and shows the result as
ProseMirror decorations. `packages/client/src/languages.ts` holds the language registry and one
highlighter, also used by code blocks and chunks in documents, so all code shares one palette
(`--tok-*` tokens in light and dark). Files over 2 MB are shown without highlighting.

**One list of types.** `packages/formats` exports `standardTypes`; the host loads it by default
(`HostOptions.types` overrides it) and the web shell passes it to the client, so the two cannot
drift apart.

**Not yet:** rendering or running anything (knitting, previews, running a chunk), large-file
virtualisation, and semantic highlighting beyond what the legacy modes give (R's mode, for
example, does not mark function calls).
