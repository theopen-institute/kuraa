// Inline comments (docs/decisions/0129-inline-comments.md): a comment's thread
// shown in the text itself, after its passage's block, as a conversation
// everyone reading the document sees there: each message with who wrote it (a
// colour of their own, the same wherever they write), when, and a box to reply
// in at its foot. Set apart from the text it sits in: another face, smaller,
// on a tint of its own with a rail down its side, never taken for the document.
//
// Drawn with the DOM alone. One element per thread, kept while the thread is
// (the editor's widget gives the same element back each time it draws), and
// drawn again only where what it shows changed, the focus and what is typed
// kept, so a reply arriving does not take a reply being written away.
import { composer } from './commentbox.js';

export interface Message {
  id: string;
  person: string;
  /** Their name ('You' for yours). */
  who: string;
  mine: boolean;
  /** When, as shown. */
  when: string;
  edited: boolean;
  text: string;
}

export interface Thread {
  /** The passage, where it is not its block as a whole (that is shown just above it); null for none. */
  quote: string | null;
  /** The comment, then its replies, in the order written. None: one being begun. */
  messages: Message[];
  /** Whether you may write here (your annotations are kept here). */
  canWrite: boolean;
}

export interface ThreadOptions {
  /** The comment's id ('new' for one being begun). */
  id: string;
  /** What it shows now: null where it is gone. */
  model(): Thread | null;
  /** Drafts of what is typed, by box, kept as it is drawn again. */
  drafts: Map<string, string>;
  /** Write: the first message of one begun, or a reply. */
  send(text: string): void;
  edit(id: string, text: string): void;
  remove(id: string): void;
  /** One being begun, given up. */
  cancel?(): void;
  /** Pointed at, or written in, and then not: to show its passage in the text. */
  hover(on: boolean): void;
  /** Back to the text (Esc). */
  leave(): void;
}

export interface ThreadView {
  element: HTMLElement;
  /** Draw it again where what it shows changed. */
  update(): void;
  /** Put the focus in its box to reply in (or to write the first message). */
  focus(): void;
}

// Folded threads: a convenience of the reader's, in this browser.
const FOLDED_KEY = 'kuraa:inline-folded';
const loadFolded = (): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const saveFolded = (ids: Set<string>) => {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...ids].slice(-500)));
  } catch { /* for this page only */ }
};

/** Hues far enough apart to tell people by. */
const HUES = 10;
const slotOf = (person: string) => {
  let h = 2166136261;
  for (let i = 0; i < person.length; i++) h = Math.imul(h ^ person.charCodeAt(i), 16777619);
  return (h >>> 0) % HUES;
};

/**
 * People's colours in a thread (their hues), in the order they first wrote: each their own, from their identity, so
 * mostly the same for them in every thread; where two would share one, the later takes the next one free.
 */
export function huesFor(people: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const p of people) {
    if (out.has(p)) continue;
    let slot = slotOf(p);
    for (let i = 0; i < HUES && used.has(slot); i++) slot = (slot + 1) % HUES;
    used.add(slot);
    out.set(p, 12 + slot * (360 / HUES));
  }
  return out;
}

const initial = (name: string) => [...(name.trim() || '?')][0]!.toUpperCase();

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, testid?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (testid) e.dataset.testid = testid;
  return e;
};
const link = (label: string, run: () => void, testid: string, cls = 'kuraa-card-link') => {
  const b = make('button', cls, label, testid);
  b.type = 'button';
  b.addEventListener('click', run);
  return b;
};

