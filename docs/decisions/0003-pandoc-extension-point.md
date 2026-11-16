# 0003 · The Pandoc extension point

R Markdown must be added through the type registry alone, with no change to `kernel` or
`format-pandoc` other than recorded, general extension points. `format-pandoc` exports
`createPandocType(ext)`, where `ext` may:

- add or replace node and mark specs (`nodes`, `marks`),
- convert mdast nodes first (`parse.block`, `parse.inline`), falling through when they return undefined,
- serialize its own nodes and inline code variants first (`serialize.block`, `serialize.code`),
- add node view hints.

Nothing in it names R Markdown. `format-rmarkdown` uses it to add `code_chunk` and the `engine`
attribute on inline code. The default `pandocMarkdown` type is `createPandocType()` with no extension.
