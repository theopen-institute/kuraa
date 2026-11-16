# Round-trip test corpus

Fixtures for the markdown round-trip tests: (1) parse then serialize
must reproduce each file byte for byte, and (2) `pandoc -f markdown -t
json` must give the same AST for the original file and for our
canonical re-serialization.

Real working files from the project owner are still to be added.

This README is not itself a fixture.

## Files

- `pandoc-manual.md` · large real-world document using nearly every Pandoc extension (downloaded from `MANUAL.txt`) · GPL-2.0-or-later, from jgm/pandoc (https://github.com/jgm/pandoc)
- `field-notes-saltmarsh.md` · YAML front matter, ATX headings with `{#id .class}`, setext headings (`=` and `-`), `-`/`*` bullets, nested lists, `1.` ordered list, backslash hard breaks, block quote with attribution, images with and without `{width=50%}`, Unicode (‰, °C, ü) · original, written for this corpus, CC0
- `literature-review-attention.md` · structured YAML (author list), citations in all forms (`[@a; @b, pp. 46--48]`, `@key`, `[-@key, p. 51]`, `[see @x, sec. 3]`), footnotes incl. multi-paragraph, inline note, tight definition list, empty `{#refs}` div, `{.unnumbered}` · original, written for this corpus, CC0
- `methods-survey-weighting.md` · inline and display math, `$` as currency, pipe tables with alignment and caption, `1)` and `1.` ordered lists, math inside list items, snake_case words in prose and code, email address in prose · original, written for this corpus, CC0
- `meeting-notes-lab-2024-05.md` · no front matter, task lists `[x]`/`[ ]`, strikeout, consecutive blank lines between blocks, wrapped line starting `2024. The`, email addresses, snake_case in code spans, tight lists · original, written for this corpus, CC0
- `short-paper-pollinators.md` · YAML with multi-line `abstract: |` and `header-includes`, citations, footnote, inline note, display math on one line, images with `{#fig:id width=..}`, raw TeX block `\newpage` and inline `\cite{}` · original, written for this corpus, CC0
- `readme-corpus-tools.md` · README style, no front matter, setext headings, ``` and ~~~ fences (`bash`, `{.bash}`, `text`, `python`, `` ``` toml ``), indented code blocks, URI and email autolinks, inline links with titles (incl. a title wrapped over two lines), `* * *` and `---` rules, backslash escapes · original, written for this corpus, CC0
- `protocol-sample-handling.md` · grid tables (incl. alignment row `+:===+`), multiline table, simple table, table captions with ids, Unicode symbols (−, °, ×) · original, written for this corpus, CC0
- `oral-history-excerpts.md` · line blocks (top level and inside block quotes, with indented continuation), CJK text, accented names (Álvarez Núñez, Ó Briain), `lang` metadata · original, written for this corpus, CC0
- `workshop-handout-html.md` · raw HTML blocks (`<div>`, `<details>`, `<table>`, `<hr>`), inline HTML (`<kbd>`, `<em>`, `<span>`), HTML comment, raw TeX block and inline, `` `\clearpage`{=latex} `` raw inline, ```` ```{=html} ```` raw block · original, written for this corpus, CC0
- `lab-notebook-crystallisation.md` · fenced divs incl. three-level nesting with `:::::`/`::::`/`:::`, div with id and attributes, bracketed spans (`.smallcaps`, `.underline`, key-value attributes), subscript, inline math · original, written for this corpus, CC0
- `glossary-atmospheric-chemistry.md` · no front matter, tight and loose definition lists, multi-paragraph definitions, superscript and subscript (chemical formulas, units), reference-style links (full, shortcut, angle-bracket URL, `"..."`, `'...'` and `(...)` titles) · original, written for this corpus, CC0
- `reading-group-notes.md` · block quote containing a `+` list, a nested block quote and (in another) a fenced code block; loose `+` list; `1)` list with nested `a.` list; nested tight bullet list · original, written for this corpus, CC0
- `progress-report-year2.md` · **no trailing newline**; footnotes (numeric and named labels, multi-paragraph), inline note, pipe tables with right alignment, internal link to a heading id, `{.unnumbered}` · original, written for this corpus, CC0
- `interview-guide-teachers.md` · **several trailing blank lines**; no front matter; setext H1; two-space and backslash hard breaks; ordered lists starting at 4, 7 and 10; escaped `\-`, `\<`, `\*`, `\%`, `\#`, `\\`; `* * *` rule · original, written for this corpus, CC0
- `survey-wellbeing-analysis.Rmd` · R Markdown: YAML with nested `output:` options for two formats and inline R in `date`, `{r setup, include=FALSE}`, chunks with `fig.cap`/`fig.width`, inline `` `r ...` ``, pipe table, citations · original, written for this corpus, CC0
- `interview-coding-summary.Rmd` · R Markdown: `word_document`/`html_document` options, chunk inside an ordered list item, empty `{r}` chunk at end of file, task list, block quote, inline R · original, written for this corpus, CC0
- `regression-notes-housing.Rmd` · R Markdown: `pdf_document` with `header-includes`, display and inline math next to inline R, `$` currency, chunks with labels and `echo=FALSE`, empty `{r}` chunk, citations · original, written for this corpus, CC0
- `power-analysis-reading-intervention.Rmd` · R Markdown: `bookdown::` outputs and `params:`, `{python sim, eval=TRUE}` and bare `{python}` chunks, inline R referencing params, math, table · original, written for this corpus, CC0
- `sensor-qc-report.Rmd` · R Markdown: `toc_float`, `includes:` nested options, chunks inside ordered list items (`echo=TRUE`, `eval=FALSE`), display math, table, email address · original, written for this corpus, CC0
- `bibliometric-trends.Rmd` · R Markdown: structured authors, `citation_package: biblatex`, `{python fields}` chunk, long inline R expression on its own line, table with caption, CJK snippet, `# References {-}`, empty `{r}` chunk · original, written for this corpus, CC0

## Notes

- Pandoc's markdown reader does not recognise knitr chunk headers such
  as ```` ```{r setup, include=FALSE} ```` as fenced code. It reads them
  as inline code spans inside paragraphs, and in places the fences pair
  up differently from how knitr sees them. The AST comparison for
  `.Rmd` files is still deterministic, but it checks less than it does
  for `.md` files.
- The citation keys, bibliography files, images and data paths
  mentioned in the original files do not exist; they are only there to
  make the documents realistic.
