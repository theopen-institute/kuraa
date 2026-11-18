# 0026 · Automatic commits say what changed; history groups them

The host commits often: 30 seconds after the last edit, at least every 5 minutes while editing
goes on, and when the last person leaves a document. Each commit is a point to go back to and, with
peers (0027), how a change reaches a device that does not have the document open. The timings stay;
what changes is how the commits read.

**Messages.** An automatic commit names the document (its title, else its filename), the parts of
it that changed (the headings over the blocks that differ from the last commit, or "header"), and
who edited: `Edit Field notes: Methods, Results (Ada, Bo)`; three parts at most, then "and 2
more". A new file is `Create …`. Types without headings (source files) give no parts. Co-authors
stay as `Co-authored-by` trailers, and the commit carries `Kuraa-Kind: autosave`, a git trailer, so
anything reading the history can tell the host's saves from named versions.

**History.** The history panel folds consecutive saves less than two hours apart into one editing
session ("12 saves: Methods, Results", the time span and who took part), opened to see each save.
Named versions and other commits stand on their own between sessions; merges the host made
(0025) are shown quieter. `GET /api/history` gives each commit's `kind`: `autosave`, `merge` or
`commit`.

**Not squashed.** Saves are never combined afterwards: rewriting history breaks as soon as another
device has it.
