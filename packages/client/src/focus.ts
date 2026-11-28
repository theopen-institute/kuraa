// Modal dialogs and focus, in plain DOM so the Vue dialogs (useDialog in vue.ts)
// and the plain-DOM questions (ask.ts) share one stack: only the dialog on top
// takes Tab and Escape. A dialog keeps Tab inside itself, closes on Escape, and
// gives focus back to where it was when it closes.

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'summary', 'iframe', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

/** The elements Tab reaches inside `root`, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
}

/** Where focus is, to give it back later: the element, and the caret in it when it is text being edited. */
export interface FocusPlace { el: HTMLElement | null; caret: Range | null }

export function focusPlace(): FocusPlace {
  const el = document.activeElement as HTMLElement | null;
  const sel = window.getSelection();
  const caret = el?.isContentEditable && sel?.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  return { el, caret };
}

/**
 * Focus back where it was, with the caret where it was in text being edited.
 * Focusing an editable element puts the caret at its start in Firefox, and the
 * editor (ProseMirror) takes that as the person's move: what they typed next, or
 * an image just added, would go at the top of the document.
 */
export function focusBack(place: FocusPlace): void {
  place.el?.focus();
  const { caret } = place;
  if (!caret || !caret.startContainer.isConnected || !caret.endContainer.isConnected || document.activeElement !== place.el) return;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(caret);
}

interface Entry { root: HTMLElement; onEscape?: () => void }
const stack: Entry[] = [];

const top = () => stack[stack.length - 1];

function onKey(e: KeyboardEvent) {
  const t = top();
  if (!t) return;
  if (e.key === 'Escape' && t.onEscape) {
    // Something inside answered it already (a menu open in the dialog, a field's own Escape).
    if (e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    t.onEscape();
  } else if (e.key === 'Tab') {
    const items = focusables(t.root);
    if (!items.length) {
      e.preventDefault();
      t.root.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && t.root.contains(active);
    if (e.shiftKey && (!inside || active === first || active === t.root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * Make `root` a modal dialog until the returned function is called: Tab stays
 * inside it, Escape calls `onEscape` (if given), focus moves into it (to
 * `initial`, or what already has it inside, or the first thing that takes it),
 * and goes back where it was afterwards (`previous`, if focus has moved already),
 * with the caret where it was (focusBack).
 */
export function trapFocus(root: HTMLElement, options: { onEscape?: () => void; initial?: HTMLElement | null; previous?: FocusPlace } = {}): () => void {
  const place = options.previous ?? focusPlace();
  const previous = place.el;
  const entry: Entry = { root, onEscape: options.onEscape };
  if (!stack.length) {
    window.addEventListener('keydown', onKey);
  }
  stack.push(entry);
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  if (options.initial) options.initial.focus();
  else if (!root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus();
  // A selection left in the text behind: WebKit types into it even with a button in here focused.
  // (The caret is in `place`, to put back.)
  const sel = window.getSelection();
  if (sel?.rangeCount && !root.contains(sel.anchorNode)) sel.removeAllRanges();
  return () => {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    if (!stack.length) {
      window.removeEventListener('keydown', onKey);
    }
    // Back where it was, unless that is gone, or focus has moved on into another dialog meanwhile.
    const now = document.activeElement;
    const elsewhere = now && now !== document.body && !root.contains(now);
    if (previous?.isConnected && !elsewhere) focusBack(place);
    else if (!previous?.isConnected && stack.length) (focusables(top()!.root)[0] ?? top()!.root).focus();
  };
}

/** Whether a modal dialog is open (keys meant for the page behind it wait). */
export const dialogOpen = (): boolean => stack.length > 0;
