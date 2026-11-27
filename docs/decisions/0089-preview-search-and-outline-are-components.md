# 0089 · Preview, Search and the Outline are components

*Since [0091](0091-the-feature-runtime-commands-and-places.md): `over: true` is `place: 'over'`; the host's calls are services by name (`host.search.run`, `host.renders.info`, …) given as a feature says it `uses` them; the panels' keys are commands, listed on the sheet from them.*

The owner, reading the list of panels beside and over the document:

> "For now, the editor and history windows can stay part of core."
>
> "Move Preview, Search, and Outline to components, then go ahead with everything else."

**Each is a feature of its own** (0082's kind of component), on by default
([0087](0087-navigation-is-made-of-components.md)), drawn through the panel hook features already
have, and looking and working as before:

- **`@kuraa/preview`**: the Preview panel (⇧⌘R, and **Preview** in the document's ⋯ menu), about the
  open document. Rendering itself stays the host's ([0041](0041-rendering.md)): the panel asks the
  host's render routes, as it did, through the context.
- **`@kuraa/search`**: the Search panel (⇧⌘F, and its button where navigation is), about the
  workspace. Searching stays the host's ([0042](0042-search.md)); opening a match at its place stays
  the core's.
- **`@kuraa/outline`**: the Outline (⌥⌘O, and **Outline** in the ⋯ menu), over the document's top
  left as it was, over the rich view only.

The core keeps the editor, History, the document's ⋯ menu and the place beside the document where one
panel at a time is shown (Preview, Search and the features' panels take turns there, as before).

## What the panel hook gains

- **`over: true`**: a document's panel drawn over the document's top left, in an element of its
  own, not beside it, and not taking the place beside it: the Outline stays open while Preview is.
  The panel draws all of itself (no heading of the client's). It is shown over the rich view only.
- **`toggle: false`**: its keys open it, and asked for again while open, ask it again rather than
  close it (⇧⌘R renders again; ⇧⌘F puts the cursor back in the field). Told through `onAsk`, which
  is also called once as it opens by being asked for.
- **`icon`**: drawn as a file's icon is ([0023](0023-file-icons.md)); a workspace's panel with one
  is offered as a button where navigation is (Search's, beside ＋).
- **The open document's state** (`document()`: its path, when it was last written to its file, how
  many edits have not reached the host), for Preview's *Update when saved* and its waiting for edits
  to arrive before rendering.
- **The host's own calls** that a panel needs (`host`): searching; a document's renders, rendering
  it, its outputs and what they were made from; tools and downloading one; and being told when tools
  change. These are the core's routes, not the feature's: a component asks the host through the
  core, as before.
- **`openMatch(path, target)`**: open a file at a match (a line, where on it, and the words), found
  again in an open document as it has been typed since.
- **`explain(error)`** and **`keyLabel(keys)`**: an error in plain words with its details, and keys
  as this system shows them, as the core says them everywhere else.

What each said is moved with it: its strings, its lines on the Markdown and shortcuts sheet (under
**Finding your way**, as before), its test ids. A panel's package may use Vue inside it, mounting an
app of its own ([0016](0016-vue-client.md)); the contract stays free of any framework.
