# 0082 · Annotations: coding and comments, kept beside the documents, as a feature (proposed)

**Status: step 1 of the build order is built: features and the hooks the core gives them, with an
example feature (*Built: step 1*), as revised by *Who owns an annotation*; step 2, comments
(*Built: step 2*); and step 3, coding (*Built: step 3*). Steps 4 and 5 are not; nor is an author's
choice of a narrower audience.** It
adds a kind of component (a **feature**) and the hooks the core gives it, and the first feature:
**annotations**, which does two things on one base:
**coding** passages, as qualitative data analysis tools (NVivo, ATLAS.ti, MAXQDA) do, and
**comments** on passages and documents.

The owner asked for coding in Kuraa, in a standard annotation format (W3C Web Annotation), kept in
files of its own and never in the documents, and built as a component that is registered apart,
can be turned off, and reaches the data and the interface only through hooks the core defines. Then,
having read the first draft: no blind coding; coding and comments together, as one component
(**annotations**), as they share a strong base and may part ways in their details later.

## What it is for

**Coding.** A team keeps a **codebook** (codes, in a tree, each with a definition) and **codes
passages**: select text in a document and apply a code to it. Then they **retrieve**: every passage
coded *Distrust of institutions*, across the workspace, with who coded it. Several people code the
same documents, at the same time or not, and see each other's codings.

**Comments.** Anyone may comment on a passage, a whole document, or a coding, and reply. What QDA
tools call a **memo** is a comment here: a memo on a passage, on a coding, or on a document is a
comment on it. One kind of note, one word in the interface.

The documents are never changed by any of this. They stay what they are, readable and editable in
RStudio or any text editor, and a workspace without the feature (or with it off) is unchanged.

## The shared base, and what differs

Codings and comments are both W3C Web Annotations, told apart by their `motivation`. They share:
the companion file each document's annotations are kept in, its place in the document's space and
its moving with the document, how passages stay anchored, live state in the room, merging, the
margin they are shown in, and the hooks below.

What differs, now: a coding's body is a code from the codebook, and coding has the codebook, the
Codes and Retrieve panels, and agreement between coders; a comment's body is text, and comments
have replies and the Comments panel. What may differ later (resolving a comment, mentioning someone,
suggestions) is added to one without touching the base.

## The format

### Annotations: W3C Web Annotations, in one companion file per document

