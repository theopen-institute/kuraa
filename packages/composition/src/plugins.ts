// Composition mode's part of the editor (0120): typewriter scrolling, and the
// paragraphs but the one being written faded. Each acts only while composition
// mode is on and its setting is (`active`); told when either changes
// (`refresh`), each open editor draws itself again.
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

/** Where the line being written is kept: this far down the window. */
const HEIGHT = 0.45;

const views = new Set<EditorView>();
/** The editors typewriter scrolling is in, and whether it acts there now. */
const typing = new Map<EditorView, () => boolean>();
const REFRESH = new PluginKey('composition-refresh');

/** Composition mode or a setting changed: each open editor draws itself again (its decorations), the line being written put in its place. */
export function refresh(): void {
  for (const v of views) {
    if (v.isDestroyed) continue;
    // What the browser has just done (a click, a key) read first: drawing again would put back a selection the
    // editor has not yet read. (prosemirror-view's DOM observer: not public, so asked for if it is there.)
    try {
      (v as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
    } catch {
      // As it is.
    }
    v.dispatch(v.state.tr.setMeta(REFRESH, true));
  }
  requestAnimationFrame(() => {
    for (const [v, active] of typing) if (!v.isDestroyed && active()) centre(v);
  });
}

/** What scrolls the page (the editor's scroll container). */
const scrollerOf = (view: EditorView): HTMLElement | null => view.dom.closest('.editor-scroll');

/** The line being written, at HEIGHT of what the page shows. */
export function centre(view: EditorView): void {
  const scroller = scrollerOf(view);
  if (!scroller) return;
  let top: number;
  try {
    top = view.coordsAtPos(view.state.selection.head).top;
  } catch {
    return;
  }
  const box = scroller.getBoundingClientRect();
  const by = top - (box.top + box.height * HEIGHT);
  if (Math.abs(by) > 1) scroller.scrollTop += by;
}

/**
 * Typewriter scrolling: as you type or move with the keys, the line you are on
 * stays at one height; room is made below the end, so the last lines can come
 * up to it. Not while choosing with the pointer (the page would move under it).
 */
export function typewriter(active: () => boolean): Plugin {
  return new Plugin({
    props: {
      attributes: (): Record<string, string> => (active() ? { class: 'composition-typewriter' } : {}),
    },
    view(view) {
      views.add(view);
      typing.set(view, active);
      let pointing = false;
      const down = () => (pointing = true);
      const up = () => (pointing = false);
      view.dom.addEventListener('mousedown', down);
      window.addEventListener('mouseup', up);
      return {
        update(v, prev) {
          if (!active() || pointing) return;
          // As it is written in or moved through (turned on: refresh puts it in place).
          if (v.state.doc !== prev.doc || !v.state.selection.eq(prev.selection)) requestAnimationFrame(() => !v.isDestroyed && active() && centre(v));
        },
        destroy() {
          views.delete(view);
          typing.delete(view);
          view.dom.removeEventListener('mousedown', down);
          window.removeEventListener('mouseup', up);
        },
      };
    },
  });
}

/** The top-level block the cursor is in, marked (the rest fade: CSS, while the editor is marked fading). */
export function currentBlock(state: EditorState): DecorationSet {
  const head = state.selection.head;
  let found: Decoration | null = null;
  state.doc.forEach((node, pos) => {
    if (!found && head >= pos && head <= pos + node.nodeSize) found = Decoration.node(pos, pos + node.nodeSize, { class: 'composition-current' });
  });
  return found ? DecorationSet.create(state.doc, [found]) : DecorationSet.empty;
}

/**
 * The paragraphs (and headings, lists…) but the one being written, faded: the
 * editor marked as fading and the block being written marked as current, the
 * rest faded by CSS, so only those two change as the cursor moves (marking
 * every block would draw them all again, losing where the cursor is).
 */
export function fade(active: () => boolean): Plugin {
  return new Plugin({
    view(view) {
      views.add(view);
      return { destroy: () => views.delete(view) };
    },
    props: {
      attributes: (): Record<string, string> => (active() ? { class: 'composition-fading' } : {}),
      decorations: (state) => (active() ? currentBlock(state) : null),
    },
  });
}
