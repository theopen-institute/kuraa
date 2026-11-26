// Comments where the text is (docs/decisions/0082-annotations.md, "Comments
// where the text is"): a card that opens just below a passage, to write a
// comment on it, or to read its thread, reply, and edit or delete your own.
// Drawn with the DOM alone, beside the text, above everything else; it follows
// its passage as the document scrolls.
//
// A click elsewhere closes it, unless something is typed in it and not yet
// saved (that stays until saved, or Esc). Esc closes it, wherever the focus is. Enter saves,
// Shift+Enter is a new line.
import { place, type ScreenBox } from './codebox.js';

export interface CardOptions {
  testid: string;
  /** What it is, said to a screen reader. */
  label: string;
  /** Where its passage is on screen now (it opens below it), or null where it cannot be said (it stays where it was). */
  at(): ScreenBox | null;
  /** Its contents: drawn into it, and again whenever asked. */
  draw(card: HTMLElement): void;
  /** Whether something typed in it is not yet saved: a click elsewhere then leaves it open. */
  holding(): boolean;
  /** What opened it (a mark in the margin): a click there is not a click elsewhere (it opens or closes it itself). */
  owner?(): Element | null;
  /** Closed: by a click elsewhere (`away`), by Esc (`escape`), or by what it did (`done`). */
  closed(how: Closing): void;
}

export type Closing = 'away' | 'escape' | 'done';

export interface Card {
  close(how?: Closing): void;
  /** Draw its contents again (what it shows changed), keeping the focus in the box it was in. */
  redraw(): void;
  /** Put it again below its passage (the text moved). */
  move(): void;
  element: HTMLElement;
}

/** Open a card. */
export function openCard(o: CardOptions): Card {
  const card = document.createElement('div');
  card.className = 'kuraa-codebox kuraa-card';
  card.dataset.testid = o.testid;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', o.label);
  card.tabIndex = -1;
  let closed = false;
  const close = (how: Closing = 'done') => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('scroll', follow, true);
    window.removeEventListener('resize', follow);
    card.remove();
    o.closed(how);
  };
  const follow = (e?: Event) => {
    if (e?.target instanceof globalThis.Node && card.contains(e.target)) return;
    const at = o.at();
    if (at) place(card, at);
  };
  const outside = (e: MouseEvent) => {
    if (e.target instanceof globalThis.Node && (card.contains(e.target) || o.owner?.()?.contains(e.target))) return;
    if (!o.holding()) close('away');
  };
  // Esc elsewhere (the text clicked into, something typed held in it): closed too, the focus left where it is.
  const escape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !(e.target instanceof globalThis.Node && card.contains(e.target))) close('away');
  };
  card.addEventListener('keydown', (e) => {
    // Its keys are its own (not the editor's, not the app's).
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close('escape');
    }
  });
  const redraw = () => {
    if (closed) return;
    // The focus kept in it: in the box it was in, or (that gone: an edit saved, say) the one it opens with.
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && card.contains(active);
    const had = inside && active instanceof HTMLTextAreaElement ? active.dataset.testid : null;
    card.replaceChildren();
    o.draw(card);
    follow();
    if (inside) {
      const box = (had && card.querySelector<HTMLTextAreaElement>(`textarea[data-testid="${had}"]`)) || card.querySelector<HTMLTextAreaElement>('textarea[data-autofocus]');
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      } else card.focus();
    }
  };
  document.body.append(card);
  o.draw(card);
  follow();
  card.querySelector<HTMLTextAreaElement>('textarea[data-autofocus]')?.focus();
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', escape, true);
  window.addEventListener('scroll', follow, true);
  window.addEventListener('resize', follow);
  return { close, redraw, move: () => follow(), element: card };
}

export interface ComposerOptions {
  testid: string;
  placeholder: string;
  /** What it starts with (a draft kept, or what is being edited). */
  initial?: string;
  /** Its button's name. */
  action: string;
  /** Focused as it opens. */
  autofocus?: boolean;
  /** What is typed, as it is typed (to keep a draft). */
  input?(text: string): void;
  save(text: string): void;
  cancel?(): void;
}

/** A box to write in, growing as it is written in: Enter saves, Shift+Enter is a new line. */
export function composer(o: ComposerOptions): HTMLElement {
  const box = document.createElement('textarea');
  box.dataset.testid = o.testid;
  if (o.autofocus) box.dataset.autofocus = '';
  box.placeholder = o.placeholder;
  box.rows = 1;
  box.value = o.initial ?? '';
  const grow = () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight + 2, 220)}px`;
  };
  const go = () => {
    const text = box.value.trim();
    if (text) o.save(text);
  };
  box.addEventListener('input', () => {
    grow();
    o.input?.(box.value);
    send.disabled = !box.value.trim();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      go();
    }
  });
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'kuraa-card-send';
  send.textContent = o.action;
  send.dataset.testid = `${o.testid}-save`;
  send.disabled = !box.value.trim();
  send.addEventListener('click', go);
  const row = document.createElement('div');
  row.className = 'kuraa-card-actions';
  const hint = document.createElement('span');
  hint.className = 'kuraa-card-hint';
  hint.textContent = '↵ to save · ⇧↵ new line';
  row.append(hint);
  if (o.cancel) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'kuraa-card-link';
    cancel.textContent = 'Cancel';
    cancel.dataset.testid = `${o.testid}-cancel`;
    cancel.addEventListener('click', () => o.cancel!());
    row.append(cancel);
  }
  row.append(send);
  const wrap = document.createElement('div');
  wrap.className = 'kuraa-card-composer';
  wrap.append(box, row);
  queueMicrotask(grow);
  return wrap;
}
