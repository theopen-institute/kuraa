# 0107 · A document's own files: `report.md.files/`, kept, moved and read with it; references that follow

**Status: built** (the folder, its permissions and spaces, references written again on a rename or
move). **`PROTOCOL` 11.** Changes [0106](0106-images-in-git.md)'s `images/` beside a document; adds to
[0069](0069-permissions-on-files-and-folders.md) (permissions) and [0082](0082-annotations.md) (what is
kept beside a document).

The owner, on how embedded files should be kept in the long run (images now, other Markdown files and
more later):

> "The idea is that this should be a folder that isn't necessary visible from the sidebar but that
> contains anything that 'belongs' to the file. What about a hidden folder with the same name as the
> file itself? That way, if multiple files are side by side, they can each have their own folder.
> Wouldn't this also make permissions simpler?"

Then, after a review (below): files take the document's permission to change them too, with the
protocol bumped; and the folder is named without a leading dot, hidden in Kuraa only.

## The folder

A document's own files are in a folder beside it named after its whole filename and `.files`:
`ch/report.md` → `ch/report.md.files/`. The document names them relative to itself, as any path
(`![The bay](report.md.files/bay.jpg)`), in the syntax Pandoc and Quarto already read.

- **The whole filename**, so `report.md` and `report.qmd` side by side have a folder each, and its
  name is the same shape as a feature's companion folder (`report.md.annotations/`, 0082).
- **No leading dot.** A dot hides the folder everywhere, not only in Kuraa: Finder, `ls` and most file
  managers hide it (whoever copies `report.md` by hand outside Kuraa does not see its files), and
  some ways of publishing skip dot folders (Netlify, Jekyll and Hugo sites). Quarto copies a picture
  a document names in a dot folder into its site, but keeps the dot (`_site/.report.md/bay.png`).
  So the folder is plain, and Kuraa hides it itself.
- **Kuraa hides it** wherever it lists files: the host marks each file in it as its document's (`of`,
  as companions are), so the file list and Open (quick open) leave them out; search does not find in
  them; word counts and compiling a folder leave them out. A folder whose document is gone shows on
  its own, as a companion does.
- **Everything the dialog adds** goes there (0106): images now; any embedded file later.
- **Copies are free.** The same picture in two documents is two files in their folders, and one blob
  in git: the history does not grow. A file several documents use on purpose (a logo, a bibliography)
  is kept in an ordinary folder and named from there.

`filesFolderOf` and `documentOfFiles` (`@kuraa/kernel`, `references.ts`) are the one definition: a
path is one of a document's files if a folder on its way is named as a file with an extension, then
`.files` (the outermost counts).

## With its document

- **Renamed or moved** (`PATCH /api/files`): the folder goes with it, rooms in it closed, its files
  kept in their spaces (`carrySpaces`), in the move's one commit, as companions are.
- **Deleted**: the folder goes with it, all of it, in the same commit (a companion keeps others' own
  files; a document's own files are the document's).
- **Into a space** (its readers changed, 0069): every file of the folder goes with it (`moveToSpace`).
- **A rename that arrives by merge**, while this device added a file at the old name: the file
  follows its document (`followRenamedDocuments`, as for companions) and the document's references
  to it are written again, as this device's commit.

## Who reads them, and who changes them

**Reading** is a space's (0066): a file is read by those whose space holds it. A document's own files
are in its space. A new file goes into the document's space where it is in one, else where a file
made there goes (`spaceForNew`). Before this, an image pasted into a document of its own audience was
committed onto the workspace's own branch, where everyone has it; now it never leaves the document's
readers.

**Changing** follows the document: `permissionPaths` (policy.ts) is `pathsAbove` with the document put
between its files' folder and the folder the two are in:

```
ch/report.md.files/bay.jpg → itself, ch/report.md.files/, ch/report.md, ch/, ''
```

So whoever may change a document may change its files, its own permission (a file's, 0069, in the
clear or by its hash) is theirs, and a document with none of its own leaves them to its folder's, as
before. It is known by name alone, so every device works it out the same. Adding an image now checks
it: someone who may not change the document cannot add to its files (403).

**`PROTOCOL` 11.** The gate judges incoming work by these rules, so a device on 10 would judge a
document's files by their folder and refuse what an 11 takes. Devices on different protocols do not
sync until both are updated, as with every change of what the gate takes. The release that carries
this is a minor version (0.12.0).

## References that follow

A rename or a move broke every relative reference to what moved, and every relative reference in a
document that moved to another folder. Now they are written again:

- **A format says where its references are**: `DocumentType.references(text)` (new in the kernel's
  contract) gives each image's, link's and link definition's target and where it is written. The
  Pandoc type (and R Markdown, built on it) reads them from the same Markdown tree its parser starts
  from, so nothing in code counts. A third party's format gives its own or none.
- **The host writes them again** (`Host.rewriteReferences`) in the move's commit: in every document
  that names something that moved, and, in a document that moved, every relative reference, from its
  new place (`../data.csv` becomes `../../data.csv` one folder down). A target keeps how it was written:
  its `#place`, angle brackets, percent-encoding. A document open in a room takes the change there,
  so everyone in it sees it at once.
- **Not this person's to change**: a document whose references would follow but that the person
  moving may not change is left as it is (the others' devices would refuse the edit), and the app
  says so ("Moved. index.md still points to the old place: it is not yours to change.").
- **Worked out, not kept.** The references are read from the documents each time (only those that
  moved, or whose text names something that did), never stored beside them, so they never disagree
  with the text or conflict in a merge.

## The review, before building

The design was reviewed once more before it was built. What it found, and what was done:

| Found | Done |
| --- | --- |
| A dot folder is hidden outside Kuraa too: copied by hand without its files, skipped by some publishers | No dot: `report.md.files/`, hidden in Kuraa |
| Pandoc (Word) and Quarto (a website) read images in a dot folder or a plain one alike; renders mount the whole workspace, and compiling gives each document's folder as a resource path | Nothing to change |
| An image pasted into a document of its own audience was committed onto the workspace's own branch | Into the document's space |
| Adding an image checked no permission | Checked: the document's |
| "Permissions are simpler" holds only if the policy knows a folder's document; changing who may write is a gate change | `permissionPaths`; `PROTOCOL` 11 |
| Spaces carried a document's own companion files only | Its own files all go |
| Titles name files (0022), so renames are frequent, and each must rewrite the document's own references | In the rename's commit, from the text the closed room saved |
| A move to another folder breaks the document's other relative references, not only references to it | Every relative reference written from its new place |
| A rename arriving by merge strands a file added meanwhile at the old name | It follows, and the document's references with it |
| Companions (`.annotations`) and own files (`.files`) are two conventions | Kept apart: companions are their people's own files, these the document's. One folder for both is a later step |

## Not done

- **Including other documents** (Quarto's `{{< include _methods.qmd >}}`), and the other kinds of
  embedded file (PDF, data, video) with their own handling in the editor: later, each through
  `references` and the folder.
- **References in the header** (`bibliography: refs.bib`) and in code (`read.csv("data.csv")`) are not
  written again.
- **Seeing a document's files** in the app: they are hidden, with nowhere yet to list or remove them
  (a document's ⋯ menu could).
- **Files nothing names any more** stay in the folder (and in history); removing an image from the text
  does not remove its file, so undo brings it back whole.
- **Existing `images/` folders** are left where they are, and still shown.
