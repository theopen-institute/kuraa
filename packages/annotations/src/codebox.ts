// Coding by typing (docs/decisions/0082-annotations.md, "Coding by #"): the box
// typing # opens, at the selection or the caret, to name a code; and the small
// menu a code's tag in the margin opens. Drawn with the DOM alone, beside the
// text, above everything else.
//
// The box: what is typed finds codes by name (those starting with it first);
// Enter applies the code named exactly, or makes a new one of that name and
// applies it; ↑↓ choose one of the codes found, Tab completes the name to it.
// Esc, Backspace in an empty box, or a click elsewhere close it; at the caret,
// Esc or a space in an empty box type what was typed as text (`#`, `# `), so
// # is still typed as it always was, a heading's say.
import type { Code } from './codebook.js';

/** Where on screen, as a range's or an element's box. */
export interface ScreenBox {
  left: number;
  top: number;
  bottom: number;
}

/** A code to suggest, with where it is in the codebook's tree (its parents' names). */
export interface Suggestion {
  code: Code;
  parents: string[];
}

export interface CodeBoxOptions {
  at: ScreenBox;
  /** The codes there are, in the codebook's order. */
  codes(): Suggestion[];
  /** At a point in the text (the caret), not a passage. */
  point: boolean;
  /** A code chosen: one there is, or a new one by its name. */
  choose(choice: { id: string } | { label: string }): void;
  /** Closed with no code: what to type in its place, if anything (at the caret: what was typed after #, as text). */
  cancel(typed: string): void;
}

const MAX = 7;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Put a box at a place on screen: below it, or above where there is no room below. */
function place(box: HTMLElement, at: ScreenBox) {
  box.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - box.offsetWidth - 8))}px`;
  const below = at.bottom + 4;
  box.style.top = below + box.offsetHeight > window.innerHeight - 8 && at.top - box.offsetHeight - 4 > 8 ? `${at.top - box.offsetHeight - 4}px` : `${below}px`;
}

/** The codes found by what is typed: its exact name first, then those starting with it, then those with it anywhere. */
export function findCodes(all: Suggestion[], typed: string): Suggestion[] {
  const wanted = typed.trim().toLowerCase();
  if (!wanted) return all.slice(0, MAX);
  const rank = (s: Suggestion) => {
    const l = s.code.label.toLowerCase();
    return l === wanted ? 0 : l.startsWith(wanted) ? 1 : l.split(/[\s/-]+/).some((w) => w.startsWith(wanted)) ? 2 : l.includes(wanted) ? 3 : 4;
  };
  return all.map((s, i) => ({ s, r: rank(s), i })).filter((x) => x.r < 4).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, MAX).map((x) => x.s);
}

/** Open the box. Returns how to close it (with nothing chosen, nothing typed). */
export function openCodeBox(o: CodeBoxOptions): () => void {
  const box = el('div', 'kuraa-codebox');
  box.dataset.testid = 'codebox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', o.point ? 'Code this point' : 'Code the passage selected');
  const row = el('div', 'kuraa-codebox-input');
  const hash = el('span', 'kuraa-codebox-hash', '#');
  const input = el('input');
  input.dataset.testid = 'codebox-input';
  input.setAttribute('aria-autocomplete', 'list');
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = 'Name a code';
  row.append(hash, input);
  const list = el('div', 'kuraa-codebox-list');
  list.setAttribute('role', 'listbox');
  const hint = el('div', 'kuraa-codebox-hint');
  box.append(row, list, hint);

  let done = false;
  /** The row chosen with ↑↓ (or by default: the code named exactly, else a new one), by its index in `rows`. */
  let selected = -1;
  let moved = false;
  type Row = { kind: 'code'; s: Suggestion } | { kind: 'new'; label: string };
  let rows: Row[] = [];

  const finish = (then: () => void) => {
    if (done) return;
    done = true;
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    box.remove();
    then();
  };
  const choose = (r: Row | undefined) => {
    if (!r) return;
    finish(() => o.choose(r.kind === 'code' ? { id: r.s.code.id } : { label: r.label }));
  };
  const cancel = (typed: string) => finish(() => o.cancel(typed));

  function draw() {
    const typed = input.value.trim();
    const found = findCodes(o.codes(), typed);
    const exact = found.findIndex((s) => s.code.label.toLowerCase() === typed.toLowerCase());
    rows = found.map((s) => ({ kind: 'code' as const, s }));
    if (typed && exact < 0) rows.push({ kind: 'new', label: typed });
    if (!moved || selected >= rows.length) selected = exact >= 0 ? exact : typed ? rows.length - 1 : -1;
    list.replaceChildren();
    rows.forEach((r, i) => {
      const item = el('div', `kuraa-codebox-row${i === selected ? ' selected' : ''}${r.kind === 'new' ? ' new' : ''}`);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === selected));
      item.dataset.testid = r.kind === 'new' ? 'codebox-new' : 'codebox-code';
      if (r.kind === 'code') {
        const sw = el('span', 'kuraa-swatch');
        sw.style.background = r.s.code.color ?? '#888';
        item.append(sw, el('span', 'kuraa-codebox-label', r.s.code.label));
        if (r.s.parents.length) item.append(el('span', 'kuraa-codebox-parents', r.s.parents.join(' › ')));
      } else item.append(el('span', 'kuraa-codebox-plus', '+'), el('span', 'kuraa-codebox-label', `New code “${r.label}”`));
      // Chosen with the mouse: before the input loses the focus (which would close the box).
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(r);
      });
      list.append(item);
    });
    if (!rows.length) list.append(el('div', 'kuraa-codebox-empty', 'No codes yet: type a name, then Enter.'));
    const now = rows[selected];
    hint.textContent = [
      now ? (now.kind === 'new' ? '↵ new code' : `↵ apply “${now.s.code.label}”`) : '',
      rows.some((r) => r.kind === 'code') ? 'Tab completes · ↑↓' : '',
      o.point && !input.value ? 'Space or Esc types #' : 'Esc',
    ].filter(Boolean).join(' · ');
  }

  input.addEventListener('input', () => {
    moved = false;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[selected]);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      moved = true;
      selected = selected < 0 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : (selected + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      draw();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const to = rows[selected]?.kind === 'code' ? rows[selected] : rows.find((r) => r.kind === 'code');
      if (to?.kind !== 'code') return;
      input.value = to.s.code.label;
      moved = false;
      draw();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel(o.point ? `#${input.value}` : '');
    } else if (e.key === ' ' && o.point && !input.value) {
      e.preventDefault();
      cancel('# ');
    } else if (e.key === 'Backspace' && !input.value) {
      e.preventDefault();
      cancel('');
    }
  });
  input.addEventListener('blur', () => cancel(''));
  const onScroll = (e: Event) => {
    if (e.target instanceof globalThis.Node && box.contains(e.target)) return;
    cancel('');
  };

  document.body.append(box);
  draw();
  place(box, o.at);
  input.focus();
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  return () => cancel('');
}

