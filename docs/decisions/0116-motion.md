# 0116 · Motion, where you caused a change

**Status: built.** The design is meant to be clean and clear, with as little on screen as possible.
The owner asked whether a few subtle animations would help you see what changed: rows moving when a
file is dragged to a new place in the sidebar, and the panel on the right opening. Each had to be
subtle and unobtrusive, with no cost to performance. This record says which two animations there are
and the rules that keep motion from spreading further.

## The rules

- **Only for a change you caused, so you can see what it did.** Nothing moves on hover, on folding
  or opening a folder, while loading, or when someone else's change arrives.
- **160ms or less, easing out** (`cubic-bezier(0.2, 0, 0, 1)`): over before you would wait on it.
- **Only `transform` and `opacity`**, so nothing is laid out again while it moves.
- **None where motion is reduced** (the system's *Reduce motion*, `prefers-reduced-motion`): the
  change happens at once, as before.

## Rows moved in the file tree glide to their places

When you move a row, by dropping it or with Alt+↑ / Alt+↓, each row whose place changed glides there
from where it was. That includes the moved row itself, also when it went into another folder (by its
new path). Rows whose place did not change stay still. `FilesView.vue` measures the rows in sight
just before the move and again once the tree is drawn with it. That is after the core says the tree
changed, which it does at once, since a move is shown before it is saved
([0093](0093-order-and-compile-over-folders.md)). Each row is then animated from its old offset with
the Web Animations API. For a folder, only its own line moves, since the rows inside it are animated
separately.

Rows do not move aside to open a gap while you drag. A row moving under the pointer changes what is
under the pointer, so the gap would jump back and forth. The line showing where the row will land
says it already.

This is not Vue's `<TransitionGroup>`, which measures every row each time a folder is drawn again
(selection, marks, sync). Here the rows are measured twice per move and at no other time.

## A pane beside the document comes in from the right

When a side panel or History opens, its pane fades in from 12px to the right (`.pane-right`,
`@keyframes pane-in`, in the client's `style.css`). The column itself is not animated: the document
narrows at once and wraps its text once, rather than on every frame. That would cost a layout for
each frame and make the text slide around as it wrapped. Closing is instant. A pane closing is
something you just did, and animating it would leave it lingering in a column that is already gone.
The panes are clipped at the sides (`overflow-x: clip`, which are the window's sides), so the pane
coming in never widens the page.

## Tests

The browser tests run with motion reduced (`reducedMotion: 'reduce'` in `playwright.config.ts`), so
none of them waits on an animation. `motion.spec.ts` turns motion back on. It checks that Alt+↓
animates the two rows that changed places and not the third, that nothing is animated where motion
is reduced, and that the Export panel comes in.
