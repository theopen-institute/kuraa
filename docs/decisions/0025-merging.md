# 0025 · Merges read documents, and keep conflicts in them

Merging two versions of a file never stops and never loses either side. Documents are merged as
documents; a passage both sides changed differently stays in the document with both versions, to
choose between when someone wants to.

**Merging commits** (`packages/host/src/merging.ts`). `mergeCommits(git, x, y)` merges two
commits without touching the working tree or any branch: `git merge-tree --write-tree`, then the
files git could not merge line by line are merged by their document type, and the result is
written with a temporary index and `git commit-tree`. If one commit contains the other, there is
nothing to merge. Rules for what git cannot merge as text:

- changed on one side, deleted on the other: kept, changed;
- binary files: the first version kept, the second saved beside it as `name.conflict-<commit>.ext`;
- links and submodules: the first version kept.

**The same merge everywhere.** The commit depends only on the two commits: parents in a fixed
order (the lower id first), the author `Kuraa <merge@kuraa.invalid>`, the later of the two
commits' dates, and a message made from them (`Merge 3f2c1e0 and 9a41d7b`, with the files that
keep conflicts). Every device merging the same two commits therefore makes the same commit, and
peers that merge at once need not merge their merges.

**Documents** (`DocumentType.merge`, `@kuraa/kernel` `diff3`). Pandoc and R Markdown merge by
blocks: a block only one side changed takes the change; blocks both changed in place are merged
one by one, word by word (each word keeps the space after it, so two insertions at the same place
clash rather than interleave); a block one side deleted and the other changed is kept, changed.
The header is merged line by line, and a line both changed keeps the second version as a YAML
comment (`# Bo wrote: title: …`), since a header cannot hold a div. Where both changed the same
words differently, a conflict block keeps both:

```markdown
:::: {.conflict}
::: {.version by="Ada" commit="3f2c1e0"}
The samples were collected in early spring.
:::

::: {.version by="Bo" commit="9a41d7b"}
The samples were collected over two weeks in March.
:::
::::
```

It is a fenced div of fenced divs: Pandoc reads it, it is in git like any text, and every device
makes it alike. Types without `merge` (text and source files) are merged line by line with git's
markers (`mergeLines`), which is what programmers expect.

**Choosing.** The editor draws a conflict block with who wrote each version and **Keep this** on
each, and **Keep both** (one after the other). Choosing is an ordinary edit, so it reaches
everyone; nothing must be chosen straight away, and the rest of the document, and the versions,
are edited as usual. The sidebar counts a file's conflicts (`DocumentType.conflicts`, or git's
markers), from the live document while it is open.

**Sync** now uses this: it fetches, merges as above (keeping conflicts in the documents and saying
where), moves the branch on, and pushes. It no longer aborts.

**Not yet:** conflicts marked within a sentence (a whole block is the unit); renames on both sides
are kept under both names.
