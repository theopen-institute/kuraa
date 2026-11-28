# 0118 · Composition mode

**Status: built.** **Composition mode** (⌥⌘P, or the document's ⋯ menu) shows the page alone, full
screen where the platform allows: nothing but what is being written. As each person chooses:

- **typewriter scrolling**, the line being written staying at one height on the screen;
- the document's **words and target** at the foot of the page;
- the **other paragraphs faded**.

Escape leaves it, and so do the same keys again.

The owner, of what was next for parity with Scrivener: "yes, start composition mode. Make typewriter
scrolling a setting, along with displaying word count/target. Make this as a component if at all
possible. Does this need a new type of component?"

## What is decided

**A component, of the kind there already is** (`@kuraa/composition`, on by default). No new kind of
component was needed. It is made of what components already have:

- a **command** with keys (⌥⌘P; Scrivener's ⌥⌘F is taken here);
- an item in the **⋯ menu**;
- **editor plugins** (typewriter scrolling, the fading);
- a **panel**;
- **its settings in Settings › You.**

Its host half only names it. It keeps nothing in the workspace.

**Two things the core gives components, for this and after it** (`FEATURE_API_VERSION` stays 1: the
contract only grew):

- **The page alone** (`setPageAlone(on)`, `pageAlone()`, `onPageAlone(fn)`): the core hides all but
  the open document, since it draws them and a component cannot. Hidden:
  - navigation (the layout in use);
  - the panels beside and over the document;
  - history;
  - the ⋯ button (seen again when pointed at).

  Its warnings (offline, not saved, changes not kept) stay: they matter more than the quiet. It asks
  for full screen, and the editor takes the focus where it did not have it. It is left:
  - by asking again;
  - by Escape (where no menu or dialog takes it first; before the editor's own Escape);
  - by leaving full screen;
  - when no document is open.

  A component only asks. What is drawn stays the core's.
- **A place for panels at the page's foot** (`place: 'foot'`), which the panel contract had foreseen
  ("a bar below the document, say"). It is a quiet strip for a count or a status, open beside any
  other panel. With the page alone, it stays at the bottom of the screen. Components can close their
  panels too (`closePanel`).

**Typewriter scrolling** keeps the line being written at 45% of the page's height. It acts as the
document is written in or moved through with the keys, not while choosing with the pointer, where
the page would move under it. Room is made below the document's end, so its last lines can come up
to that height too.

**The fading** marks the editor as fading and the block being written as current; CSS fades the
rest. Only those two change as the cursor moves. Marking every block instead made the editor draw
them all again, and the selection was lost.

Before drawing again (turned on, a setting changed), the editor reads the selection the browser has
just changed, for a click or a key that came a moment before. Otherwise drawing put back where the
cursor had been. That read is prosemirror-view's DOM observer's `flush`; it is not public, so it is
used only if it is there.

**The count** is the document's words, counted as Words counts them, and its target where its header
has one (`target-words`, 0094): *2,406 of 3,000 words · 80%*. `liveWords` and `targetOf` moved from
Words into the kernel, so words are counted one way everywhere (0094).

**Each person's settings**, kept in their browser as Words keeps a day's target:
- Typewriter scrolling: on by default;
- Word count and target: on by default;
- Fade the other paragraphs: off by default.

They are in Settings › Components, under its row (**Composition mode ›**).

### Not yet

- Its own background and page width, as Scrivener's composition mode has.
- Typewriter scrolling outside composition mode.
- The page alone for a past version or a source view.
