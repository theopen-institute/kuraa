# 0004 · Oracle: known differences

Parsing uses `mdast-util-from-markdown` with micromark extensions for GFM tables, strikethrough,
task lists and footnotes, math and YAML front matter. Pandoc constructs with no micromark
extension are handled by small, tested pre-scans in `format-pandoc/src/parse.ts`:

| Construct | How |
|---|---|
| Fenced divs | Top-level line scanner; body parsed recursively |
| Definition lists (tight and loose, at top level) | Line scanner; definitions dedented and parsed recursively |
| Citations, bracketed spans, inline notes, implicit header references | Bracket scan over each inline container, mapped back to source |
| Superscript, subscript, raw TeX commands | Patterns over text nodes, honouring backslash escapes |
| Table captions | Merged into the adjacent pipe table |
| Grid, simple and multiline tables, line blocks, `\begin{}` environments | Kept verbatim as `raw_block` (tier 3) |

Known remaining differences, allowed in the oracle test with `it.fails` (so they turn red if fixed):

- **Nested emphasis of the same kind** (`_a *b* c_`). ProseMirror marks cannot nest inside
  themselves, so the inner emphasis merges into the outer one.
- **Definition lists inside list items or block quotes.** The definition-list scanner runs at the
  top level and inside fenced divs only.
- Pandoc decides tight vs loose per list item; the schema records it per list. All corpus files
  agree, but mixed lists would differ.

Both affect only `pandoc-manual.md` in the corpus. Identity and locality are unaffected: untouched
blocks are always written back byte for byte.

R Markdown: Pandoc does not read knitr chunk headers (```` ```{r} ````) as code blocks, so the oracle
compares less there; chunk headers are preserved verbatim.
