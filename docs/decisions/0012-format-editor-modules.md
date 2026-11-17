# 0012 · Each format brings its editor behaviour

A format has two parts:

| Part | Where | Loaded by | Holds |
| --- | --- | --- | --- |
| Core | `@kuraa/format-x` | host and client | schema, parser, serializer, and hints: how to *show* nodes, as data (0002, 0010) |
| Editor module | `@kuraa/format-x/editor` | client only | what the format *does* in the editor: typing cues, key bindings, commands, behaviour, its own node views |

The contract between an editor module and the client is `@kuraa/editor-kit`: a `FormatEditor`
contributes ProseMirror `plugins(ctx)` and `nodeViews(ctx)`. The client passes an
`EditorContext`: the schema, whether the view is read-only (a past version), the session's
undo/redo, `isRemote(tr)` (so behaviour that tidies the document acts only on the user's own
edits), and dialogs (`askText`, `askConfirm`) in the client's style. A format's plugins come
before the client's generic ones (undo/redo, ProseMirror's base keymap), so its keys win.

The shell passes the modules by type id, as it passes the types: `@kuraa/formats/editor` exports
`standardEditors`, and the web shell gives both to `mountApp`. A type without an editor module
still opens, with generic editing.

**Where things are now:**

- `format-pandoc/src/editor`: the markdown cues (`**bold**`, `## `, fences, `[text](url)`, …), key
  bindings, commands, and footnotes (numbers, keeping notes in order, `[^label]` and `^[text]`,
  ⌥⌘F, Enter and Shift+Enter in a note, the reference, inline-note and note views).
  `createPandocEditor(ext)` is its extension point (`fence`, `keys`, `rules`), as
  `createPandocType` is for the core.
- `format-rmarkdown/src/editor`: chunk fences (```` ```{r} ````) and ⌥⌘I, through that extension point.
- The client: only what is generic. The editor shell, code blocks and running chunks (from the
  `code` hint), plain chips (from the `atom` hint), the source-file layout (from the `lines`
  layout), and where clicks put the cursor. Where it must create a block to type in, it uses the
  schema's default block (ProseMirror's `contentMatch.defaultType`), not a named node.

**Boundaries, enforced by lint:** a format's core may not import its editor module (the host loads
the core); editor modules may use ProseMirror's editing packages but not Yjs, the session, the
host or the client; `editor-kit` is types only.

The kernel's hints lost the footnote-specific kinds added for 0008 (`note`, `refersTo`,
`numbered`): footnotes are drawn by the Pandoc editor module now. Atoms gained `prefix`/`suffix`
(`$…$` for inline math), so the client's chip has no format-specific cases either. The kernel's
unused `EditorContribution.plugins` and `commands` were removed; editor-kit replaces them.

**Not moved:** the footnote and chunk styles are still in the client's stylesheet, and the
source-file layout (`lines`) is still the client's: it is a layout any format could declare.
