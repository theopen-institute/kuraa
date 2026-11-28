# 0114 · Importing Word documents and Scrivener projects

**Status: built.** **Import…**, on a folder's menu and on the top level's (＋'s menu, right-clicked),
makes a Word document or a Scrivener project a folder of the workspace:

- **A Word document** (or OpenDocument, RTF, EPUB, HTML) becomes a document for each chapter, or for
  each section with its chapters as folders, or one document.
- **A Scrivener project** becomes folders and documents as its binder has them, with each document's
  details and what goes in its book.

Nothing needs Podman: the conversion is the built-in pandoc's ([0107](0107-rendering-without-podman.md)).

The owner, shown what was left for parity with Scrivener, chose importing first ("Start with 1"): it
is what lets a Scrivener user move their work. It was done in two steps, Word first, since a
Scrivener project's texts are RTF and need the same conversion.

## What is decided

**Two things the core gives components, beyond importing** (`FeatureContext`; `RUN_API_VERSION` and
`FEATURE_API_VERSION` stay 1, the contracts only grew):

- **`convert(name, bytes)`**: a file converted into Markdown by a renderer that converts its kind
  (`Renderer.convertsFrom`, `convert`: new in the run-kit contract). pandoc.wasm converts Word,
  OpenDocument, RTF, EPUB and HTML. It gives pandoc's Markdown and the media the file held. It runs
  in a scratch folder of its own and sees nothing of the workspace. Word's tracked changes are taken
  as accepted.
- **`create(files, { message, by })`**: new files, all or none, committed together, with each folder
  that gets them committed into its space where it has one (0069). It may hold documents, folders'
  orders, images and other files, and it never overwrites. A path that is already there refuses the
  whole batch. Each must be somewhere the person may write, and portable. An image is kept without
  its details (0108's `cleanImage`); one whose details could not be found is left out, and the
  answer says so. The host announces the change to the open clients (`files-changed`).

**`@kuraa/import`, a component** (on by default).

- **Its client half:** **Import…** opens a dialog for the folder. A Word file or a Scrivener project
  is dropped there (a project's folder, dropped as a folder), chosen as a file, or chosen as a
  folder. A `.zip` of a project works too, unpacked in the page. For a Scrivener project, only what
  the import reads is sent:
  - the project file (`<Project>.scrivx`, never Dropbox's conflicted copies);
  - its texts, synopses and notes;
  - its research files.

  Its snapshots, search indexes, backups and settings stay behind. Files go a part at a time (8 MB),
  as base64, to its routes.
- **Its host half:** keeps what is sent for one import, in memory: at most 1 GB, forgotten after half
  an hour unused. It converts, plans the folder and adds it with `create`, then answers with what it
  made and what it could not bring.

**A Word document** becomes a folder named by its title (its own, or the file's name). The title and
author are kept for Compile. Then, as chosen:

- **Each chapter (Heading 1)**, the default. Each level-1 heading begins a document titled by it, and
  the headings below move up a level, as a document's own headings go below its title (0093). What
  comes before the first heading is a document of its own, untitled.
- **Each section (Heading 2), chapters as folders.** A chapter is a folder (its name its heading).
  What it says before its first section is an untitled document in it.
- **The whole file**, as one document.

A file with no heading to split at is one document.

**A Scrivener project** (Scrivener 3: `Files/Data/<UUID>/content.rtf`, `synopsis.txt`, `notes.rtf`;
Scrivener 2: `Files/Docs/<ID>.rtf`, `<ID>_synopsis.txt`, `<ID>_notes.rtf`) becomes a folder named by
the project's title. The format was learned from a real Scrivener 2.4 project, its structure only.

- **The binder's order** becomes each folder's order (`.kuraa-order`).
- **Folders** (the Draft, Research and the folders in them) become folders.
- **A document with documents under it** becomes a folder: its own text first, as an untitled
  document, since the folder's name is its heading in a book.
- **Other documents** become documents. Their text is converted from RTF with bold, italics, lists,
  pictures and so on; pictures go in the document's own files folder (0109).
- **Each document's synopsis, label, status and keywords** go into its header (0094), by the names
  the project gives them.
- **What isn't in the compile** (*Include in compile* off) is left out of Compile (0093).
- **The Draft** gets the project's title, author and word target for Compile (0106).
- **Research's PDFs, images and the like** come as files.
- **Notes** become documents in a **Notes** folder, titled as their documents.
- **Said and left:**
  - the Trash;
  - snapshots;
  - web pages kept in the project;
  - comments (the words they were on are kept: their links are taken away).

A real Scrivener 2.4 project was planned through it, without its text being read: 101 documents, 13 folders, two images, one PDF and about 110,000 words, in 2.6 seconds. It reported the
Trash's 80 items, 43 comments and the snapshots.

**File names** are made as the app makes them: a document's from its title (`pathForTitle`,
`slugify`), and a folder's as it reads (`folderName`), since a folder's name is its heading in a
book. These moved from the client into the kernel (`@kuraa/kernel`), so the host half names files as
the page does. An import into a folder that already has one by its name gets a number (*The Coast 2*).

**The top level's menu** (right-clicking ＋) now has what features add for the top level, as the
folder `/`. That brings **Import…**, and **Compile…** of the whole workspace, which Compile already
did. **A file opened that the list does not have yet** (one just imported) makes the page ask for
the list again first.

### Not yet

- Scrivener's comments as Kuraa's (annotations, 0082), and its project notes (`Files/ProjectNotes`).
- Collections (saved searches and lists), custom metadata, and document targets.
- Scrivener 1 projects (`.scriv` without a `.scrivx`), and Word's old `.doc` files (save as `.docx`).
- Importing Markdown folders (Obsidian, Ulysses): files that are Markdown already can be copied in.
