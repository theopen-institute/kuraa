# 0043 · Past versions are restored as an edit, and compared with now

A past version opened from the history could only be read. Now it can be compared with the document
as it is, and restored.

**Labels.** The history and the past version show a version by its date and the people who made it;
a named version by its name, a save by the parts it changed ("Saved: Methods"), a merge as "Work from
elsewhere combined". Commit ids and messages are behind **Details** on the past version.

**Restore this version…** asks first, in plain words ("Make the document read as it did on 3 Nov
2026, 14:05? Everyone editing it will see the change, and you can undo it like any edit"). It then
changes the live document in the editor, as the person's own edit (`replaceWithText` in
`packages/client/src/docActions.ts`: only the blocks between the first and last difference are
replaced, so everyone's cursors elsewhere stay put). So collaborators see it at once, ⌘Z undoes it,
and it is written, committed and credited like any edit. Nothing changes on the host: restoring is
an edit, not a git operation, and history is never rewritten. A document open read-only (another
device's rules, [0033](0033-document-rules-and-people.md)) is not changed. The restored blocks are
written as the format writes them; blocks equal to the current ones keep their text exactly.

**Compare with now** shows the past version against the live document (`compare.ts`): top-level
blocks are matched as merges match them (the kernel's `matches`), then a block that changed is
compared word by word (`wordTokens`): words only in the past version struck through, words only now
marked as added. Blocks with less than a third of their words in common are shown as one removed and
one added. Runs of unchanged blocks are folded, keeping one on each side of a change.

**Tests.** `packages/client/test/compare.test.ts` (blocks and words, folding, restoring only what
differs); `tests/e2e/versions.spec.ts` (labels without ids, Details, comparing, restoring for two
people, the file written, undo).

## The desktop app's right-click menu

The desktop app had no context menu. Right-clicking now offers spelling suggestions for a misspelled
word (`replaceMisspelling`) and **Add to Dictionary**, **Look Up** for a selection on a Mac, and
**Cut**, **Copy**, **Paste** and **Select All** as the place allows. ⌘F is left to the page (the
editor's own find); the app adds no find of Electron's, and its Edit menu (the standard roles)
takes no ⌘F.