/** A thread, in the text. */
export function threadView(o: ThreadOptions): ThreadView {
  const root = make('aside', 'kuraa-inline', undefined, o.id === 'new' ? 'inline-new' : 'inline-thread');
  root.contentEditable = 'false';
  root.dataset.annotation = o.id;
  root.setAttribute('role', 'group');
  let editing: string | null = null;
  let shownAs = '';
  const draft = (k: string) => `inline:${o.id}:${k}`;

  // Its keys are its own: not the editor's, not the app's. Esc: out of an edit, else back to the text.
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (editing) {
      o.drafts.delete(draft(`edit:${editing}`));
      editing = null;
      draw();
    } else if (o.id === 'new') o.cancel?.();
    else o.leave();
  });
  root.addEventListener('mouseenter', () => o.hover(true));
  root.addEventListener('mouseleave', () => {
    if (!root.contains(document.activeElement)) o.hover(false);
  });
  root.addEventListener('focusin', () => o.hover(true));
  root.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget instanceof globalThis.Node && root.contains(e.relatedTarget)) && !root.matches(':hover')) o.hover(false);
  });

  const sign = (t: Thread | null) => JSON.stringify([editing, loadFolded().has(o.id), t]);

  function draw() {
    const t = o.model();
    shownAs = sign(t);
    // The focus kept: in the box it was in, where it was.
    const active = document.activeElement;
    const had = active instanceof HTMLTextAreaElement && root.contains(active) ? { testid: active.dataset.testid, at: active.selectionStart, to: active.selectionEnd } : null;
    root.replaceChildren();
    if (!t) return;
    const folded = o.id !== 'new' && loadFolded().has(o.id);
    const people = [...new Map(t.messages.map((m) => [m.person, m])).values()];
    const hues = huesFor(t.messages.map((m) => m.person));
    root.classList.toggle('kuraa-inline-folded', folded);
    root.setAttribute('aria-label', o.id === 'new' ? 'A new inline comment' : `A discussion of ${t.messages.length} ${t.messages.length === 1 ? 'message' : 'messages'}`);

    // Its head: what it is, who is in it, and folding it away.
    const head = make('div', 'kuraa-inline-head');
    head.append(make('span', 'kuraa-inline-icon', '💬'));
    if (o.id === 'new') head.append(make('span', 'kuraa-inline-title', 'New inline comment'));
    else {
      head.append(make('span', 'kuraa-inline-title', `${t.messages.length} ${t.messages.length === 1 ? 'message' : 'messages'}`));
      const faces = make('span', 'kuraa-inline-faces');
      for (const m of people.slice(0, 6)) {
        const f = make('span', 'kuraa-inline-face', initial(m.who));
        f.style.setProperty('--who', String(hues.get(m.person)));
        f.title = m.who;
        faces.append(f);
      }
      head.append(faces);
      if (folded) head.append(make('span', 'kuraa-inline-who', people.map((m) => m.who).join(', ')));
      const fold = link(folded ? 'Show' : 'Fold', () => {
        const ids = loadFolded();
        if (ids.has(o.id)) ids.delete(o.id);
        else ids.add(o.id);
        saveFolded(ids);
        draw();
      }, 'inline-fold', 'kuraa-card-link kuraa-inline-fold');
      fold.setAttribute('aria-expanded', String(!folded));
      head.append(fold);
    }
    root.append(head);
    if (folded) return;

    if (t.quote) root.append(make('div', 'kuraa-inline-quote', `“${t.quote.length > 160 ? `${t.quote.slice(0, 160)}…` : t.quote}”`));

    const list = make('ol', 'kuraa-inline-messages');
    for (const m of t.messages) {
      const row = make('li', 'kuraa-inline-message', undefined, m === t.messages[0] ? 'inline-comment' : 'inline-reply');
      row.style.setProperty('--who', String(hues.get(m.person)));
      const face = make('span', 'kuraa-inline-face', initial(m.who));
      face.setAttribute('aria-hidden', 'true');
      const body = make('div', 'kuraa-inline-body');
      const meta = make('div', 'kuraa-inline-meta');
      meta.append(make('span', 'kuraa-inline-name', m.who), make('span', 'kuraa-meta', ` · ${m.when}${m.edited ? ' · edited' : ''}`));
      body.append(meta);
      // Yours to edit or delete: beside who and when, shown as the message is pointed at.
      if (m.mine && t.canWrite && editing !== m.id) {
        const tools = make('span', 'kuraa-inline-tools');
        tools.append(link('Edit', () => {
          editing = m.id;
          draw();
          root.querySelector<HTMLTextAreaElement>('textarea[data-testid="inline-edit"]')?.focus();
        }, 'inline-edit-button'), link(m === t.messages[0] && t.messages.length > 1 ? 'Delete (its replies stay)' : 'Delete', () => o.remove(m.id), 'inline-delete', 'kuraa-card-link danger'));
        meta.append(tools);
      }
      if (editing === m.id && m.mine && t.canWrite) {
        const k = draft(`edit:${m.id}`);
        body.append(composer({
          testid: 'inline-edit',
          placeholder: 'Your comment',
          action: 'Save',
          autofocus: true,
          initial: o.drafts.get(k) ?? m.text,
          input: (v) => o.drafts.set(k, v),
          save: (text) => {
            o.drafts.delete(k);
            editing = null;
            o.edit(m.id, text);
            draw();
          },
          cancel: () => {
            o.drafts.delete(k);
            editing = null;
            draw();
          },
        }));
      } else body.append(make('div', 'kuraa-inline-text', m.text));
      row.append(face, body);
      list.append(row);
    }
    if (t.messages.length) root.append(list);

    if (t.canWrite && editing === null) {
      const k = draft('send');
      root.append(composer({
        testid: o.id === 'new' ? 'inline-new-text' : 'inline-reply-text',
        placeholder: o.id === 'new' ? 'Start the discussion' : 'Reply',
        action: o.id === 'new' ? 'Comment' : 'Reply',
        autofocus: o.id === 'new',
        initial: o.drafts.get(k) ?? '',
        input: (v) => o.drafts.set(k, v),
        save: (text) => {
          o.drafts.delete(k);
          o.send(text);
        },
        ...(o.id === 'new' ? { cancel: () => o.cancel?.() } : {}),
      }));
    }

    if (had) {
      const box = (had.testid && root.querySelector<HTMLTextAreaElement>(`textarea[data-testid="${had.testid}"]`)) || root.querySelector<HTMLTextAreaElement>('textarea');
      if (box) {
        box.focus();
        const n = box.value.length;
        box.setSelectionRange(Math.min(had.at ?? n, n), Math.min(had.to ?? n, n));
      }
    }
  }

  draw();
  return {
    element: root,
    update: () => {
      if (sign(o.model()) !== shownAs) draw();
    },
    focus: () => {
      const ids = loadFolded();
      if (ids.delete(o.id)) {
        saveFolded(ids);
        draw();
      }
      const box = root.querySelector<HTMLTextAreaElement>('textarea[data-testid="inline-reply-text"], textarea[data-testid="inline-new-text"]');
      box?.focus();
    },
  };
}

