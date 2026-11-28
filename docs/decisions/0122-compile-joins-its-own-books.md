# 0122 · Compile joins its own books

The fourth step of the review of the core ([0119](0119-what-a-document-is-its-type-says.md) to
[0121](0121-word-counts-read-the-history-themselves.md)). Compile's panel and settings were a
component (`@kuraa/compile`), but a folder's book was put together by the host. That was
`compile.ts`, `host.compileFolder`, `host.bookContents` and `/api/renders/contents`. The book's
request (`CompileRequest`) and outline (`BookContent`) were types of the feature contract, and
`RenderService.bookContents` a service of the core's. 0093 had called this "the core's render of
a folder".

## What moved

- **Joining a folder's documents is Compile's.** Its host half reads the workspace through the
  contract (`list`, `typeOf`, `live`, `read`, `belongsTo`), puts the book together
  (`compiling.ts`, with `book.ts`, the host's `compile.ts` as it was), and hands it to the core.
- **The core still renders a folder.** A path ending in `/` is rendered as before: one render at
  a time, outputs kept in `.git/kuraa/renders`, Preview's frame, saving. For its text, the core
  asks the first feature on that has the new **`FeatureSession.compileFolder(folder, request,
  format)`**. That returns a **`CompiledFolder`**: the text, the workspace folders where what it
  refers to is found, and workspace files to put beside it by name (a Word template, a cover).
  The host checks those paths (inside the workspace, no links, files that are there) before the
  renderer sees them. Where no feature compiles folders, a folder's render fails and says
  Compile is off.
- **The request is Compile's to say.** The client sends it as `compile` in the render's body,
  opaque JSON (`RenderService.render(path, format, compile?: Json)`), and Compile checks it, as
  the host's route did. `CompileRequest` and `BookContent` are now `@kuraa/compile`'s own.
- **The outline is Compile's own route**: `GET /api/features/compile/contents?folder=`, in place
  of `/api/renders/contents` and `RenderService.bookContents`.
- **The order file is in the contract.** `.kuraa-order` (`ORDER_FILE`, `orderedFolder`,
  `orderFileOf`, `parseOrder`), which 0093 keeps the core's because it is the files', is now in
  `@kuraa/feature-kit`, so components read it as the host does. The host still writes it.

## What changed for people

- **A book takes each document as it is now** (its open room's text) without first writing it to
  its file and committing it. The host used to do that for each document in turn before joining
  them. A book records no "made from" ([0081](0081-what-outputs-were-made-from.md)), so the
  commits only added saves to the history.
- **A book's outline counts a document's words as it is now**, not as last saved.
- **The top level's default title**, when the panel sends none, is "Book". It was "book" before.
  The panel always sends one.

`FEATURE_API_VERSION` stays 2, the same change on this branch as 0120.
