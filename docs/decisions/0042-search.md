# 0042 · Searching every file, open documents as they are being edited

**⇧⌘F**, or **Search…** in the menu, opens a Search panel beside the document. It finds a phrase
(literally, with **Match case** as a choice) in the workspace's text files, grouped by file;
documents are shown by their title, other files by name, each match with its line. Choosing a match
opens the file with the phrase selected and scrolled to.

**The host** (`GET /api/search?q=&case=1`, `packages/host/src/search.ts`) asks `git grep
--untracked -I -n -z --fixed-strings` (`-i` without Match case): tracked and untracked files, as
`.gitignore` leaves them, binary files skipped. Git does not follow links (an untracked link is not
searched; a tracked one would be searched as its target's name, so links are dropped from the
results), and files over 2 MB are left out by name (`:(exclude,literal)`). Lines are cut to 240
characters around the match; at most 100 matches per file and 1,000 in all, saying when there were
more. It only reads, so it runs beside the host's serial work, not in its queue.

**What is being typed is found.** For every document with an open room on the current branch, the
room's text as it is now replaces git's results for that file, so a word typed a second ago is
found before it is written to the file, and one just deleted is not.

**Opening at the match** (`locateMatch` in `packages/client/src/docActions.ts`). The editor shows
blocks, not source lines, so the client serializes the live document, finds the line nearest the
one reported that has the phrase, the top-level block that holds it (from the type's block ranges),
and the same occurrence of the phrase inside that block as the editor shows it. A source file is one
node per line, so its line is exact. A phrase that exists only in markup (inside a link's address,
say) puts the cursor at the start of its block.

**Tests.** `packages/host/test/search.test.ts` (tracked, untracked, ignored, binary, large and linked
files; case; phrases that look like options or patterns; a room's unsaved text);
`packages/client/test/compare.test.ts` (finding a match in the document as the editor shows it);
`tests/e2e/search.spec.ts`.

**Not yet:** regular expressions, whole words, replacing across files, and searching other branches
or past versions.
