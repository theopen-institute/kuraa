# 0121 · Word counts read the history themselves

The third step of the review of the core ([0119](0119-what-a-document-is-its-type-says.md),
[0120](0120-search-searches-for-itself.md)). Word counts' client half was a component
([0094](0094-word-counts-and-document-details.md)), but the words written each day were counted by
the host. That was `wordlog.ts`, behind `host.wordsByDay` and `/api/words`, reached through a
service of the core's (`CoreHost.history.wordsByDay`) whose `WordsDay` type was part of the
feature contract.

Now `@kuraa/words` counts them in its host half, through the feature contract alone, on its own
route (`GET /api/features/words/days?since=YYYY-MM-DD`). Gone are `/api/words`,
`host.wordsByDay`, `CoreHost.history`, `HistoryService` and `WordsDay` in `@kuraa/feature-kit`.
`WordsDay` is now `@kuraa/words`'s own. How words are counted is as before.

## What the contract gains

Three parts, each general, so other features can use them too (a timeline, say, or who wrote
what):

- **`FeatureContext.history`**: the workspace's history as this device holds it, read only. The
  host does it in `history.ts`.
  - `log({ since?, merges? })`: the commits on the branch checked out, newest first, each with its
    author's date (with its offset), its author, its co-authors (`Co-authored-by:`) and whether it
    is a merge.
  - `changes(commits)`: what each changed against its first parent, renames followed.
  - `read([{ commit, path, before? }])`: files as they were (`before`: in the first parent), all
    asked at once, one `git cat-file --batch`. A file not in UTF-8 is null.

  The spaces' histories ([0066](0066-permissions-without-a-centre.md)) are not in it, as the word
  log never counted them.
- **`FeatureContext.edited()`**: the documents open in rooms here, on the branch checked out,
  changed since their last commit. For each: its text at the branch's head (null: not there), its
  room's text now, and who changed it. Word counts adds these words for today, credited to
  whoever typed them, as the host did.
- **`FeatureContext.store`**: what a feature keeps on this device for a workspace, as JSON by
  name (`get`, `set`; null forgets). It is kept in `.git/kuraa/features/<id>/<name>.json`: never
  synced or committed, each feature's apart, and gone when the workspace's folder goes. Names are
  `STORE_NAME` (`a-z`, `0-9` and `-`), so a feature cannot write outside its own folder. Word
  counts keeps what each commit wrote there (`commits`), so each commit is counted once.

## What changed

- **The count is kept in a new place**, so every commit is counted once again, the first time
  someone opens Word counts after updating. The old `.git/kuraa/words.json` is left where it is,
  unread.
- **`FEATURE_API_VERSION` stays 2**: this branch already went from 1 to 2 in 0120, and this
  removal is part of the same change.
