# 0021 · The document header is edited in its own dialog

(The dialog is now part of Document settings, and the right-click menu changed: [0054](0054-document-settings.md). The page shows the title, and it is typed there: [0055](0055-title-in-the-page.md).)

A Pandoc document's header (the YAML metadata block at the top: title, authors, date, bibliography,
output settings) is not drawn in the page. It is edited in the **Header** dialog, opened by
right-clicking the file in the sidebar (**Header…**, now **Document settings…**) or from the menu. The Source view still shows
it as text, and it can be edited there.

**Who knows what.**

- The format's editor module declares the header (`FormatEditor.header` in `@kuraa/editor-kit`):
  which block holds its YAML, and the fields the format knows, each with a label, a sentence on
  what it does, a group, and how it is edited (`text`, `paragraph`, `date`, `list`, `boolean`,
  `number` or `yaml`), with suggested values. Pandoc's editor offers Pandoc's own metadata fields
  and the template variables most often set in a header (`pandocHeaderFields`); R Markdown's adds
  `output`, `params` and `always_allow_html` (`headerFields` on `createPandocEditor`).
- The format's editor module keeps the block out of the page: drawn as nothing, the cursor (and
  Select All) kept after it, and transactions typed in the page that would change it refused.
  Transactions marked `DELIBERATE_EDIT` (the Source view, the dialog) and other people's go through.
- The client draws the dialog for any format that declares a header, and does the YAML (the `yaml`
  library). With the format's editor module turned off (Components), the header shows in the page
  as a YAML block again, and there is no dialog.

**The dialog.** Fields show in the document's order. A value that does not fit its field (authors
with affiliations, `output` with options) is edited as YAML in place; fields the format does not
know are edited as their value suggests. **Add field** lists the format's fields by group, with a
search, and takes any other name. The **YAML** tab edits the header as text; YAML that does not
parse cannot be saved. Clearing a field, or removing every field, removes it (or the header).

**Saving.** From the fields, only the fields changed are written, onto the header as it is when
saving, so someone else's change to another field is kept, as are comments, order and quoting.
Saving YAML typed in the dialog writes the whole header, and asks first if someone changed it
meanwhile. Either is one edit, undone with ⌘Z.

**The sidebar's right-click menu** had Open, Header… (for files whose format has a header), Rename…
and Delete… for a file; a new file or folder for a folder or the top level, and Rename… for a
folder (with everything in it; the open file follows, committed as a rename).