export interface MenuItem {
  label: string;
  run(): void;
  testid?: string;
  danger?: boolean;
}

/** A small menu beside an element (a tag in the margin): a heading, lines about it, and what can be done. Returns how to close it. */
export function openMenu(at: HTMLElement, o: { title: string; color?: string; lines: string[]; items: MenuItem[] }): () => void {
  const box = el('div', 'kuraa-codebox kuraa-codemenu');
  box.dataset.testid = 'code-menu';
  box.setAttribute('role', 'menu');
  box.tabIndex = -1;
  const head = el('div', 'kuraa-codemenu-title');
  const sw = el('span', 'kuraa-swatch');
  sw.style.background = o.color ?? '#888';
  head.append(sw, el('span', '', o.title));
  box.append(head);
  for (const l of o.lines) box.append(el('div', 'kuraa-codemenu-line', l));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
  };
  for (const i of o.items) {
    const b = el('button', `kuraa-codemenu-item${i.danger ? ' danger' : ''}`, i.label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (i.testid) b.dataset.testid = i.testid;
    b.addEventListener('click', () => {
      close();
      i.run();
    });
    box.append(b);
  }
  const outside = (e: MouseEvent) => {
    if (!(e.target instanceof globalThis.Node) || (!box.contains(e.target) && !at.contains(e.target))) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.body.append(box);
  const r = at.getBoundingClientRect();
  // Beside the tag, toward the text, as it sits at the window's right.
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${r.bottom + 4 + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - box.offsetHeight - 4) : r.bottom + 4}px`;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey, true);
  return close;
}
