# 0129 · Inline comments: a discussion in the text, after its block

The owner asked for a new kind of annotation, **inline comments**: a threaded conversation shown
after the block it is about, so that a discussion between several people can be read in the body of
the text itself, and visually distinct from that text.

Comments so far ([0082](0082-annotations.md)) are read from a 💬 in the margin, which opens the
thread in a card below the passage, one at a time, or all at once in the Comments panel: the
discussion is beside the text, never in it. An inline comment is the same comment, drawn in the
text, every thread open at once where it belongs.

## In the file: a comment whose target says it is inline

An inline comment is a W3C comment (`commenting`), kept in its maker's own file beside the document
as any comment is ([0082](0082-annotations.md), *Who owns an annotation*), its replies `replying`
annotations as before. What marks it is its target's **`styleClass`**, `inline-comment`:

```json
{"id": "urn:uuid:…", "type": "Annotation", "motivation": "commenting", …,
 "body": {"type": "TextualBody", "value": "Which council: the old one or the new?", "format": "text/markdown", "purpose": "commenting"},
 "target": {"source": "../p01.md", "styleClass": "inline-comment", "selector": [{"type": "TextQuoteSelector", …}, {"type": "TextPositionSelector", …}]}}
```

`styleClass` is the W3C model's own word for how a target is to be shown, so nothing is invented
outside the standard. Not a motivation of its own: the model allows one (a SKOS concept narrower
than `commenting`, at an IRI of ours), but an annotation of a motivation a reader does not know is
shown by nobody (Kuraa until now keeps such annotations and shows none of them). As a comment with a
class, an inline comment is read by other tools, and by earlier versions of Kuraa still in a
workspace, as the comment it is, on its passage, with its replies: they show it in the margin, and
replies written there join the same thread.

- **Its passage** is what was selected, or, with nothing selected, the block the caret is in (a
  paragraph, a heading, an item's paragraph) as a whole; an empty block, a point at it (as a code at
  the caret is, [0082](0082-annotations.md) *Coding by #*). It is anchored, found again and kept when
  no longer found as every passage is.
- **The host keeps what the target says.** Writing a person's file from the room names each
  passage anew (`source` and `selector`); it now keeps the rest of the target as it was, the class
  among it. Before, the target was rebuilt from those two alone.

## In the app

- **Begun** with **Inline comment** (⌥⇧⌘M, the ⋯ menu), on what is selected or on the block the
  caret is in, or with **Inline** beside a selection. A box opens in the text, just after the block,
  the passage shown meanwhile: Enter saves the first message, Shift+Enter is a new line, Esc gives it
  up. What is typed goes to the box at once: the box is drawn and focused as it opens, so the next
  keys never replace what was selected.
- **The thread is in the text**, after its passage's block (after a table as a whole, never in a
  cell): a ProseMirror widget, not part of the document, so it is never in the file, never copied
  with the text, and the text around it is typed in as before. Several in one block follow each
  other in the order of their passages.
- **A conversation**: each message with who wrote it, a round mark with their initial and a colour
  of their own (from their identity, so mostly the same for them everywhere; no two alike in one
  thread), when, and whether it was edited; your own to edit or delete (beside who and when, as the
  message is pointed at); a box at its foot to reply in, Enter sending. Its head says how many
  messages and whose, and **Fold** puts it away to that one line (**Show** brings it back): a
  convenience of the reader's, kept in this browser. The passage is quoted at its top where it is not
  its block as a whole. Others' replies are shown as they are written (live while a device of theirs
  is in the room, else from their files).
- **Set apart from the text**: the interface's sans-serif face, smaller, on a tint of the accent
  colour with a rail of it down its left side, in a box: never read as the document's serif prose.
  Its passage is highlighted only while the thread is pointed at or written in, so the text itself
  stays clean.
- **No 💬 in the margin** for an inline comment (its thread is in the text), and its card does not
  open. The Comments panel lists it with the rest, said to be inline.
- **Read only**, or a past version: the threads are shown, without boxes to write in.
- **Comments off** for the workspace: no threads are shown, nothing is offered; what was made is
  kept.

## Not decided here

Turning a margin comment into an inline one or back; resolving a thread; an inline comment on the
document as a whole.
