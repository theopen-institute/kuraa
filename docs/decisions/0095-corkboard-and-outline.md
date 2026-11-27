# 0095 · The corkboard and the outline

**Status: built.** A component, `@kuraa/corkboard` (on by default), and two things the core gives
components for it: views of a folder in the main area, and a document's header fields set whether it
is open or not.

The owner, asking what came next for parity with Scrivener, chose these: Scrivener's two views of a
folder, its documents as index cards (the corkboard) or as rows with columns (the outline), each built
on what 0093 and 0094 made: a folder's order, kept in `.kuraa-order`, and each document's synopsis,
label, status, words and target, kept in its header.

## What is decided

**A folder shown in the main area.** Where a document is shown, a folder can be: in a **folder view**
a component gives (`folderViews`: an id, a name, and how it is drawn), offered on every folder's
right-click menu by its name (**Corkboard**, **Outline**). It stays until a document is opened (from
it, or anywhere), and goes when another workspace is opened. A view is told its folder, may show
another (`showFolder`: a folder's card opens that folder in the same view), and may switch to another
view of the same folder. Its context is navigation's (the files, the folders' orders, opening, `place`
to arrange): it shows the files as the file tree does, never apart from them.

**The corkboard**: what is in the folder, in the file tree's order (its order, then folders and
documents by name, as `@kuraa/files`'s own `buildTree` has it), one card each. A document's card has its
title (click: it opens), its synopsis (click: written in place), its label (the card's top edge in the
label's colour, and its name), its status, and its words (of its target). A folder's card says how
many documents are in it, all through it, and their words (click: that folder's corkboard). Another
file's card has only its name. Drag a card before or after another (the side of it the pointer is on):
the folder's order, which the file tree follows.

**The outline**: the same, as rows: title, synopsis, label, status, words, target, the label's colour
by the title. Synopsis, label (those used suggested), status (Scrivener's five and those used) and
target are edited in place; Enter, or leaving the field, saves it. What is typed stays as typed until
it is saved, whatever the view is told meanwhile (a save elsewhere, a commit). Drag a row above or
below another to arrange them.

**A document's header fields, set open or not.** The corkboard and the outline change documents that
are not open, so the core gives components a **documents** service (`host.documents.setHeader(path,
fields)`, a component using it saying so: `uses: ['documents']`). The host sets those fields in the
file's header (made where it has none, gone where none is left; the rest of it, comments and all, as
it was), and where the document is open, its room takes the change, as a title changed by **Rename…**
is: everyone in it sees it at once. It is committed, credited to whoever asked (`POST
/api/documents/header`), and refused where they may not change the document.

The component's host half gives what the cards show (`GET cards?folder=`): each document's details
(read as Document details reads them, 0094), words and target; each folder's documents and words, all
through it. It tells its client halves when a document is saved, or files move, are committed or
arrive, and they ask again.

### Not yet

A folder opened in the main area by clicking it in the file tree (it opens and closes the folder, as
now); several cards chosen and moved at once; cards in a freeform arrangement; the outline's columns
chosen, sorted, or widened; a document's own target and words beside its sections (an outline of its
headings); the view following its folder when the folder is renamed.