A document's annotations are in a file beside it, named after it: `interviews/p01.md` has
`interviews/p01.md.annotations.jsonld`. The file is a W3C **AnnotationPage**, valid JSON-LD, one
annotation to a line, everyone's in one file (*revised*: a file per person, in a folder beside the
document; see *Who owns an annotation*):

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "id": "p01.md.annotations.jsonld",
  "type": "AnnotationPage",
  "items": [
    {"id": "urn:uuid:0b6f2c1e-…", "type": "Annotation", "motivation": "classifying", "created": "2026-11-25T10:14:03Z", "modified": "2026-11-25T10:14:03Z", "creator": {"id": "urn:kuraa:person:7QK…", "type": "Person", "name": "Ana"}, "body": {"type": "SpecificResource", "source": "urn:uuid:5c1e…", "purpose": "classifying"}, "target": {"source": "p01.md", "selector": [{"type": "TextQuoteSelector", "exact": "I never trusted the council", "prefix": "and after the flood, ", "suffix": ". Nobody came for"}, {"type": "TextPositionSelector", "start": 1834, "end": 1861}]}},
    {"id": "urn:uuid:4a7d…", "type": "Annotation", "motivation": "commenting", "created": "…", "modified": "…", "creator": {…}, "body": {"type": "TextualBody", "value": "Is this the 2019 council or the new one?", "format": "text/markdown", "purpose": "commenting"}, "target": {"source": "p01.md", "selector": [{"type": "TextQuoteSelector", "exact": "the council", "prefix": "I never trusted ", "suffix": ". Nobody came for"}, {"type": "TextPositionSelector", "start": 1850, "end": 1861}]}},
    {"id": "urn:uuid:9d40…", "type": "Annotation", "motivation": "commenting", "created": "…", "modified": "…", "creator": {…}, "body": {"type": "TextualBody", "value": "Same words as P04. Compare.", "format": "text/markdown", "purpose": "commenting"}, "target": "urn:uuid:0b6f2c1e-…"},
    {"id": "urn:uuid:e2c8…", "type": "Annotation", "motivation": "replying", "created": "…", "modified": "…", "creator": {…}, "body": {"type": "TextualBody", "value": "The new one: she moved in 2021.", "format": "text/markdown", "purpose": "replying"}, "target": "urn:uuid:4a7d…"}
  ]
}
```

What every annotation has:

- **Its kind is its `motivation`**, a word of the W3C model: `classifying` (a coding), `commenting`
  (a comment), `replying` (a reply to a comment). Others the model has (`highlighting`,
  `bookmarking`, `editing`, …) are left for later, and an annotation of a kind this version does not
  know is kept and written back as it was.
- **Ids are `urn:uuid:`**, made by whoever makes the annotation. Merging goes by them (below).
- **The creator is the person**, by their identity's id ([0066](0066-permissions-without-a-centre.md)),
  with their name as it was. `created` and `modified` are ISO times.
- **The target is a passage, the document, or another annotation.**
  - A passage of the document's text, as in the file, by two selectors that name the same passage
    (the model's meaning of several): a `TextQuoteSelector` (the passage, and up to 32 characters
    before and after it) and a `TextPositionSelector` (where it starts and ends). Positions count
    characters as the model does (Unicode code points, not JavaScript's UTF-16 units) in the file's
    text, markup and header included. The quote is the truth; the position says where to look first.
  - The whole document: `"target": "p01.md"`.
  - Another annotation, by its id: a comment on a coding, a reply to a comment. The model allows
    annotations on annotations, so nothing is invented for it.
- **`source` is the document's name relative to the companion**, which JSON-LD resolves against the
  companion's own location, so any tool finds the document. The companion's name, not `source`,
  decides which document it belongs to: a rename made where the feature is off leaves `source`
  stale, and it is corrected when next read.
- **The layout is fixed**: items sorted by id, one to a line, keys in one order, so every device
  writes the same bytes for the same annotations and a diff in git reads as annotations added and
  removed.

What differs by kind:

- **A coding** (`classifying`) has one code as its body, named by its id in the codebook. One code per
  coding, not one with several bodies, so a code is added, removed and credited on its own, and
  agreement between coders compares like with like. Its target is a passage.
- **A comment** (`commenting`) has a `TextualBody` in Markdown, shown made safe. Its target is a
  passage, the document, or a coding.
- **A reply** (`replying`) has a `TextualBody` and targets the comment it answers (or a reply, for a
  thread that goes on).

### The codebook: a SKOS concept scheme

One per workspace, `codebook.jsonld` at its top (its path in `.kuraa/features.json`):

```json
{
  "@context": {
    "skos": "http://www.w3.org/2004/02/skos/core#", "id": "@id", "type": "@type",
    "Concept": "skos:Concept", "ConceptScheme": "skos:ConceptScheme",
    "prefLabel": "skos:prefLabel", "definition": "skos:definition", "scopeNote": "skos:scopeNote",
    "broader": {"@id": "skos:broader", "@type": "@id"}, "inScheme": {"@id": "skos:inScheme", "@type": "@id"},
    "color": "https://schema.org/color"
  },
  "@graph": [
    {"id": "urn:uuid:a1…", "type": "ConceptScheme", "prefLabel": "Codebook"},
    {"id": "urn:uuid:5c1e…", "type": "Concept", "inScheme": "urn:uuid:a1…", "prefLabel": "Distrust of institutions", "definition": "Doubt that councils, police or agencies act for the speaker.", "broader": "urn:uuid:3f…", "color": "#c2410c"}
  ]
}
```

A code is a `skos:Concept`: its name (`prefLabel`), what it means (`definition`), notes on using it
(`scopeNote`), its parent (`broader`) and its colour (schema.org's `color`, so no vocabulary of our
own is needed). Codings name codes by id, so renaming a code changes one line. Merging two codes
or deleting one rewrites the codings that name it, in every companion the device holds, as one
commit (*revised* by *Who owns an annotation*: codings are their makers' own, never rewritten; a
code merged says what replaces it, `isReplacedBy`, and one deleted is kept, marked deprecated;
see *Built: step 3*). Comments do not use the codebook.

### Why these

- **W3C Web Annotation** keeps an annotation apart from what it annotates by design, and its quote
  and position selectors are what make annotations survive edits elsewhere (Hypothesis has used
  them that way for years). It has coding (`classifying`), comments (`commenting`) and replies
  (`replying`) as words of its own, which is why the two share a base without strain. Recogito,
  IIIF viewers and JSON-LD tools read it as it is.
- **SKOS** is the W3C's standard for a scheme of concepts with a hierarchy and definitions, which is
  what a codebook is. The annotation model has nothing for one.
- **QDA tools read neither.** They exchange **REFI-QDA** (`.qdpx` projects, `.qdc` codebooks).
  That is an export and import (*Build order*), not how Kuraa keeps annotations: it is one XML
  project for everything, with positions in a plain-text copy of each source, which would not
  merge, follow renames or keep to spaces.
- **A companion beside each document, not one file or folder for the workspace,** because:
  - **Who reads it.** A file's readers are its space ([0069](0069-permissions-on-files-and-folders.md)),
    and an annotation quotes its passage. A companion is kept in its document's space, so it is read
    by exactly those who read the document. A central file would hand everyone the quotes.
  - **Renames, history and merges stay with the document.** The core moves a companion with its
    document (*Hooks*); a past version of a document has its annotations at the same commit; a merge
    touches only the companions of documents that changed.
- **One companion for coding and comments, and for everyone,** not one per kind or per person: they
  are anchored, moved, kept and merged alike, and are wanted together (a comment on a coding sits
  beside it). Nobody codes blind, so there is nothing to keep apart.
- **The file's text, not the rendered text,** because the file is what is in git and what other
  tools have. A tool that reads the file can check a quote without Pandoc. The editor maps file
  positions to its own through the document type (*Hooks: source map*).
- **Not marks in the document** (spans, comments, a `[text]{.code}` syntax, CriticMarkup): they
  change the document, which is what was ruled out.
- **Not JSON Lines.** One line per annotation merges well line by line, but a file of lines is not a
  JSON-LD document. A merge of its own (below) gives the same result with a standard file.

### Merging

The feature's companion and codebook files are a document type with a `merge` of its own
([0025](0025-merging.md)), by id: an item added on either side is kept; removed on one side and
unchanged on the other, removed; changed on both, the later `modified` wins (equal times: the one
whose line sorts later); changed on one side and removed on the other, kept as changed. It never
conflicts, depends only on its arguments, and writes the fixed layout, so every device makes the
same merge commit. Its version is part of the merge signature, as every type's is.

A reply whose comment was removed on another device is kept, and shown under *no longer found* with
the passage it was about, if any.

## Keeping passages where they were

The same for codings and comments.

- **In a room,** annotations of the open document are shared state of the room (*Hooks: room state*),
  each passage anchored by Yjs relative positions in the document's fragment, so they move with
  everyone's typing, exactly, live. The room's leader ([0077](0077-one-leader-per-room.md)) writes
  the companion when it writes the document, from the same document, in the same commit: **in every
  commit, a companion's positions are right for the document in that commit.**
- **When the file changed outside a room** (RStudio, a merge, a past version restored), a passage is
  found again when its document is next opened, or by the host after a merge: at its position if
  the quote is still there; else the quote nearest its position; else the quote found
  approximately, with its prefix and suffix deciding between candidates. What moved is written back
  as the leader's next ordinary commit, never in a merge commit.
- **A passage that cannot be found** is kept, never dropped, and listed as *no longer found* with
  its quote, for whoever made the annotation to place it again or remove it. A comment on a passage
  that is gone keeps its thread.

## Who owns an annotation (revision)

*The owner, after step 1 was built: comments are for anyone who can read a document, that being much
of the point of keeping them in files of their own; and any finer permissions on annotations follow
the ownership of one's own data that everything else follows: **who can see an annotation is its
author's to say; whether one they can see is shown is its reader's.** This revises "one companion
for coding and comments, and for everyone" above, and "A companion beside each document" in the
format. Built in step 1 (*Built*, below), but the narrower audiences.*

- **Each person's annotations on a document are a file of their own**, written only by their own
  devices, in a folder beside the document: `interviews/p01.md.annotations/@<identity ID>.jsonld`
  (an AnnotationPage as above). No one else changes it, however open the document's rules: a
  reader comments, and owns the comment, without being able to touch anyone else's.
- **Who may read it is the author's choice, within the document's readers.** By default the file
  is in the document's space, read by whoever reads the document. An author may keep some of
  their annotations for fewer (themselves, a group): a second file of theirs, in a space with that
  audience (`@<identity ID>.<space>.jsonld`). Never for more: an annotation quotes its passage, so
  its readers must all read the document; the host refuses an audience that is not within it.
- **Whether it is shown is the reader's choice:** by author, by kind (codings, comments), by code;
  kept as theirs (Settings › You, and the Comments and Codes panels' filters).
- **The policy says so, without knowing any feature.** A file whose name is `@<identity ID>` and an
  extension, in a folder beside a document that is there, is that person's own: they may change it
  wherever they read it, and no one else may, whatever the rules say, but to move it unchanged with
  its document (the gate takes a commit that moves a document and, under the same name and with the
  same content, the files beside it): a document renamed or moved carries the folder beside it,
  files and all. A file so named anywhere else keeps to the rules. This is a new kind of
  permission, judged alike everywhere: `PROTOCOL` goes up.
- **A document deleted leaves others' annotations on it as theirs** (the owner's choice): its
  folder keeps their files, the deleter's own going with the document, and the file list shows
  them on their own, for their authors to remove (or to keep). A folder deleted keeps them too.
- **Live, in a room**, each person's annotations are a map of their own (`feature:<id>:<person>`),
  seeded from their file by their own device. Each device writes its own person's file from the
  room, signed by them, not the leader (who still writes the document), and **only with what that
  person did there**: their own clients' changes, their own devices' edits, their seeding. A sync
  between devices holds anyone's changes, whoever made them, and a room joined comes with its
  state: what they put in a person's map is shown, and never written into their file as theirs.
  An edit to a person's map is taken only as its maker's own; a sync, whole, from someone who may
  change the document (refusing it would lose the document's edits in it too); a change to the
  document, as now, only from one who may change it. The annotations of people with no device in
  the room are shown from their files, found again by their quotes. Annotations for a
  narrower audience are not put in the room, which everyone reading the document shares: they are
  kept through the feature's routes, in their own space, and reach their readers by git.
- **Merging** is simpler: two people never write one file. A person's two devices still can, and
  merge by id as above.

What it changed in step 1: companions are a folder per document of files per person (the core's
naming, moved with documents, kept in spaces); a room's feature state is a map per person, seeded
and written by that person's device; the ownership rule in the policy and the gate; rooms take
changes to feature state as their makers'; the editor gives features their state in documents
opened read only. A document moved to another space takes only its mover's own files with it:
others' stay where they were, theirs to move.

## Features: a kind of component with two halves

A **feature** adds something people do (annotations first) that touches documents, the host and the
interface at once. Run components ([0019](0019-engine-and-environment-components.md),
[0059](0059-online-copy-is-a-component.md)) live in the host only, and editor modules
([0012](0012-format-editor-modules.md)) in the editor only, for one type. A feature has both halves:

| Part | Where | Loaded by | Holds |
| --- | --- | --- | --- |
| Host half | `@kuraa/annotations` | the host, from the standard list or `--component` | its file types, what it does when files change, its API routes |
| Client half | `@kuraa/annotations/client` | the shell, bundled, as `standardEditors` is | what it adds to the editor and the interface |

The contract is a new package, `@kuraa/feature-kit` (`defineFeature`, `FEATURE_API_VERSION`), with a
host entry and a framework-free client entry, as `editor-kit` is. The host refuses a feature whose
version differs; the client ignores a client half the host has no host half for.

Inside `@kuraa/annotations`, the base (the format, the companion, anchoring, room state, merging, the
margin) is one module, and coding and comments are each a part built on it, so either can grow its
own ways without the other.

**On and off, at three levels:**

1. **Loaded, on this host:** its operator's choice (Settings › Host, or a flag), as engines are.
2. **On, for a workspace:** `.kuraa/features.json`, committed, so it is the same for everyone in it;
   changed in Settings › Workspace by whoever may change that file. With annotations on, comments
   are on, and coding is on where the workspace says so as well
   (`{"annotations": {"on": true, "coding": true, "codebook": "codebook.jsonld"}}`): coding is a
   method a project uses, comments are for any workspace.
3. **Shown, for you:** Settings › You, kept in your browser: the margin, or the codings' highlights,
   off while you write, as format editors are turned off now ([0017](0017-components-panel.md)).

**Off never touches a file.** Companions and the codebook stay in the workspace, in git, in their
spaces; they open as text. A host that has the feature loaded but off for a workspace still
registers its file types, so its merges and merge signature are those of a host with it on.

## Hooks the core gives

What the core gives a feature, and nothing else. *Exists* means the core has it now; *new* means
this proposal adds it.

### Host

| Hook | What | Now |
| --- | --- | --- |
| **open(ctx)** per workspace | As `Sync.open`: the feature gets a context for one workspace and returns a session the host closes | new |
| **File types** | `DocumentType`s the feature brings, with their own `merge` | exists |
| **Companion files** | A feature declares a folder suffix (`.annotations`): beside each document, a folder of each person's own file. The core moves the folder with its document on a rename or move, in the same commit; a deletion takes only the deleter's own; keeps them in their document's space; folds them under their document in the file tree; leaves them out of search. The suffixes are recorded in `.kuraa/companions.json`, so every host keeps companions with their documents, whether or not it has the feature | new |
| **Room state** | A map per feature and person in each room (`feature:annotations:<person>`), seeded from their file by their own device, and written to it by their device: the leader with the document, others on their own. A client offers annotations only where its person's map was seeded | new |
| **Events** | After a save, commit, merge, rename or delete, with the paths. The kernel's `HookBus` already names these events and nothing calls it: the host fires it, and a feature's handlers are **after only** (a feature cannot hold up or refuse a save) | exists, unused |
| **Files** | Read any file the workspace's person may read; write only the feature's own files (its companions and the paths it declared, such as the codebook), through the host: whole or not at all, checked against who may change them, committed with the next commit and credited to the person | new |
| **Routes** | `/api/features/<id>/…`, added to the host's table with its access check, the person, and its path checks (`relPath`) | new |
| **Telling clients** | A message to the clients of the workspace or of one room (as `files-changed` is) | new |
| **Commit lines** | Optional: what its files' changes say in an automatic commit message ("Coded 3 passages, 1 comment") | new |
| **Source map** | `DocumentType.sourceMap(doc, parsed)`: a document position to a place in the file's text and back. Optional; without it, the kernel maps by `ParsedDocument.blocks` and the block's text found in its source, as search's `locateMatch` does now | new |

### Client

| Hook | What | Now |
| --- | --- | --- |
| **features** in `mountApp` | The client halves, by id, as `editors` | new |
| **Editor plugins, every type** | ProseMirror plugins and decorations for any document, given the `EditorContext`, the room's feature state and the source map. Read-only views (past versions) get them too, with the companion as it was then | new; `FormatEditor` does this for one type |
| **Margin** | A column beside the document's text that features put marks and cards in, at a passage's height, kept clear of each other | new |
| **Panels** | A panel beside the document (as Preview and Search), or of the workspace, with its key and its place in the ⋯ menu. `mount(element, ctx)` returning how to unmount it, so a feature does not depend on the client's Vue ([0016](0016-vue-client.md)) | new; `sidePanel` is a fixed list |
| **Menu items** | In the document's ⋯ menu ([0074](0074-the-document-menu-is-a-menu.md)) and a file's | new |
| **Selection actions** | What can be done with the selected text, offered in a small bar beside it. Not the editor's right-click menu: that is the browser's, with its spelling suggestions, and stays so | new |
| **Settings subpanels** | In Workspace and You, as the online copy's is in Host ([0076](0076-a-quieter-sidebar.md)) | new |
| **Keys and help** | Key bindings, listed in the Markdown and shortcuts sheet as `HelpItem`s | exists for formats |
| **Strings** | Its own catalogue, in the client's voice ([0044](0044-polish.md)) | new |
| **API** | Its own routes, through the client's connection and access code | new |

### Rules, kept by lint and by the contract

- The host and the client import no feature; features import only `feature-kit` (and `kernel`,
  `editor-kit`, ProseMirror).
- **A feature never writes a document.** Its write hook takes only its own declared files, so
  "annotations never change the documents" is kept by what it is given, not by its good manners.
- A feature observes the core and adds to it; it cannot refuse or hold up a save, a commit, a merge
  or a room.
- What people write in comments is data: shown as text, or Markdown made safe, never run, as nothing
  in a document runs in the app ([0018](0018-untrusted-users.md)).

## Annotations, the first feature

**Shared:**

- **In the document**: select text and code it or comment on it (a key, or a button beside the
  selection). Coded passages are underlined in their codes' colours; commented passages
  are tinted; both are marked in the margin, by who made them. A filter for whose annotations, and
  which kinds, show.
- **No longer found**: the annotations whose passages are gone, with their quotes, to place again or
  remove.

**Coding:**

- **Codes** panel (workspace): the codebook as a tree, with counts; add, rename, define, nest, colour,
  merge and delete codes; drag a selection onto a code to code it.
- **Retrieve** panel: every passage coded with a code (and its children, if asked), across the
  documents the person may read, each opening at its passage, with its comments.

**Comments:**

- **In the margin**: a 💬 beside each commented passage, opening its thread (*revised*: the threads
  are in the Comments panel, not cards in the margin, which is too narrow for them).
- **Comments** panel: the document's threads in order, each comment with its replies; reply, edit
  or delete your own. **Recent comments**: the workspace's newest, each opening at its passage.

## Build order

1. **The core hooks**, with a small test feature and no annotations: `feature-kit`, loading and the
   three levels of on and off, companions (renames, spaces, deletes, the tree), the room's feature
   state and its write at flush, the events, routes, the margin, the source map and its fallback.
2. **The base and comments**: the format, the companion type and its merge, anchoring and *no longer
   found*, the margin's cards, replies, the Comments panel. Comments first, as they use all of the
   base and need no codebook.
3. **Coding**: the codebook, coding and its highlights, the Codes and Retrieve panels.
4. **Out and in**: the workspace's annotations as one W3C `AnnotationCollection` with the codebook;
   REFI-QDA (`.qdpx`, `.qdc`) export and import of codings and comments (as memos), for NVivo,
   ATLAS.ti and MAXQDA, made where code runs, as renders are ([0041](0041-rendering.md)), since
   positions go to and from a plain-text copy of each document.
5. **Between coders**: agreement (per code and document: percentage and Cohen's kappa), and a
   comparison view.

## Open questions

- **The name.** "Feature" for the kind, beside engines, environments, tools, syncs and formats
  ([0020](0020-components.md)); in the interface these are all components, in Settings › Host's
  full list.
- **Annotating what you may not change**: settled by *Who owns an annotation* (anyone who reads a
  document annotates it, in files of their own).
- **Media.** Annotating parts of images, audio or video (a region, a time span) fits the same format
  (`FragmentSelector`, media fragments) and is left for later.

## Not decided here

Resolving comments, mentioning people, and suggested changes; codes on code chunks' outputs;
annotations in rendered documents (a coded report, comments in Word); a codebook per folder rather
than per workspace.

## Built: step 1

Features and the hooks above, with the changes building them made. Annotations are not built.

- **`@kuraa/feature-kit`** is the contract: `.` (what both halves share: `FEATURE_API_VERSION`,
  `FeatureStatus`, the companion helpers), `./host` (`HostFeature`, `defineFeature`, the room's
  `seed`/`write`, `FeatureContext`, events, routes) and `./client` (`ClientFeature`,
  `defineClientFeature`, `FeatureState`, the editor's, panels', menus' and settings' parts).
- **`@kuraa/features`** is the standard list, empty for now: `standardFeatures` for the programs
  that start a host (the command line, the desktop app, `pnpm dev`), `standardFeatureClients` for
  the web shell. The host and client import neither, kept so by lint, which lets the core import
  only the contract.
- **On and off.** `HostOptions.features` and `featuresOn`; the setting `features` in Settings ›
  Host and `--feature <id>` (as `--format`); `GET /api/features`, and `PATCH /api/features/<id>`
  (`on`, `settings`), which writes `.kuraa/features.json` (and `.kuraa/companions.json`, once on)
  as a commit, refused (403) to whoever may not change that file. Settings › Workspace has a
  switch for each feature and its settings as a subpanel; Settings › You hides one for you. A
  feature's file types are registered, and in the merge signature, whether it is on or off.
- **Rooms' state** is a map per feature and person in the room's Yjs document
  (`feature:<id>:<person>`), with a record of whose were seeded, by their own devices, from their
  files: the client offers nothing to do where its person's is not, and a file is written only with
  what its person did there, so a session started without a feature (or without a person's
  device) never empties one. A feature
  turned on while rooms are open, or a device joining a session, seeds its person's at once.
  Anchors are Yjs relative positions, resolved by walking the fragment with node sizes from the
  schema: the same on the host as in a browser, with no editor view. Each device writes its own
  person's files from a copy of the room taken with the document (the leader with the document,
  in its commit; others on their own, and as they leave); edits not written when the host stops
  keep them too. The annotations of people with no device in the room are shown from their files.
- **Companions** are each person's own files in a folder beside each document
  (`<document><suffix>/@<identity ID><extension>`). The folder moves with its document (a rename
  or move), everyone's files in it, in the same commit; a deletion takes only the deleter's own,
  others' staying, shown on their own; a new one beside a document in a space is committed into
  that space; folders of documents a merge renamed (by another app, or a host without the
  feature) follow them as this device's commit. The file list leaves out companions whose document
  it shows (`of`), and search leaves them out. `GET /api/companions` gives everyone's beside a
  document, as they are or at a commit.
- **Own files** are their owners' alone (docs/policy.md, *A person's own files*): the policy's
  `mayWrite`, beside a document that is there; the gate (which takes moves of them unchanged with
  their documents, and knows which space's history it judges); rooms (`takes`); and each host,
  which writes into its person's file only what they did in the room (`Mine`). `PROTOCOL` is 8. A
  host without an identity writes nothing of anyone's.
- **A feature's writes** (`FeatureContext.write`) are to this host's person's own files and the
  files it declares, checked against who may change them, and refused (409) for one beside a
  document whose room is open: that is the room's to write.
- **Events** are the kernel's `HookBus`, fired by the host at last: `open`, `save`, `commit`,
  `merge`, `rename`, `delete`, and `settings` (a feature's own settings changed); a bus per
  feature, after only.
- **Commit messages** name what features changed beside a document ("Field notes: 1 mark added
  (Alice Ng)"), from each feature's `describe`.
- **`DocumentType.sourceMap`** maps between document positions and the file's text, with a bias for
  a range's ends; without it, `sourceMapOf` aligns each block's text with its source.
- **The client** passes features to the editor (plugins after the format's, marks in the margin,
  actions beside a selection, each reopening the document when a feature comes or goes), draws
  their panels beside the document (their keys open and close them), their items in the ⋯ menu
  and a file's menu, their lines on the shortcuts sheet, and their plugins on past versions,
  given the companion as it was at that commit.
- **`@kuraa/feature-example`** (marks: a passage marked, each person's kept beside the document in
  `<file>.marks/@<identity ID>.json`) uses every hook. It is not in the standard list: the host's tests
  (`packages/host/test/features.test.ts`) and the browser's (`tests/e2e/features.spec.ts`, whose
  build alone has it: `vite build --mode e2e`) drive it, and it is a model for writing a feature.

**Not yet:** a feature cannot change the state of a room open on another device but through its
people (`FeatureContext` has no way into rooms); an author's choice of a narrower audience for some
of their annotations.

## Built: step 2

Comments, on the base coding will share: `@kuraa/annotations` (its host half; `./client`, its client
half; `./format`, the files' format), in the standard list (`@kuraa/features`), so every host and
the web shell have it; each workspace turns it on (Settings › Workspace).

- **The format** (`format.ts`): each person's file a W3C AnnotationPage (`@context`, `id` its own
  name, `items` one to a line, sorted by id, keys in one order). A passage named by a
  `TextQuoteSelector` (with 32 characters either side) and a `TextPositionSelector` in code
  points; its `source` the document's name from the folder (`../p01.md`). Comments are
  `commenting`, replies `replying` (targeting the comment's id), a comment on the document targets
  the document. Kinds not known are kept as they are. A person's two devices' versions merge by id,
  the later `modified` winning.
- **Finding passages again**: at their place if their quote is there; else, of the places their
  quote is, the one whose text around it agrees most with what was around it, then the nearest;
  else *no longer found*: kept, never dropped. (Found approximately, where the words themselves
  changed, is left for later.)
- **In the room**, each annotation of yours is `{ item, from, to }` (anchors while it is found) or
  `{ item, lost }`; the host writes your file from it, naming each passage as the text has it then.
- **In the app**: commented passages tinted, a 💬 in the margin opening the thread; **Comment**
  beside a selection (⌥⌘M), in any document you read; the **Comments** panel (⌥⌘K, and the ⋯ menu):
  threads in the order of the text, replies, editing and deleting your own, a comment on the whole
  document, whose are shown (everyone's, or only yours: your choice, in this browser), and those
  no longer found; **Recent comments**, the workspace's newest (`GET /api/features/annotations/recent`).
  Others' comments are live while a device of theirs is in the room, else read from their files.
- **Comment text** is shown as text (its Markdown not drawn yet), never as HTML.

The example feature's panel moved to ⌥⌘J, giving ⌥⌘M to Comment, as in other editors. The browser
tests' host loads the standard features with the example.

## Built: step 3

Coding, in `@kuraa/annotations`, where a workspace turns it on: a setting of its own under
Annotations (Settings › Workspace, `coding: true`), as comments are for any workspace and coding a
method a project chooses.

- **The codebook** (`codebook.ts`): `codebook.jsonld` at the workspace's top (or another name in
  the settings, `codebook`, ending `.codebook.jsonld`, so the file is known as a codebook by its name
  alone), a SKOS concept scheme in JSON-LD, one code to a line, sorted by id. It is a workspace file,
  everyone's, not anyone's own: changed through the feature's routes (`POST codebook`: add, change
  its name, definition, colour or parent, merge, delete) by whoever may change it, one change at a
  time, and merged by code when two devices change it at once (the later `modified` winning).
- **A codebook edited by hand keeps what it says.** What the app does not read (a `scopeNote`, other
  labels, nodes of other kinds, terms of the file's own context) is written back as it was. A colour
  is taken only as `#rrggbb`, as it goes into a page's style; any other is kept, unused. A file that
  is not a codebook (a hand edit gone wrong) is never taken for an empty one: the app refuses to
  change it (409) until it is put right, and two devices' versions of it merge line by line, as any
  text does, rather than by code.
