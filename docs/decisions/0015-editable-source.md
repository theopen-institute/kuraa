# 0015 · The Source view is editable

**Source** (status bar) shows the document as markdown in CodeMirror, and it can be edited: what
you type reaches the live document, and what others change appears in it as they type
(`packages/client/src/SourceEditor.ts`). It starts from the file on disk, so blocks nobody has
touched show exactly as written.

**Source → document.** On every change, the source before and after the change are parsed, and
the smallest difference between them is found down to the character (ProseMirror's
`findDiffStart`/`findDiffEnd`). That difference is moved onto the live document (through a step map
over the small drift between the parsed source and the live document) and applied as one replace.
y-prosemirror turns it into character-level changes in the room, so a collaborator typing in the
same paragraph keeps their text. Comparing source with source, rather than source with the live
document, matters: markdown normalises some things the rich view keeps (a space at the end of a
paragraph, for one), and comparing against the live document would quietly undo them.

**Document → source.** When the document changes otherwise (another person, an outside edit the host
merged, a format tidying footnotes), it is serialized against the source it last matched, so
untouched blocks keep their exact text, and CodeMirror gets only the span that differs; the cursor
stays put.

**Never working from a stale copy.** Both directions run at once. One subtlety: a keystroke reaches
the page before CodeMirror reads it (on the next frame), and CodeMirror discards unread input when
updated from outside. So when a change arrives, the source first reads pending input (CodeMirror's
internal `observer.forceFlush`), merges the two edits as text against the source both started from,
and applies the user's part to the document just after, outside y-prosemirror's handling of the
incoming change (which would ignore it).

**What still conflicts.** Two people changing the same characters at the same moment, as anywhere;
and a source edit that changes a paragraph's structure (adding `**` around words, say) while someone
types inside that stretch, since that stretch is rebuilt. Blocks you change in Source are written in
the format's canonical form (`__x__` becomes `**x**`).

**Tests.** `tests/e2e/source.spec.ts`: editing in Source reaches the rich view and the file, with
structure; one person typing at the start of a paragraph in Source and another at its end in the
rich view, at the same time, both keep their text (stable over repeated runs).
