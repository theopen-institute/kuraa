# 0007 · History entries carry the file's path at that commit

`GET /api/history?path=` uses `git log --follow`, which crosses renames, and also treats a new
file with the same content as an existing one as a continuation of it. The spec's
`GET /api/history/:commit?path=` then failed for older entries, because the file had another
path in those commits.

Each history entry now includes `path`, the file's path in that commit (from `--name-only`). The
client fetches past versions by that path.