- **Codes merged or deleted rewrite nobody's codings**, which are their makers' own. A code merged
  into another says so (`isReplacedBy`, Dublin Core's), and codings of it count as the other's; its
  children move up to it. A code deleted is kept, marked deleted (`deprecated`, OWL's), and shown
  as "a code no longer in the codebook" where it is used. It is kept even where no coding this device
  holds names it, as codings this device cannot read (in spaces it is not in) may. Codes under a
  deleted one move up. Codes caught in a loop (two devices each putting one under the other) are
  shown at the top of the tree, to be put right.
- **A coding** is an annotation in its maker's own file: `classifying`, its body the code
  (`SpecificResource`, `purpose: classifying`), its target a passage, found again as comments are.
- **In the app**: **Code** beside a selection (⌥⌘U), opening the **Codes** panel to find a code by
  name or make one and apply it; coded passages underlined in their codes' colours, a mark in the
  margin for each passage (saying its codes, the count where several), opening the codings there,
  yours to remove; the codebook as a tree with each code's count (`GET counts`), each to edit
  (name, meaning, colour, parent), merge or delete; **Retrieve** (from a code, or the ⋯ menu):
  every passage coded with a code, and those under it if asked (`GET retrieve`), across the
  documents this device holds, each opening at its passage.

Not yet: comments on a coding (a memo on it) in the interface, though the format has them;
dragging a selection onto a code.

