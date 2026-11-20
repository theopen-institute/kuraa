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
 * and goes back where it was afterwards (`previous`, if focus has moved already).
 */
export function trapFocus(root: HTMLElement, options: { onEscape?: () => void; initial?: HTMLElement | null; previous?: HTMLElement | null } = {}): () => void {
  const previous = options.previous !== undefined ? options.previous : (document.activeElement as HTMLElement | null);
  const entry: Entry = { root, onEscape: options.onEscape };
  if (!stack.length) {
    window.addEventListener('keydown', onKey);
  }
  stack.push(entry);
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  if (options.initial) options.initial.focus();
  else if (!root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus();
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
    if (previous?.isConnected && !elsewhere) previous.focus();
    else if (!previous?.isConnected && stack.length) (focusables(top()!.root)[0] ?? top()!.root).focus();
  };
}

/** Whether a modal dialog is open (keys meant for the page behind it wait). */
export const dialogOpen = (): boolean => stack.length > 0;
