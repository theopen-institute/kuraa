# 0005 · What the fuzz test treats as equal

The fuzz test applies random edits (insert text with markup characters, delete, toggle a mark on a
word, split a paragraph, change a heading level or turn a plain paragraph into a heading), then
serializes, re-parses and compares documents. Some differences have no markdown form at all, so the
comparison normalises them away:

- whitespace at the start and end of a text block, and next to hard breaks;
- marks on whitespace outside code (`*a *b` can only be written as `*a* b`);
- empty paragraphs;
- list tightness (two paragraphs in one item always make a markdown list loose) and the `auto`
  flag on links;
- a bare `@key` citation glued to a preceding word, which markdown reads as text.

Everything else must round-trip exactly.
