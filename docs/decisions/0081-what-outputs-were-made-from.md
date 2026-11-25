# 0081 · What an output was made from

> Adds to [0041](0041-rendering.md) (renders), [0024](0024-out-of-date-outputs.md) and
> [0058](0058-shared-outputs.md) (runs) and [0066](0066-permissions-without-a-centre.md) (spaces).

A figure made months ago is asked for again, and its data and codes have changed since. With one git
history, the commit it was made at would say what went into it; but a render recorded nothing (the
document "as it is now", its latest output kept), and code reads from several histories at once: the
workspace's own branch, and each space at least as widely read as the document (0066). Spaces never
name each other, so nothing says which of their versions went together.

## Each output says what it was made from

- **A record** (`MadeFrom`, in `@kuraa/session`): the workspace branch's commit, the commit of each
  space the code could read, and the files it could read that differed from them (edited, new, or
  taken away: the first 50 named, the rest counted). Only spaces the code could read are named, so
  the record shows whoever sees the output nothing they could not read.
- **On every run** (`RunRecord.madeFrom`), as it starts; passed to the workspace's other devices with
  the run (0058), checked as the rest is.
- **On every render's output** (`output.madeFrom`). A render first commits the document's open room,
  where this device leads it (0077), as well as writing it: so the commit named holds what was being
  typed, and the document is not among the files that differ.
- Files git ignores are no one's and are not named. Neither are timestamps used to work it out later:
  a device can have a commit long after it was made, and clocks differ (as the policy reads none).

## The files it was made from, put together again

**Files it was made from…** under a finished render in the Preview panel saves them as a zip
(`GET /api/renders/made-from?path&format`): the workspace's files at its commit, then each space's at
its own, a path both have staying the workspace's, as the folder shows it. Files that differed are in
it as last committed, and the panel says how many there were. A commit this device no longer has (a
space it no longer reads) is said, not guessed around (410).

The files are put together in a tree of git's own, made for the zip and never put on a ref. Kept on
one (a commit of every space, a "view", considered and declined), it would hold every space at once
where a refspec, a push or a device serving refs could send it on, and keep deleted files alive for as
long as it stood; the record of commits says the same with none of that.

## Not yet

- Runs have the record, but nothing in the app offers their files yet.
- Making an output again from the zip is by hand: unzip, open, render.