/** Its styles, in the app's colours: set apart from the text it sits in. */
export const INLINE_CSS = `
.kuraa-inline { --rail: var(--accent, #2f6f5e); position: relative; margin: 0.2em 0 1.1em; padding: 8px 12px 10px 14px; border: 1px solid color-mix(in srgb, var(--rail) 22%, var(--border, #ddd)); border-left: 3px solid var(--rail); border-radius: 4px 8px 8px 4px; background: color-mix(in srgb, var(--rail) 6%, var(--surface, #fff)); color: var(--text, inherit); font: 13.5px/1.45 var(--font, system-ui); font-variant-ligatures: normal; cursor: default; user-select: text; display: flex; flex-direction: column; gap: 8px; white-space: normal; }
.kuraa-inline.kuraa-inline-folded { padding-bottom: 8px; background: transparent; }
.kuraa-inline-head { display: flex; align-items: center; gap: 8px; color: var(--muted, #666); font-size: 12px; min-width: 0; }
.kuraa-inline-icon { font-size: 12px; }
.kuraa-inline-title { font-weight: 600; letter-spacing: 0.01em; }
.kuraa-inline-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.kuraa-inline-fold { margin-left: auto; }
.kuraa-inline-faces { display: inline-flex; }
.kuraa-inline-faces .kuraa-inline-face { width: 18px; height: 18px; font-size: 10px; margin-left: -4px; box-shadow: 0 0 0 2px color-mix(in srgb, var(--rail) 6%, var(--surface, #fff)); }
.kuraa-inline-faces .kuraa-inline-face:first-child { margin-left: 0; }
.kuraa-inline-face { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: hsl(var(--who, 160) 45% 42%); color: #fff; font: 600 11.5px/1 var(--font, system-ui); }
.kuraa-inline-quote { color: var(--muted, #666); font-size: 12.5px; font-style: italic; border-left: 2px solid color-mix(in srgb, var(--rail) 40%, transparent); padding-left: 8px; overflow-wrap: anywhere; }
.kuraa-inline .kuraa-inline-messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.kuraa-inline .kuraa-inline-message { display: flex; gap: 9px; align-items: flex-start; margin: 0; padding: 0; }
.kuraa-inline-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.kuraa-inline-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 4px; font-size: 12px; }
.kuraa-inline-meta .kuraa-meta { white-space: pre; }
.kuraa-inline-name { font-weight: 600; color: hsl(var(--who, 160) 45% 34%); }
.kuraa-inline-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.kuraa-inline-tools { display: inline-flex; gap: 10px; margin-left: auto; opacity: 0; transition: opacity 120ms; }
.kuraa-inline-message:hover .kuraa-inline-tools, .kuraa-inline-message:focus-within .kuraa-inline-tools { opacity: 1; }
.kuraa-inline .kuraa-card-composer textarea { background: var(--surface, #fff); }
.kuraa-inline .kuraa-card-composer:not(:focus-within) .kuraa-card-hint { visibility: hidden; }
/* A reply box not in use: the box alone, its button once something is typed or it is written in. */
.kuraa-inline .kuraa-card-composer:not(:focus-within):has(textarea:placeholder-shown) .kuraa-card-actions { display: none; }
.kuraa-inline-passage { background: color-mix(in srgb, var(--accent, #2f6f5e) 16%, transparent); border-radius: 2px; }
@media (prefers-color-scheme: dark) {
  .kuraa-inline-name { color: hsl(var(--who, 160) 60% 72%); }
  .kuraa-inline-face { background: hsl(var(--who, 160) 40% 40%); }
}
@media (prefers-reduced-motion: reduce) { .kuraa-inline-tools { transition: none; } }
`;
