// The annotations feature's client half (./index has its host half): comments
// and replies, on passages and documents (docs/decisions/0082-annotations.md).
//
// - Comments (where the workspace comments: so unless turned off), written and
//   read where the text is (./commentbox): Comment beside a selection (⌥⌘M)
//   opens a box just below it to write in, Enter saves; commented passages are
//   tinted, with a speech bubble in the margin at each (0129), in its maker's
//   colour, which opens its thread in a card
//   below the passage (reply, edit or delete your own). In any document you
//   read, whether or not you may change it.
// - The Comments panel (⌥⌘K): the document's threads in order, each comment
//   with its replies; reply, and edit or delete your own; comment on the whole
//   document; whose are shown (everyone's, or yours: your choice, in this
//   browser); and those no longer found, whose passages are gone.
// - Recent comments (a panel of the workspace): everyone's newest, each opening
//   at its passage.
// - Coding (where the workspace codes): # typed over a selection, or at the
//   caret, opens a box to name a code (./codebox): those there are suggested,
//   and Enter applies the one named, or makes it (Code beside a selection, and
//   ⌥⌘U, open it too). Each coding is a tag in the right margin with its code's
//   name; its passage is highlighted only while it, or the passage, is pointed
//   at; a tag opens what can be done (remove yours, find every passage with the
//   code). The Codes panel (the codebook as a tree, with counts: add, rename,
//   define, colour, nest, merge, delete); the Retrieve panel (every passage
//   coded with a code, and those under it, across the workspace).
//
// Yours are in the room, changed live; everyone else's are in the room while a
// device of theirs is, else read from their files and found again by quote.
// Drawn with the DOM alone: a feature does not depend on the client's framework.
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node, ResolvedPos } from 'prosemirror-model';
import { defineClientFeature, type FeatureClientContext, type FeatureEditorContext, type FeaturePanelContext, type Json, type MarginItem } from '@kuraa/feature-kit/client';
import { SUFFIX, aboutOf, codeOf, creatorColourOf, creatorOf, findPassage, isPoint, kindOf, readPage, textOf, type About, type Item } from './format.js';
import { CODEBOOK, codeTree, resolveCode, type Code, type Codebook } from './codebook.js';
import { openCodeBox, openMenu, type ScreenBox, type Suggestion } from './codebox.js';
import { composer as cardComposer, openCard, type Card } from './commentbox.js';
import type { RoomAnnotation } from './index.js';

const COMMENT_KEYS = 'Mod-Alt-m';
const PANEL_KEYS = 'Mod-Alt-k';
const CODE_KEYS = 'Mod-Alt-u';

/** An annotation as shown: whose, where it is in the document now (if it is about a passage that is found). */
interface Shown {
  id: string;
  person: string;
  mine: boolean;
  item: Item;
  kind: 'comment' | 'reply' | 'coding' | 'other';
  about: About | null;
  from: number | null;
  to: number | null;
  /** About a passage no longer found. */
  lost: boolean;
}

/** What the open document's editor and its panel share. */
interface Store {
  ctx: FeatureEditorContext;
  view: EditorView | null;
  /** People's files, as they are (those with no device in the room are shown from them). */
  files: { person: string; text: string }[];
  /** A comment being written on a passage, in its box at the text: anchors at its ends, and its quote. */
  pending: { from: Json; to: Json; quote: string } | null;
  /** The card open at the text (a comment being written, or a thread), and what it is for (`new`, or the comment's id). */
  card: Card | null;
  cardFor: string | null;
  /** A comment being written on the whole document. */
  onDocument: boolean;
  /** The comment a reply is being written to, or being edited. */
  replyTo: string | null;
  editing: string | null;
  /** What is typed, by composer, so drawing again keeps it. */
  drafts: Map<string, string>;
  /** The thread to show (its 💬 was clicked). */
  focus: string | null;
  listeners: Set<() => void>;
  /** Found passages of people's files, for one document. */
  cached: { doc: Node | null; shown: Shown[] };
  /** What is being coded while the code box is open (a passage, or a point: both ends one place): shown in the text meanwhile. */
  coding: { from: Json; to: Json } | null;
  /** How to close the code box, while it is open. */
  closeBox: (() => void) | null;
  /** Typing as text what the code box was given (`#`, `# `): # then is typed, not taken for a code. */
  typing: boolean;
  /** The codings pointed at: by their tag in the margin, or by their passage in the text (their groups' keys). */
  hoverTag: string | null;
  hoverText: Set<string>;
}

// ---------------------------------------------------------------------------
// The codebook, as the client has it: one per workspace (per feature context), read from the host and read again
// when it says it changed.

interface Codes {
  book: Codebook;
  path: string;
  loaded: boolean;
  listeners: Set<() => void>;
  reload(): Promise<void>;
}
const codebooks = new WeakMap<object, Codes>();

/** The codebook for a feature context (its workspace), loaded once and kept up to date. */
function codesOf(ctx: FeatureClientContext): Codes {
  let c = codebooks.get(ctx.request);
  if (c) return c;
  const codes: Codes = {
    book: { scheme: '', label: 'Codebook', codes: [] },
    path: CODEBOOK,
    loaded: false,
    listeners: new Set(),
    async reload() {
      try {
        const r = (await ctx.request('GET', 'codebook')) as unknown as { path: string; book: Codebook };
        codes.book = r.book;
        codes.path = r.path;
      } catch { /* off, or the host cannot say: as it was */ }
      codes.loaded = true;
      for (const fn of [...codes.listeners]) fn();
    },
  };
  c = codes;
  codebooks.set(ctx.request, c);
  ctx.onMessage((m) => {
    if (m && typeof m === 'object' && !Array.isArray(m) && (m as { codebook?: unknown }).codebook) void codes.reload();
  });
  void codes.reload();
  return c;
}

/** Whether the workspace codes. */
const coding = (ctx: FeatureClientContext) => ctx.status().settings.coding === true;
/** Whether the workspace comments: so unless turned off (it always did, before it could be). */
const commenting = (ctx: FeatureClientContext) => ctx.status().settings.comments !== false;
/** A coding's code, as it is now (merged codes followed), or null: none, or one deleted (shown as no longer in the codebook). */
const codeFor = (codes: Codes, item: Item): Code | null => {
  const id = codeOf(item);
  const code = id ? resolveCode(codes.book, id) : null;
  return code && !code.deleted ? code : null;
};

/** The live document's store, by path, for its panel. */
const stores = new Map<string, Store>();
const tell = (s: Store) => {
  for (const fn of [...s.listeners]) fn();
};

// Whose are shown: the reader's choice (0082), kept in this browser.
const WHOSE_KEY = 'kuraa:annotations-whose';
type Whose = 'everyone' | 'mine';
const loadWhose = (): Whose => {
  try {
    return localStorage.getItem(WHOSE_KEY) === 'mine' ? 'mine' : 'everyone';
  } catch {
    return 'everyone';
  }
};
const saveWhose = (w: Whose) => {
  try {
    localStorage.setItem(WHOSE_KEY, w);
  } catch { /* for this page only */ }
};

/** Everyone's annotations in a document, as shown: the room's, and the files of people with no device in it. */
function collect(store: Store, doc: Node): Shown[] {
  const { ctx } = store;
  const state = ctx.state;
  const out: Shown[] = [];
  const live = new Set<string>();
  if (state) {
    const add = (person: string, entries: { [key: string]: Json }, mine: boolean) => {
      for (const [id, v] of Object.entries(entries)) {
        const e = v as unknown as RoomAnnotation;
        if (!e || typeof e !== 'object' || !e.item) continue;
        const from = e.from !== undefined && !e.lost ? state.positionOf(e.from) : null;
        const to = e.to !== undefined && !e.lost ? state.positionOf(e.to) : null;
        const found = from !== null && to !== null && (to > from || (to === from && isPoint(aboutOf(e.item)))) && to <= doc.content.size;
        // Anchored at a passage: about it, as the text has it now (a new one names its passage only once its file is written).
        const named = aboutOf(e.item);
        const about: About | null = found && named?.kind !== 'passage' ? { kind: 'passage', exact: doc.textBetween(from!, to!, ' '), prefix: '', suffix: '', start: null, end: null } : named;
        out.push({ id, person, mine, item: e.item, kind: kindOf(e.item), about, from: found ? from : null, to: found ? to : null, lost: about?.kind === 'passage' && !found });
      }
    };
    live.add(state.me);
    add(state.me, state.entries(), true);
    for (const [p, entries] of Object.entries(state.others())) {
      live.add(p);
      add(p, entries, false);
    }
  }
  if (store.cached.doc !== doc) {
    const files = store.files.filter((f) => !live.has(f.person));
    const shown: Shown[] = [];
    if (files.length) {
      const text = ctx.type.serialize(doc);
      const map = ctx.sourceMap(doc);
      for (const f of files) {
        for (const item of readPage(f.text)) {
          const about = aboutOf(item);
          const at = about?.kind === 'passage' ? findPassage(text, about) : null;
          const point = at !== null && isPoint(about);
          const from = at ? map.toDoc(at.from, point ? -1 : 1) : null;
          shown.push({ id: String(item.id), person: f.person, mine: state?.me === f.person, item, kind: kindOf(item), about, from, to: at ? (point ? from : map.toDoc(at.to, -1)) : null, lost: about?.kind === 'passage' && !at });
        }
      }
    }
    store.cached = { doc, shown };
  }
  const all = [...out, ...store.cached.shown.filter((s) => !live.has(s.person))];
  return state && loadWhose() === 'mine' ? all.filter((s) => s.mine) : all;
}

const key = new PluginKey('kuraa-annotations');

/** Show a passage selected, and bring it into view. */
function select(view: EditorView, s: Shown) {
  const size = view.state.doc.content.size;
  if (s.from === null || s.to === null || s.to > size) return;
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, s.from, s.to)).scrollIntoView());
}

/** Close what is open at the text: the code box, a comment's card. */
function closeOpen(store: Store) {
  store.closeBox?.();
  store.card?.close('away');
}

/** Where a passage is on screen now, for a box or card to open just below its end; null where it cannot be said. */
function screenAt(view: EditorView, from: number | null, to: number | null): ScreenBox | null {
  if (view.isDestroyed || from === null || to === null || from > to || to > view.state.doc.content.size) return null;
  try {
    const end = view.coordsAtPos(to, -1);
    return { left: end.left, top: view.coordsAtPos(from).top, bottom: end.bottom };
  } catch {
    return null;
  }
}

/** A comment of yours changed: its text, and when. */
function editComment(state: NonNullable<FeatureEditorContext['state']>, id: string, text: string) {
  const was = state.entries()[id] as unknown as RoomAnnotation | undefined;
  if (!was) return;
  const b = (was.item.body && typeof was.item.body === 'object' && !Array.isArray(was.item.body) ? was.item.body : {}) as { [k: string]: Json };
  state.update({ set: { [id]: { ...was, item: { ...was.item, body: { ...b, value: text }, modified: new Date().toISOString() } } as unknown as Json } });
}

/**
 * Write a comment on what is selected, in a box just below it (Comment beside a selection, ⌥⌘M): Enter saves it, as a
 * comment of yours. False where there is nothing to comment on (no room, comments off, a selection of nothing but space).
 */
function openCommentBox(store: Store, view: EditorView, range?: { from: number; to: number }): boolean {
  const { ctx } = store;
  const room = ctx.state;
  if (!room || !commenting(ctx) || view.isDestroyed) return false;
  const { from, to } = range ?? view.state.selection;
  const quote = from < to ? view.state.doc.textBetween(from, to, ' ') : '';
  if (!quote.trim()) return false;
  closeOpen(store);
  const pending = { from: room.anchorAt(from, 1), to: room.anchorAt(to, -1), quote };
  store.pending = pending;
  store.cardFor = 'new';
  let typed = '';
  let saved = false;
  const where = () => [ctx.state?.positionOf(pending.from) ?? null, ctx.state?.positionOf(pending.to) ?? null] as const;
  store.card = openCard({
    testid: 'comment-box',
    label: 'Comment on the passage selected',
    at: () => screenAt(view, ...where()),
    holding: () => typed.trim() !== '',
    draw: (card) => card.append(
      el('div', { cls: 'kuraa-card-head', text: `Comment as ${ctx.person().name || 'you'}` }),
      cardComposer({
        testid: 'comment-box-text',
        placeholder: 'Your comment',
        action: 'Comment',
        autofocus: true,
        input: (t) => {
          typed = t;
        },
        save: (text) => {
          const state = ctx.state;
          if (!state) return;
          const name = ctx.path.slice(ctx.path.lastIndexOf('/') + 1);
          const item = newItem(ctx, state.me, 'commenting', text, { source: `../${name}`, selector: [{ type: 'TextQuoteSelector', exact: pending.quote }] });
          state.update({ set: { [String(item.id)]: { item, from: pending.from, to: pending.to } as unknown as Json } });
          saved = true;
          store.card?.close('done');
        },
        cancel: () => store.card?.close('escape'),
      }),
    ),
    closed: (how) => {
      store.card = null;
      store.cardFor = null;
      store.pending = null;
      tell(store);
      // Back in the text (not where something else was clicked): the passage selected again, or, saved, the caret after it.
      if (how === 'away' || view.isDestroyed) return;
      const [a, b] = where();
      if (a !== null && b !== null && a <= b && b <= view.state.doc.content.size) {
        try {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, saved ? b : a, b)));
        } catch { /* not a place text can be selected at: as it was */ }
      }
      view.focus();
    },
  });
  tell(store);
  return true;
}

/** A comment's thread, in a card just below its passage (its 💬 in the margin): read it, reply, edit or delete your own. */
function openThread(store: Store, view: EditorView, id: string, owner?: HTMLElement) {
  const { ctx } = store;
  // Its 💬 again: closed.
  if (store.cardFor === id) {
    store.card?.close('done');
    return;
  }
  closeOpen(store);
  const draft = (k: string) => `card:${id}:${k}`;
  let editing: string | null = null;
  const thread = () => {
    const all = collect(store, view.state.doc);
    const c = all.find((a) => a.id === id && a.kind === 'comment');
    if (!c) return null;
    const replies = all.filter((a) => a.kind === 'reply' && a.about?.kind === 'annotation' && a.about.id === id);
    return { c, replies: replies.sort((x, y) => String(x.item.created).localeCompare(String(y.item.created))) };
  };
  const sign = (t: ReturnType<typeof thread>) => JSON.stringify([editing, t ? [t.c, ...t.replies].map((a) => [a.id, a.item.modified ?? '', textOf(a.item)]) : null]);
  let shownAs = '';
  const follow = () => {
    const t = thread();
    if (!t) card.close('done');
    else if (sign(t) !== shownAs) card.redraw();
    else card.move();
  };
  const card: Card = openCard({
    testid: 'comment-thread',
    label: 'A comment and its replies',
    owner: () => owner ?? null,
    at: () => {
      const t = thread();
      return t ? screenAt(view, t.c.from, t.c.to) : null;
    },
    holding: () => [...store.drafts].some(([k, v]) => k.startsWith(draft('')) && v.trim() !== ''),
    draw: (box) => {
      const t = thread();
      shownAs = sign(t);
      if (!t) return;
      const state = ctx.state;
      const quote = t.c.about?.kind === 'passage' ? t.c.about.exact : '';
      if (quote) box.append(el('div', { cls: 'kuraa-card-quote', text: `“${quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}”` }));
      for (const a of [t.c, ...t.replies]) {
        const row = el('div', { cls: a === t.c ? 'kuraa-card-entry' : 'kuraa-card-entry kuraa-card-reply', testid: a === t.c ? 'thread-comment' : 'thread-reply' });
        row.append(el('div', { cls: 'kuraa-meta', text: `${a.mine ? 'You' : creatorOf(a.item) || 'Someone'} · ${when(String(a.item.created ?? ''))}${a.item.modified && a.item.modified !== a.item.created ? ' · edited' : ''}` }));
        if (editing === a.id && a.mine && state) {
          const k = draft(`edit:${a.id}`);
          const stop = () => {
            store.drafts.delete(k);
            editing = null;
            card.redraw();
          };
          row.append(cardComposer({
            testid: 'thread-edit',
            placeholder: 'Your comment',
            action: 'Save',
            autofocus: true,
            initial: store.drafts.get(k) ?? textOf(a.item),
            input: (v) => store.drafts.set(k, v),
            save: (text) => {
              store.drafts.delete(k);
              editing = null;
              editComment(state, a.id, text);
              card.redraw();
            },
            cancel: stop,
          }));
        } else {
          row.append(el('div', { cls: 'kuraa-text', text: textOf(a.item) }));
          if (a.mine && state) {
            row.append(el('div', { cls: 'kuraa-card-tools' }, button('Edit', () => {
              editing = a.id;
              card.redraw();
              card.element.querySelector<HTMLTextAreaElement>('textarea[data-testid="thread-edit"]')?.focus();
            }, 'thread-edit-button', 'kuraa-card-link'), button('Delete', () => {
              state.update({ remove: [a.id] });
              tell(store);
            }, 'thread-delete', 'kuraa-card-link danger')));
          }
        }
        box.append(row);
      }
      if (state && editing === null) {
        const k = draft('reply');
        box.append(cardComposer({
          testid: 'thread-reply-text',
          placeholder: 'Reply',
          action: 'Reply',
          autofocus: true,
          initial: store.drafts.get(k) ?? '',
          input: (v) => store.drafts.set(k, v),
          save: (text) => {
            const item = newItem(ctx, state.me, 'replying', text, id);
            store.drafts.delete(k);
            state.update({ set: { [String(item.id)]: { item } as unknown as Json } });
            tell(store);
          },
        }));
      }
      box.append(el('div', { cls: 'kuraa-card-foot' }, button('All comments in the panel', () => {
        card.close('done');
        store.focus = id;
        ctx.openPanel('comments');
        tell(store);
      }, 'thread-panel', 'kuraa-card-link')));
    },
    closed: (how) => {
      store.listeners.delete(follow);
      for (const k of [...store.drafts.keys()]) if (k.startsWith(draft(''))) store.drafts.delete(k);
      store.card = null;
      store.cardFor = null;
      if (store.focus === id) store.focus = null;
      tell(store);
      if (how === 'escape' && !view.isDestroyed) view.focus();
    },
  });
  store.card = card;
  store.cardFor = id;
  store.focus = id;
  // Its thread changing (a reply, an edit, anyone's) drawn again; the text moving, followed.
  store.listeners.add(follow);
  tell(store);
}

/** The codes to suggest, in the codebook's order, each with its parents' names. */
function suggestions(book: Codebook): Suggestion[] {
  const byId = new Map(book.codes.map((c) => [c.id, c]));
  return codeTree(book).map(({ code }) => {
    const parents: string[] = [];
    const seen = new Set([code.id]);
    for (let up = code.broader ? byId.get(code.broader) : undefined; up && !seen.has(up.id); up = up.broader ? byId.get(up.broader) : undefined) {
      seen.add(up.id);
      if (!up.deleted) parents.unshift(up.label);
    }
    return { code, parents };
  });
}

/** Whether the selection is in code (a code block, inline code): there, # is only ever typed. */
const inCode = (...at: ResolvedPos[]) => at.some(($p) => !!$p.parent.type.spec.code || $p.marks().some((m) => !!m.type.spec.code));

/** Make a code, by its name: its id, or null (said why) where it could not be made. */
async function newCode(ctx: FeatureClientContext, codes: Codes, label: string): Promise<string | null> {
  try {
    const r = (await ctx.request('POST', 'codebook', { op: 'add', label })) as unknown as { id: string | null; book: Codebook };
    codes.book = r.book;
    for (const fn of [...codes.listeners]) fn();
    return r.id;
  } catch (e) {
    ctx.notify(`The code “${label}” was not made: ${(e as Error).message}`, 'warn');
    return null;
  }
}

/** Type text as if typed (input rules and all: `# ` at a line's start is a heading's), not taken for a code. */
function typeAsText(store: Store, view: EditorView, text: string) {
  store.typing = true;
  try {
    for (const ch of text) {
      const { from, to } = view.state.selection;
      const plain = () => view.state.tr.insertText(ch, from, to);
      if (!view.someProp('handleTextInput', (f) => f(view, from, to, ch, plain))) view.dispatch(plain());
    }
  } finally {
    store.typing = false;
  }
}

/**
 * Open the code box for what is selected, or for the point at the caret: the code named there (or made) applied to it,
 * as a coding of yours. False where there is nothing to code (no room, coding off, a selection of nothing but space).
 */
function openCoding(store: Store, view: EditorView, range?: { from: number; to: number }): boolean {
  const { ctx } = store;
  const room = ctx.state;
  if (!room || !coding(ctx) || view.isDestroyed) return false;
  // Where # was typed, as the editor says (its selection may not yet have caught up with a click), else the selection.
  const { from, to } = range ?? view.state.selection;
  const empty = from === to;
  const quote = empty ? '' : view.state.doc.textBetween(from, to, ' ');
  if (!empty && !quote.trim()) return false;
  closeOpen(store);
  const codes = codesOf(ctx);
  // A point: both ends at the caret, kept after what is before it as text is typed there.
  const anchors = empty ? { from: room.anchorAt(from, -1), to: room.anchorAt(from, -1) } : { from: room.anchorAt(from, 1), to: room.anchorAt(to, -1) };
  store.coding = anchors;
  const end = view.coordsAtPos(to);
  const closed = () => {
    store.closeBox = null;
    store.coding = null;
    tell(store);
    if (view.isDestroyed) return;
    // Back where # was typed: the passage selected again (to code it again, say), or the caret at the point.
    const a = ctx.state?.positionOf(anchors.from) ?? null;
    const b = ctx.state?.positionOf(anchors.to) ?? null;
    const size = view.state.doc.content.size;
    if (a !== null && b !== null && a <= b && b <= size) {
      try {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a, b)));
      } catch { /* not a place text can be selected at: as it was */ }
    }
    view.focus();
  };
  store.closeBox = openCodeBox({
    at: { left: end.left, top: view.coordsAtPos(from).top, bottom: end.bottom },
    point: empty,
    codes: () => suggestions(codes.book),
    choose: (choice) => {
      closed();
      void ('id' in choice ? Promise.resolve(choice.id) : newCode(ctx, codes, choice.label)).then((id) => {
        const state = ctx.state;
        if (!id || !state) return;
        const name = ctx.path.slice(ctx.path.lastIndexOf('/') + 1);
        const item = newCoding(ctx, state.me, id, quote, `../${name}`);
        state.update({ set: { [String(item.id)]: { item, ...anchors } as unknown as Json } });
        tell(store);
      });
    },
    cancel: (typed) => {
      closed();
      if (typed && !view.isDestroyed) typeAsText(store, view, typed);
    },
  });
  tell(store);
  return true;
}

/** Codings of one code at one passage (or point), everyone's: one tag in the margin. */
interface Group {
  key: string;
  code: Code | null;
  from: number;
  to: number;
  point: boolean;
  list: Shown[];
}

/** The document's codings as tags: one for each code at each passage, in the order of the text. */
function codedGroups(store: Store, codes: Codes, doc: Node): Group[] {
  const groups = new Map<string, Group>();
  for (const s of collect(store, doc)) {
    if (s.kind !== 'coding' || s.from === null || s.to === null) continue;
    const code = codeFor(codes, s.item);
    const key = `${code?.id ?? codeOf(s.item) ?? ''}@${s.from}-${s.to}`;
    const g = groups.get(key) ?? { key, code, from: s.from, to: s.to, point: s.from === s.to, list: [] };
    g.list.push(s);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.from - b.from || a.to - b.to || (a.code?.label ?? '').localeCompare(b.code?.label ?? ''));
}

const NO_CODE = 'A code no longer in the codebook';

/** What can be done with a tag's codings: remove yours, find every passage with its code, open the codebook. */
function tagMenu(store: Store, g: Group, at: HTMLElement) {
  const { ctx } = store;
  const state = ctx.state;
  const mine = g.list.filter((s) => s.mine);
  const who = [...new Set(g.list.map((s) => (s.mine ? 'you' : creatorOf(s.item) || 'someone')))];
  const quote = g.list[0]?.about?.kind === 'passage' ? g.list[0].about.exact : '';
  const label = g.code?.label ?? NO_CODE;
  openMenu(at, {
    title: label,
    color: g.code?.color,
    lines: [g.point ? 'At a point in the text' : `“${quote.length > 90 ? `${quote.slice(0, 90)}…` : quote}”`, `Coded by ${who.join(', ')}`],
    items: [
      ...(mine.length && state ? [{ label: mine.length > 1 ? 'Remove your codings' : 'Remove your coding', testid: 'code-remove', danger: true, run: () => {
        state.update({ remove: mine.map((s) => s.id) });
        store.hoverTag = null;
        tell(store);
      } }] : []),
      ...(g.code ? [{ label: `Every passage coded “${label}”`, testid: 'code-retrieve', run: () => {
        retrieveWanted = { code: g.code!.id, below: true };
        for (const fn of [...retrieveListeners]) fn();
        ctx.openPanel('retrieve');
      } }] : []),
      { label: 'The codebook…', testid: 'code-codebook', run: () => ctx.openPanel('codes') },
    ],
  });
}

function editor(ctx: FeatureEditorContext) {
  injectStyle();
  const store: Store = { ctx, view: null, files: [], pending: null, onDocument: false, replyTo: null, editing: null, drafts: new Map(), focus: null, listeners: new Set(), cached: { doc: null, shown: [] }, card: null, cardFor: null, coding: null, closeBox: null, typing: false, hoverTag: null, hoverText: new Set() };
  const codes = codesOf(ctx);
  /** The passages pointed at in the text: drawn again only where that changed. */
  const hoverText = (keys: Set<string>) => {
    if (keys.size === store.hoverText.size && [...keys].every((k) => store.hoverText.has(k))) return;
    store.hoverText = keys;
    tell(store);
  };
  // Only the live document's is its panel's (a past version's is its own).
  if (ctx.state) stores.set(ctx.path, store);
  let liveKey = '';
  const switches = () => `${commenting(ctx)} ${coding(ctx)}`;
  let switched = switches();
  const load = async () => {
    store.files = await ctx.companions(SUFFIX).catch(() => []);
    store.cached = { doc: null, shown: [] };
    tell(store);
  };
  const plugin = new Plugin({
    key,
    props: {
      decorations: (state) => {
        const size = state.doc.content.size;
        const shown = collect(store, state.doc).filter((s) => s.from !== null && s.to !== null && s.to <= size);
        const decos = commenting(ctx) ? shown.filter((s) => s.kind === 'comment').map((s) =>
          Decoration.inline(s.from!, s.to!, { class: s.id === store.focus ? 'kuraa-commented kuraa-commented-focus' : 'kuraa-commented', 'data-annotation': s.id })) : [];
        // What is being commented on, while its box is open (the selection is not shown while the box has the focus).
        if (store.pending && ctx.state) {
          const from = ctx.state.positionOf(store.pending.from);
          const to = ctx.state.positionOf(store.pending.to);
          if (from !== null && to !== null && from < to && to <= size) decos.push(Decoration.inline(from, to, { class: 'kuraa-now' }));
        }
        // Coded passages: shown only while pointed at (their tag in the margin, or the passage), in their code's colour.
        if (coding(ctx)) {
          const pointed = new Set([...store.hoverText, ...(store.hoverTag ? [store.hoverTag] : [])]);
          if (pointed.size) {
            for (const g of codedGroups(store, codes, state.doc)) {
              if (!pointed.has(g.key)) continue;
              const style = `--kuraa-code: ${g.code?.color ?? '#888'}`;
              if (g.point) decos.push(Decoration.widget(g.from, () => pin(style), { side: -1, key: `pin:${g.key}`, ignoreSelection: true }));
              else decos.push(Decoration.inline(g.from, g.to, { class: 'kuraa-coded-hover', style }));
            }
          }
          // What is being coded, while the code box is open (the selection is not shown while the box has the focus).
          const room = ctx.state;
          if (store.coding && room) {
            const from = room.positionOf(store.coding.from);
            const to = room.positionOf(store.coding.to);
            if (from !== null && to !== null && to <= size) {
              if (to > from) decos.push(Decoration.inline(from, to, { class: 'kuraa-now' }));
              else if (to === from) decos.push(Decoration.widget(from, () => pin('--kuraa-code: var(--accent, #c08a00)'), { side: -1, key: 'pin:now', ignoreSelection: true }));
            }
          }
        }
        return DecorationSet.create(state.doc, decos);
      },
      // # over a selection, or at the caret: the code box, not a #. (Not in code, and not while typing what the box gave back.)
      handleTextInput: (view, from, to, text) => text === '#' && !store.typing && coding(ctx) && !!ctx.state && !inCode(view.state.doc.resolve(from), view.state.doc.resolve(to)) && openCoding(store, view, { from, to }),
      handleDOMEvents: {
        // A coded passage pointed at: highlighted, its tags too.
        mousemove: (view, e) => {
          if (!coding(ctx)) return false;
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
          const keys = new Set<string>();
          if (at && at.inside >= 0) {
            for (const g of codedGroups(store, codes, view.state.doc)) if (!g.point && g.from <= at.pos && at.pos < g.to) keys.add(g.key);
          }
          hoverText(keys);
          return false;
        },
        mouseleave: () => {
          hoverText(new Set());
          return false;
        },
      },
    },
    view: (view) => {
      store.view = view;
      let queued = false;
      const redraw = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true));
          ctx.redraw();
        });
      };
      store.listeners.add(redraw);
      codes.listeners.add(redraw);
      // People coming and going from the room: their files read again (shown from them while they are away).
      const off = ctx.state?.observe(() => {
        const now = ctx.state ? [ctx.state.me, ...Object.keys(ctx.state.others())].sort().join() : '';
        if (now !== liveKey) {
          liveKey = now;
          void load();
        }
        store.cached = { doc: null, shown: [] };
        tell(store);
      });
      void load();
      return {
        update: () => store.card?.move(),
        destroy: () => {
          off?.();
          closeOpen(store);
          store.listeners.delete(redraw);
          codes.listeners.delete(redraw);
          if (stores.get(ctx.path) === store) stores.delete(ctx.path);
        },
      };
    },
  });
  return {
    plugins: () => [plugin],
    // Its commands (0091): their keys are bound by the core, in the editor.
    commands: { comment: (view: EditorView) => openCommentBox(store, view), code: (view: EditorView) => openCoding(store, view) },
    margin: (view: EditorView) => {
      // Comments or coding turned on or off (the margin is drawn again then): the text's highlights drawn again too.
      const now = switches();
      if (now !== switched) {
        switched = now;
        if (!commenting(ctx) && store.cardFor) store.card?.close('away');
        queueMicrotask(() => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true));
        });
      }
      const shown = collect(store, view.state.doc).filter((s) => s.from !== null);
      // A speech bubble at each comment, in its maker's colour (yours as it is now, for your own), opening its thread below its passage.
      const items: MarginItem[] = commenting(ctx) ? shown.filter((s) => s.kind === 'comment').map((s) => ({
        key: s.id,
        pos: s.from!,
        label: '💬',
        icon: BUBBLE,
        color: (s.mine ? ctx.person().color : null) || creatorColourOf(s.item) || undefined,
        title: `${creatorOf(s.item) || 'Someone'}: ${textOf(s.item)}`,
        active: store.cardFor === s.id,
        run: (at: HTMLElement) => openThread(store, view, s.id, at),
      })) : [];
      if (!coding(ctx)) return items;
      // A tag for each code at each passage, in its colour, at the passage's first line.
      const tags: MarginItem[] = codedGroups(store, codes, view.state.doc).map((g) => {
        const who = [...new Set(g.list.map((s) => (s.mine ? 'you' : creatorOf(s.item) || 'someone')))];
        const label = g.code?.label ?? NO_CODE;
        return {
          key: `code:${g.key}`,
          pos: g.from,
          kind: 'tag',
          label,
          title: `${label}${g.point ? ' (at a point)' : ''}, coded by ${who.join(', ')}`,
          color: g.code?.color ?? '#888888',
          active: store.hoverTag === g.key || store.hoverText.has(g.key),
          hover: (on: boolean) => {
            store.hoverTag = on ? g.key : store.hoverTag === g.key ? null : store.hoverTag;
            tell(store);
          },
          run: (at: HTMLElement) => tagMenu(store, g, at),
        };
      });
      return [...items, ...tags];
    },
    selectionActions: () => (ctx.state ? [
      ...(commenting(ctx) ? [{ command: 'comment', testid: 'annotations-comment' }] : []),
      ...(coding(ctx) ? [{ command: 'code', testid: 'annotations-code' }] : []),
    ] : []),
    destroy: () => {
      closeOpen(store);
      if (stores.get(ctx.path) === store) stores.delete(ctx.path);
    },
  };
}

/** A point coded, as it is shown while pointed at: a pin between two characters, in its code's colour. */
function pin(style: string) {
  const s = document.createElement('span');
  s.className = 'kuraa-point';
  s.setAttribute('style', style);
  return s;
}

// ---------------------------------------------------------------------------
// The Comments panel

/** This person, as their annotations name them: their identity, name and cursor colour (0129) as they are now. */
function creator(ctx: FeatureClientContext, me: string): Json {
  const { name, color } = ctx.person();
  return { id: `urn:kuraa:person:${me}`, type: 'Person', name, ...(/^#[0-9a-f]{6}$/i.test(color) ? { color } : {}) };
}

/** A comment in the margin (0129): a speech bubble, as line art in a 16×16 box. */
const BUBBLE = { paths: ['M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7.5l-3.25 2.75v-2.75H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z'] };

/** A new annotation of this person's. */
function newItem(ctx: FeatureClientContext, me: string, motivation: 'commenting' | 'replying', value: string, target: Json): Item {
  const now = new Date().toISOString();
  return {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: 'Annotation',
    motivation,
    created: now,
    modified: now,
    creator: creator(ctx, me),
    body: { type: 'TextualBody', value, format: 'text/markdown', purpose: motivation },
    target,
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, o: { cls?: string; text?: string; testid?: string; title?: string } = {}, ...kids: (globalThis.Node | string | null)[]) => {
  const e = document.createElement(tag);
  if (o.cls) e.className = o.cls;
  if (o.text !== undefined) e.textContent = o.text;
  if (o.testid) e.dataset.testid = o.testid;
  if (o.title) e.title = o.title;
  for (const k of kids) if (k !== null) e.append(k);
  return e;
};

/**
 * A link at the top of a panel to its companion: the document's Comments and
 * Recent comments (in every document), Codes and Retrieve coded passages; one
 * in place of the other, as a tab is (the ⋯ menu offers Comments and Codes).
 */
function viewLink(pctx: FeaturePanelContext, text: string, testid: string, panel: string, needsDocument = false): HTMLElement {
  const b = el('button', { cls: 'kuraa-view-link', text, testid });
  b.type = 'button';
  b.onclick = () => pctx.openPanel(panel);
  // To the document's comments: only while a document is open.
  if (needsDocument) {
    const show = () => (b.hidden = !pctx.path());
    show();
    pctx.onDocument(show);
  }
  return b;
}
const button = (label: string, run: () => void, testid?: string, cls?: string) => {
  const b = el('button', { text: label, testid, cls });
  b.type = 'button';
  b.onclick = run;
  return b;
};
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

function mountComments(root: HTMLElement, pctx: FeaturePanelContext): () => void {
  injectStyle();
  const body = el('div', { cls: 'kuraa-comments', testid: 'annotations-panel' });
  root.append(viewLink(pctx, 'Recent comments in every document →', 'annotations-to-recent', 'recent'), body);
  let store: Store | null = null;
  const watch = () => {
    const now = stores.get(pctx.path() ?? '') ?? null;
    if (now === store) return;
    if (store) store.listeners.delete(draw);
    store = now;
    store?.listeners.add(draw);
  };

  /** A composer: a box to type in, kept as typed whatever is drawn again, with what to do with it. */
  const composer = (id: string, placeholder: string, save: (text: string) => void, cancel: () => void, initial = '') => {
    const s = store!;
    const box = el('textarea', { testid: `annotations-text-${id.split(':')[0]}` });
    box.placeholder = placeholder;
    box.value = s.drafts.get(id) ?? initial;
    box.oninput = () => s.drafts.set(id, box.value);
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        go();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        stop();
      }
    };
    const go = () => {
      const text = box.value.trim();
      if (!text) return;
      s.drafts.delete(id);
      save(text);
    };
    const stop = () => {
      s.drafts.delete(id);
      cancel();
    };
    queueMicrotask(() => {
      if (!box.isConnected) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    return el('div', { cls: 'kuraa-composer' }, box, el('div', { cls: 'kuraa-actions' }, button('Save', go, 'annotations-save'), button('Cancel', stop, 'annotations-cancel')));
  };

  /** What the panel shows, in short: drawn again only when it changes (a click is not lost to a redraw as someone types). */
  let shownAs = '';
  function draw(force = true) {
    watch();
    const s = store;
    const state = pctx.state();
    const view = pctx.view();
    if (s && view && !force) {
      const now = JSON.stringify([state?.me ?? null, loadWhose(), collect(s, view.state.doc).map((a) => [a.id, a.item.modified ?? '', textOf(a.item), a.lost, a.from === null])]);
      if (now === shownAs) return;
    }
    body.replaceChildren();
    if (!commenting(pctx)) {
      body.append(el('p', { cls: 'kuraa-note', text: 'Comments are off for this workspace (Settings › Components, under Annotations). Those made are kept.' }));
      return;
    }
    if (!s || !view) {
      body.append(el('p', { cls: 'kuraa-note', text: 'Open a document to comment on it.' }));
      return;
    }
    const me = state?.me ?? null;
    const doc = view.state.doc;
    const all = collect(s, doc);
    shownAs = JSON.stringify([me, loadWhose(), all.map((a) => [a.id, a.item.modified ?? '', textOf(a.item), a.lost, a.from === null])]);
    const name = pctx.path()!.slice(pctx.path()!.lastIndexOf('/') + 1);

    // What can be done here, and whose are shown.
    const whose = el('select', { testid: 'annotations-whose', title: 'Whose comments are shown: yours to choose, in this browser' }) as HTMLSelectElement;
    for (const [v, label] of [['everyone', 'Everyone’s'], ['mine', 'Only yours']] as const) {
      const o = el('option', { text: label });
      o.value = v;
      whose.append(o);
    }
    whose.value = loadWhose();
    whose.onchange = () => {
      saveWhose(whose.value as Whose);
      s.cached = { doc: null, shown: [] };
      tell(s);
    };
    body.append(el('div', { cls: 'kuraa-bar' }, state ? button('Comment on the document', () => {
      s.onDocument = true;
      tell(s);
    }, 'annotations-on-document') : null, el('label', { text: 'Show ' }, whose)));
    if (!state) body.append(el('p', { cls: 'kuraa-note', text: 'Your comments are not kept here: this computer has no identity of yours yet, or the document is opened where comments are not kept.' }));

    // Writing a comment on the document (one on a passage is written at the passage).
    if (s.onDocument && state) {
      body.append(el('div', { cls: 'kuraa-thread kuraa-new' }, el('p', { cls: 'kuraa-note', text: `On ${name} as a whole` }), composer('new:document', 'Your comment on the document', (text) => {
        const item = newItem(pctx, me!, 'commenting', text, `../${name}`);
        state.update({ set: { [String(item.id)]: { item } as unknown as Json } });
        s.onDocument = false;
        tell(s);
      }, () => {
        s.onDocument = false;
        tell(s);
      })));
    }

    // The threads: comments on the document first, then each on a passage, in the order of the text; their replies under them.
    const replies = new Map<string, Shown[]>();
    for (const a of all) if (a.kind === 'reply' && a.about?.kind === 'annotation') replies.set(a.about.id, [...(replies.get(a.about.id) ?? []), a]);
    const comments = all.filter((a) => a.kind === 'comment' && !a.lost);
    comments.sort((a, b) => (a.from ?? -1) - (b.from ?? -1) || String(a.item.created).localeCompare(String(b.item.created)));
    const shownIds = new Set(comments.map((c) => c.id));

    const entry = (a: Shown, isReply: boolean) => {
      const wrap = el('div', { cls: isReply ? 'kuraa-reply' : 'kuraa-comment', testid: isReply ? 'annotations-reply' : 'annotations-comment-row' });
      wrap.append(el('div', { cls: 'kuraa-meta', text: `${creatorOf(a.item) || 'Someone'} · ${when(String(a.item.created ?? ''))}${a.item.modified && a.item.modified !== a.item.created ? ' · edited' : ''}` }));
      if (s.editing === a.id && a.mine && state) {
        wrap.append(composer(`edit:${a.id}`, 'Your comment', (text) => {
          editComment(state, a.id, text);
          s.editing = null;
          tell(s);
        }, () => {
          s.editing = null;
          tell(s);
        }, textOf(a.item)));
      } else {
        wrap.append(el('div', { cls: 'kuraa-text', text: textOf(a.item) }));
        const actions = el('div', { cls: 'kuraa-actions' });
        if (!isReply && state) actions.append(button('Reply', () => {
          s.replyTo = a.id;
          tell(s);
        }, 'annotations-reply-button'));
        if (a.mine && state) {
          actions.append(button('Edit', () => {
            s.editing = a.id;
            tell(s);
          }, 'annotations-edit'), button('Delete', () => {
            state.update({ remove: [a.id] });
            tell(s);
          }, 'annotations-delete', 'danger'));
        }
        if (actions.childNodes.length) wrap.append(actions);
      }
      return wrap;
    };

    const list = el('div', { cls: 'kuraa-threads' });
    for (const c of comments) {
      const thread = el('div', { cls: c.id === s.focus ? 'kuraa-thread kuraa-focus' : 'kuraa-thread', testid: 'annotations-thread' });
      thread.dataset.annotation = c.id;
      if (c.about?.kind === 'passage') {
        const q = button(`“${c.about.exact}”`, () => {
          s.focus = c.id;
          select(view, c);
          tell(s);
        }, 'annotations-quote', 'kuraa-quote');
        q.title = 'Show it in the document';
        thread.append(q);
      } else thread.append(el('p', { cls: 'kuraa-note', text: 'On the document' }));
      thread.append(entry(c, false));
      for (const r of (replies.get(c.id) ?? []).sort((x, y) => String(x.item.created).localeCompare(String(y.item.created)))) thread.append(entry(r, true));
      if (s.replyTo === c.id && state) {
        thread.append(composer(`reply:${c.id}`, 'Your reply', (text) => {
          const item = newItem(pctx, me!, 'replying', text, c.id);
          state.update({ set: { [String(item.id)]: { item } as unknown as Json } });
          s.replyTo = null;
          tell(s);
        }, () => {
          s.replyTo = null;
          tell(s);
        }));
      }
      list.append(thread);
      if (c.id === s.focus) queueMicrotask(() => thread.scrollIntoView({ block: 'nearest' }));
    }
    if (!comments.length && !s.onDocument) list.append(el('p', { cls: 'kuraa-note', text: 'No comments yet. Select some text, then Comment (or press ⌥⌘M), and write it there.' }));
    body.append(list);

    // No longer found: comments whose passages are gone, and replies whose comments are gone. Kept, never dropped.
    const lost = all.filter((a) => (a.kind === 'comment' && a.lost) || (a.kind === 'reply' && a.about?.kind === 'annotation' && !shownIds.has(a.about.id) && !all.some((x) => x.id === (a.about as { id: string }).id && x.kind === 'comment')));
    if (lost.length) {
      const box = el('details', { cls: 'kuraa-lost', testid: 'annotations-lost' });
      box.append(el('summary', { text: `No longer found (${lost.length})` }));
      for (const a of lost) {
        const row = el('div', { cls: 'kuraa-comment' });
        if (a.about?.kind === 'passage') row.append(el('blockquote', { text: a.about.exact }));
        row.append(el('div', { cls: 'kuraa-meta', text: `${creatorOf(a.item) || 'Someone'} · ${when(String(a.item.created ?? ''))}` }), el('div', { cls: 'kuraa-text', text: textOf(a.item) }));
        if (a.mine && state) row.append(el('div', { cls: 'kuraa-actions' }, button('Delete', () => state.update({ remove: [a.id] }), 'annotations-delete', 'danger')));
        box.append(row);
      }
      body.append(box);
    }
  }

  draw();
  // The document changing (typing, another opened): drawn again only if what is shown changed.
  const off = pctx.onDocument(() => draw(false));
  return () => {
    off();
    if (store) store.listeners.delete(draw);
    body.remove();
  };
}

/** The workspace's newest comments, everyone's, each opening at its passage. */
function mountRecent(root: HTMLElement, pctx: FeaturePanelContext): () => void {
  injectStyle();
  const body = el('div', { cls: 'kuraa-comments', testid: 'annotations-recent' });
  root.append(viewLink(pctx, '← Comments in this document', 'annotations-to-comments', 'comments', true), body);
  let live = true;
  const draw = async () => {
    if (!commenting(pctx)) {
      body.replaceChildren(el('p', { cls: 'kuraa-note', text: 'Comments are off for this workspace (Settings › Components, under Annotations). Those made are kept.' }));
      return;
    }
    body.replaceChildren(el('p', { cls: 'kuraa-note', text: 'Looking…' }));
    let rows: { path: string; id: string; kind: string; text: string; by: string; created: string; quote: string | null; at: { from: number; to: number } | null }[];
    try {
      rows = (await pctx.request('GET', 'recent')) as unknown as typeof rows;
    } catch (e) {
      if (live) body.replaceChildren(el('p', { cls: 'kuraa-note', text: (e as Error).message }));
      return;
    }
    if (!live) return;
    body.replaceChildren();
    if (!rows.length) body.append(el('p', { cls: 'kuraa-note', text: 'No comments in this workspace yet.' }));
    for (const r of rows) {
      const row = el('button', { cls: 'kuraa-recent', testid: 'annotations-recent-row' });
      row.type = 'button';
      row.append(el('span', { cls: 'kuraa-meta', text: `${r.path} · ${r.by || 'Someone'} · ${when(r.created)}${r.kind === 'reply' ? ' · reply' : ''}` }));
      if (r.quote) row.append(el('blockquote', { text: r.quote }));
      row.append(el('span', { cls: 'kuraa-text', text: r.text }));
      row.onclick = () => pctx.openFile(r.path, r.at ?? undefined);
      body.append(row);
    }
  };
  void draw();
  return () => {
    live = false;
    body.remove();
  };
}


// ---------------------------------------------------------------------------
// Coding: the Codes panel and the Retrieve panel

/** A new coding of this person's: a passage classified with a code. */
function newCoding(ctx: FeatureClientContext, me: string, code: string, quote: string, source: string): Item {
  const now = new Date().toISOString();
  return {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: 'Annotation',
    motivation: 'classifying',
    created: now,
    modified: now,
    creator: creator(ctx, me),
    body: { type: 'SpecificResource', source: code, purpose: 'classifying' },
    target: { source, selector: [{ type: 'TextQuoteSelector', exact: quote }] },
  };
}

/** What the Retrieve panel is to show, when a code's Retrieve was chosen. */
let retrieveWanted: { code: string; below: boolean } | null = null;
const retrieveListeners = new Set<() => void>();

function mountCodes(root: HTMLElement, pctx: FeaturePanelContext): () => void {
  injectStyle();
  const body = el('div', { cls: 'kuraa-comments kuraa-codes', testid: 'annotations-codes' });
  root.append(viewLink(pctx, 'Retrieve coded passages →', 'annotations-to-retrieve', 'retrieve'), body);
  const codes = codesOf(pctx);
  let counts: { [id: string]: number } = {};
  let editing: string | null = null;
  let error: string | null = null;
  /**
   * What is typed or chosen in the panel's boxes, by box (`label:<code>`, `new`…): drawing the panel again (someone else
   * codes, the counts change) keeps it, and the focus where it was, until it is saved or given up.
   */
  const drafts = new Map<string, string>();
  const kept = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(box: T, key: string, initial: string): T => {
    box.dataset.key = key;
    box.value = drafts.get(key) ?? initial;
    const keep = () => drafts.set(key, box.value);
    if (box instanceof HTMLSelectElement || (box instanceof HTMLInputElement && box.type === 'color')) box.addEventListener('change', keep);
    box.addEventListener('input', keep);
    return box;
  };
  const forget = (prefix: string) => {
    for (const k of [...drafts.keys()]) if (k === prefix || k.endsWith(`:${prefix}`)) drafts.delete(k);
  };
  const loadCounts = async () => {
    try {
      const got = (await pctx.request('GET', 'counts')) as unknown as { [id: string]: number };
      if (JSON.stringify(got) === JSON.stringify(counts)) return;
      counts = got;
    } catch {
      counts = {};
    }
    draw();
  };
  // Counts are of what is written (a coding a moment after it is made): asked again a little after anything changes.
  let countsTimer: ReturnType<typeof setTimeout> | undefined;
  const countsSoon = () => {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(() => void loadCounts(), 1500);
  };
  const change = async (b: Json) => {
    error = null;
    try {
      const r = (await pctx.request('POST', 'codebook', b)) as unknown as { id: string | null; book: Codebook };
      codes.book = r.book;
      for (const fn of [...codes.listeners]) fn();
      return r.id;
    } catch (e) {
      error = (e as Error).message;
      draw();
      return null;
    }
  };
  function draw() {
    // Where the focus is, to put it back once drawn again.
    const active = document.activeElement as (HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null }) | null;
    const focusKey = active && body.contains(active) ? active.dataset.key ?? null : null;
    const caret = focusKey ? [active!.selectionStart ?? null, active!.selectionEnd ?? null] as const : null;
    body.replaceChildren();
    if (!coding(pctx)) {
      body.append(el('p', { cls: 'kuraa-note', text: 'Coding is off for this workspace. Turn it on in Settings › Components, under Annotations.' }));
      return;
    }
    if (focusKey) {
      queueMicrotask(() => {
        const again = body.querySelector<HTMLElement & { setSelectionRange?: (a: number, b: number) => void }>(`[data-key="${CSS.escape(focusKey)}"]`);
        if (!again) return;
        again.focus();
        if (caret && caret[0] !== null && caret[1] !== null && again.setSelectionRange) {
          try {
            again.setSelectionRange(caret[0], caret[1]);
          } catch { /* a box with no caret */ }
        }
      });
    }
    if (error) body.append(el('p', { cls: 'kuraa-note kuraa-error', text: error }));
    const tree = codeTree(codes.book);
    // The codebook: a tree, each with its count; add, and change each.
    const list = el('div', { cls: 'kuraa-codebook', testid: 'codes-tree' });
    if (!tree.length) list.append(el('p', { cls: 'kuraa-note', text: 'No codes yet: add one below, or select some text (or put the caret anywhere) and type #.' }));
    for (const { code, depth } of tree) {
      const row = el('div', { cls: 'kuraa-code', testid: 'codes-row' });
      row.style.paddingLeft = `${depth * 14}px`;
      const head = el('div', { cls: 'kuraa-code-head' }, swatch(code.color), el('span', { cls: 'kuraa-code-label', text: code.label }), el('span', { cls: 'kuraa-meta', text: String(counts[code.id] ?? 0) }));
      head.append(button('Retrieve', () => {
        retrieveWanted = { code: code.id, below: true };
        for (const fn of [...retrieveListeners]) fn();
        pctx.openPanel('retrieve');
      }, 'codes-retrieve'), button(editing === code.id ? 'Done' : 'Edit', () => {
        editing = editing === code.id ? null : code.id;
        draw();
      }, 'codes-edit'));
      row.append(head);
      if (code.definition && editing !== code.id) row.append(el('div', { cls: 'kuraa-meta kuraa-text', text: code.definition }));
      if (editing === code.id) row.append(codeEditor(code));
      list.append(row);
    }
    body.append(list);
    const name = kept(el('input', { testid: 'codes-new-name' }) as HTMLInputElement, 'new', '');
    name.placeholder = 'A new code';
    const add = () => {
      if (!name.value.trim()) return;
      void change({ op: 'add', label: name.value.trim() }).then((id) => {
        if (id === null) return;
        forget('new');
        draw();
      });
    };
    name.onkeydown = (e) => {
      if (e.key === 'Enter') add();
    };
    body.append(el('div', { cls: 'kuraa-bar' }, name, button('Add', add, 'codes-add')));
  }

  /** A code's settings: its name, what it means, its colour, where it goes; merging it into another; deleting it. */
  function codeEditor(code: Code) {
    const others = codeTree(codes.book).filter(({ code: c }) => c.id !== code.id);
    const box = el('div', { cls: 'kuraa-composer', testid: 'codes-editor' });
    const label = kept(el('input', { testid: 'codes-label' }) as HTMLInputElement, `label:${code.id}`, code.label);
    const definition = kept(el('textarea', { testid: 'codes-definition' }) as HTMLTextAreaElement, `definition:${code.id}`, code.definition ?? '');
    definition.placeholder = 'What it means, and when to use it';
    const colour = el('input', { testid: 'codes-colour' }) as HTMLInputElement;
    colour.type = 'color';
    kept(colour, `colour:${code.id}`, code.color ?? '#888888');
    const parent = el('select', { testid: 'codes-parent' }) as HTMLSelectElement;
    const top = el('option', { text: '(at the top)' });
    top.value = '';
    parent.append(top);
    for (const { code: c, depth } of others) {
      const o = el('option', { text: `${'  '.repeat(depth)}${c.label}` });
      o.value = c.id;
      parent.append(o);
    }
    kept(parent, `parent:${code.id}`, code.broader ?? '');
    // Done only once saved: refused (a name left empty, a parent under itself), it stays open as typed, saying why.
    const done = (id: string | null) => {
      if (id === null) return false;
      editing = null;
      forget(code.id);
      draw();
      return true;
    };
    box.append(
      el('label', { text: 'Name ' }, label),
      el('label', { text: 'Means ' }, definition),
      el('label', { text: 'Colour ' }, colour),
      el('label', { text: 'Under ' }, parent),
      el('div', { cls: 'kuraa-actions' }, button('Save', () => void change({ op: 'change', id: code.id, label: label.value, definition: definition.value, color: colour.value, broader: parent.value || null }).then(done), 'codes-save')),
    );
    const into = el('select', { testid: 'codes-merge-into' }) as HTMLSelectElement;
    for (const { code: c, depth } of others) {
      const o = el('option', { text: `${'  '.repeat(depth)}${c.label}` });
      o.value = c.id;
      into.append(o);
    }
    if (others.length) {
      kept(into, `into:${code.id}`, others[0]!.code.id);
      box.append(el('div', { cls: 'kuraa-actions' }, el('label', { text: 'Merge into ' }, into), button('Merge', () => void pctx.ui.askConfirm(`Merge “${code.label}” into the code chosen? Passages coded with it count as that code’s, everyone’s.`, 'Merge').then((ok) => {
        if (!ok) return;
        void change({ op: 'merge', id: code.id, into: into.value }).then((id) => {
          if (done(id)) void loadCounts();
        });
      }), 'codes-merge')));
    }
    box.append(el('div', { cls: 'kuraa-actions' }, button('Delete…', () => void pctx.ui.askConfirm(`Delete the code “${code.label}”? Codes under it move up. It is kept in the codebook, marked deleted, so passages coded with it (everyone’s own) still say what they were.`, 'Delete', true).then((ok) => {
      if (!ok) return;
      void change({ op: 'delete', id: code.id }).then((id) => {
        if (done(id)) void loadCounts();
      });
    }), 'codes-delete', 'danger')));
    return box;
  }

  codes.listeners.add(draw);
  draw();
  void loadCounts();
  const off = pctx.onDocument(() => countsSoon());
  return () => {
    clearTimeout(countsTimer);
    off();
    codes.listeners.delete(draw);
    body.remove();
  };
}

/** Every passage coded with a code (and those under it, if asked), across the workspace, each opening at its passage. */
function mountRetrieve(root: HTMLElement, pctx: FeaturePanelContext): () => void {
  injectStyle();
  const body = el('div', { cls: 'kuraa-comments', testid: 'annotations-retrieve' });
  root.append(viewLink(pctx, '← Codes', 'annotations-to-codes', 'codes'), body);
  const codes = codesOf(pctx);
  let wanted = retrieveWanted;
  let rows: { path: string; person: string; id: string; code: string; by: string; created: string; quote: string | null; at: { from: number; to: number } | null }[] = [];
  let asked = 0;
  const load = async () => {
    const n = ++asked;
    if (!wanted) {
      rows = [];
      draw();
      return;
    }
    try {
      const got = (await pctx.request('GET', `retrieve?code=${encodeURIComponent(wanted.code)}&below=${wanted.below ? 1 : 0}`)) as unknown as typeof rows;
      if (n === asked) rows = got;
    } catch {
      if (n === asked) rows = [];
    }
    draw();
  };
  function draw() {
    body.replaceChildren();
    if (!coding(pctx)) {
      body.append(el('p', { cls: 'kuraa-note', text: 'Coding is off for this workspace.' }));
      return;
    }
    const tree = codeTree(codes.book);
    const pick = el('select', { testid: 'retrieve-code' }) as HTMLSelectElement;
    const none = el('option', { text: 'Choose a code' });
    none.value = '';
    pick.append(none);
    for (const { code, depth } of tree) {
      const o = el('option', { text: `${'  '.repeat(depth)}${code.label}` });
      o.value = code.id;
      pick.append(o);
    }
    pick.value = wanted?.code ?? '';
    pick.onchange = () => {
      wanted = pick.value ? { code: pick.value, below: wanted?.below ?? true } : null;
      void load();
    };
    const below = el('input', { testid: 'retrieve-below' }) as HTMLInputElement;
    below.type = 'checkbox';
    below.checked = wanted?.below ?? true;
    below.onchange = () => {
      if (wanted) wanted = { ...wanted, below: below.checked };
      void load();
    };
    body.append(el('div', { cls: 'kuraa-bar' }, pick, el('label', {}, below, ' and the codes under it')));
    if (!wanted) return;
    body.append(el('p', { cls: 'kuraa-note', testid: 'retrieve-count', text: `${rows.length} passage${rows.length === 1 ? '' : 's'}` }));
    for (const r of rows) {
      const code = resolveCode(codes.book, r.code);
      const row = el('button', { cls: 'kuraa-recent', testid: 'retrieve-row' });
      row.type = 'button';
      row.append(el('span', { cls: 'kuraa-meta', text: `${r.path} · ${r.by || 'Someone'}${code && code.id !== wanted.code ? ` · ${code.label}` : ''}` }));
      if (r.quote) row.append(el('blockquote', { text: r.quote }));
      row.onclick = () => pctx.openFile(r.path, r.at ?? undefined);
      body.append(row);
    }
  }
  const follow = () => {
    wanted = retrieveWanted;
    void load();
  };
  retrieveListeners.add(follow);
  codes.listeners.add(draw);
  void load();
  return () => {
    retrieveListeners.delete(follow);
    codes.listeners.delete(draw);
    body.remove();
  };
}

/** A small square of a code's colour. */
const swatch = (color: string | undefined) => {
  const s = el('span', { cls: 'kuraa-swatch' });
  s.style.background = color ?? '#888';
  return s;
};

/** Settings › Components, under Annotations (drawn in its row): comments and coding, each on or off for the workspace. */
function mountSettings(root: HTMLElement, ctx: FeatureClientContext): () => void {
  injectStyle();
  const body = el('div', { cls: 'kuraa-settings' });
  const choice = (key: 'comments' | 'coding', name: string, about: string, on: () => boolean, said: (on: boolean) => string) => {
    const box = el('input', { testid: `annotations-${key}` }) as HTMLInputElement;
    box.type = 'checkbox';
    box.checked = on();
    box.disabled = !ctx.status().mayChange;
    box.setAttribute('aria-label', name);
    box.onchange = async () => {
      box.disabled = true;
      try {
        await ctx.saveSettings({ ...ctx.status().settings, [key]: box.checked });
        ctx.notify(said(box.checked));
      } catch (e) {
        box.checked = !box.checked;
        ctx.notify((e as Error).message, 'warn');
      } finally {
        box.disabled = !ctx.status().mayChange;
      }
    };
    return el('label', { cls: 'kuraa-switch' }, box, el('span', { cls: 'kuraa-switch-text' }, el('span', { cls: 'kuraa-switch-name', text: name }), el('span', { cls: 'kuraa-meta', text: about })));
  };
  body.append(
    choice('comments', 'Comments', 'Select text and press ⌥⌘M (or Comment) to comment on it; reply to anyone’s.', () => commenting(ctx),
      (on) => (on ? 'Comments are on for this workspace.' : 'Comments are off for this workspace. Those made are kept.')),
    choice('coding', 'Coding', `Select text, or put the caret anywhere, and type # to code it. The codebook is ${codesOf(ctx).path}, everyone’s; each person’s codings are their own.`, () => coding(ctx),
      (on) => (on ? 'Coding is on for this workspace.' : 'Coding is off for this workspace. Codings and the codebook are kept.')),
  );
  root.append(body);
  return () => body.remove();
}

let styled = false;
/** Its styles, once, in the app's colours. */
function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const css = `
.kuraa-commented { background: color-mix(in srgb, var(--accent, #c08a00) 16%, transparent); border-bottom: 2px solid color-mix(in srgb, var(--accent, #c08a00) 45%, transparent); }
.kuraa-commented-focus { background: color-mix(in srgb, var(--accent, #c08a00) 30%, transparent); }
.kuraa-comments { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 24px; overflow: auto; font: 13px/1.45 var(--font, system-ui); }
.kuraa-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.kuraa-thread { border: 1px solid var(--border, #ddd); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.kuraa-focus { border-color: var(--accent, #c08a00); box-shadow: 0 0 0 1px var(--accent, #c08a00); }
.kuraa-quote { all: unset; cursor: pointer; color: var(--muted, #666); font-style: italic; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.kuraa-quote:hover, .kuraa-quote:focus-visible { color: inherit; text-decoration: underline; }
.kuraa-comments blockquote { margin: 0; padding-left: 8px; border-left: 3px solid var(--border, #ddd); color: var(--muted, #666); font-style: italic; }
.kuraa-reply { margin-left: 12px; padding-left: 8px; border-left: 2px solid var(--border, #ddd); }
.kuraa-meta { color: var(--muted, #666); font-size: 12px; }
.kuraa-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.kuraa-note { color: var(--muted, #666); margin: 0; }
.kuraa-view-link { display: block; border: 0; background: none; padding: 6px 10px 0; color: var(--accent, #2e6b5a); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.kuraa-view-link:hover { text-decoration: underline; }
.kuraa-actions { display: flex; gap: 6px; }
.kuraa-composer { display: flex; flex-direction: column; gap: 6px; }
.kuraa-composer textarea { min-height: 64px; resize: vertical; font: inherit; padding: 6px; border: 1px solid var(--border, #ddd); border-radius: 4px; background: var(--bg, #fff); color: inherit; }
.kuraa-lost summary { cursor: pointer; color: var(--muted, #666); }
.kuraa-recent { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border, #ddd); border-radius: 6px; }
.kuraa-recent:hover, .kuraa-recent:focus-visible { border-color: var(--accent, #c08a00); }
.kuraa-coded-hover { background: color-mix(in srgb, var(--kuraa-code, #888) 24%, transparent); box-shadow: 0 2px 0 color-mix(in srgb, var(--kuraa-code, #888) 70%, transparent); border-radius: 2px; }
.kuraa-now { background: var(--selected, color-mix(in srgb, var(--accent, #c08a00) 22%, transparent)); }
.kuraa-point { display: inline-block; width: 3px; height: 1.15em; margin: 0 -1.5px; vertical-align: -0.2em; border-radius: 2px; background: var(--kuraa-code, #888); pointer-events: none; }
.kuraa-codebox { position: fixed; z-index: 50; min-width: 240px; max-width: 360px; padding: 4px; background: var(--bg, #fff); color: var(--text, inherit); border: 1px solid var(--border, #ddd); border-radius: 8px; box-shadow: 0 6px 24px rgb(0 0 0 / 16%); font: 13px/1.4 var(--font, system-ui); }
.kuraa-codebox-input { display: flex; align-items: center; gap: 2px; padding: 2px 6px; border-bottom: 1px solid var(--border, #ddd); margin-bottom: 3px; }
.kuraa-codebox-hash { color: var(--muted, #666); font-weight: 600; }
.kuraa-codebox-input input { flex: 1; min-width: 0; border: 0; outline: none; background: none; color: inherit; font: inherit; padding: 4px 2px; }
.kuraa-codebox-list { display: flex; flex-direction: column; max-height: 240px; overflow: auto; }
.kuraa-codebox-row { display: flex; align-items: center; gap: 0; padding: 4px 6px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.kuraa-codebox-row.selected, .kuraa-codebox-row:hover { background: var(--accent-soft, #eee); }
.kuraa-codebox-label { overflow: hidden; text-overflow: ellipsis; }
.kuraa-codebox-parents { margin-left: auto; padding-left: 10px; color: var(--muted, #666); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.kuraa-codebox-plus { width: 10px; margin-right: 6px; text-align: center; color: var(--muted, #666); font-weight: 600; }
.kuraa-codebox-empty { padding: 4px 6px; color: var(--muted, #666); }
.kuraa-codebox-hint { padding: 4px 6px 2px; color: var(--muted, #666); font-size: 11px; border-top: 1px solid var(--border, #ddd); margin-top: 3px; }
.kuraa-card { width: 320px; min-width: 0; max-width: calc(100vw - 16px); padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.kuraa-card-head { color: var(--muted, #666); font-size: 12px; }
.kuraa-card-quote { color: var(--muted, #666); font-size: 12px; font-style: italic; border-left: 2px solid var(--accent, #c08a00); padding-left: 6px; overflow-wrap: anywhere; }
.kuraa-card-entry { display: flex; flex-direction: column; gap: 2px; }
.kuraa-card-reply { margin-left: 8px; padding-left: 8px; border-left: 2px solid var(--border, #ddd); }
.kuraa-card-tools { display: flex; gap: 10px; }
.kuraa-card-link { all: unset; cursor: pointer; color: var(--muted, #666); font-size: 12px; }
.kuraa-card-link:hover, .kuraa-card-link:focus-visible { color: var(--text, inherit); text-decoration: underline; }
.kuraa-card-link.danger:hover { color: var(--danger, #b42318); }
.kuraa-card-composer { display: flex; flex-direction: column; gap: 4px; }
.kuraa-card-composer textarea { resize: none; font: inherit; line-height: 1.4; padding: 5px 8px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg, #fff); color: inherit; outline: none; }
.kuraa-card-composer textarea:focus { border-color: var(--accent, #c08a00); }
.kuraa-card-actions { display: flex; align-items: center; gap: 10px; }
.kuraa-card-hint { margin-right: auto; color: var(--muted, #666); font-size: 11.5px; }
.kuraa-card-send { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 5px; border: 1px solid var(--accent, #c08a00); background: var(--accent, #c08a00); color: var(--bg, #fff); cursor: pointer; }
.kuraa-card-send:disabled { opacity: 0.45; cursor: default; }
.kuraa-card-foot { border-top: 1px solid var(--border, #ddd); padding-top: 6px; }
.kuraa-switch { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 8px; align-items: start; cursor: pointer; }
.kuraa-switch > input { margin: 3px 0 0; }
.kuraa-switch-text { display: grid; gap: 1px; min-width: 0; }
.kuraa-codemenu { display: flex; flex-direction: column; gap: 2px; padding: 6px; outline: none; }
.kuraa-codemenu-title { display: flex; align-items: center; font-weight: 600; padding: 2px 4px; }
.kuraa-codemenu-line { color: var(--muted, #666); font-size: 12px; padding: 0 4px 2px; overflow-wrap: anywhere; }
.kuraa-codemenu-item { all: unset; cursor: pointer; padding: 4px 6px; border-radius: 4px; }
.kuraa-codemenu-item:first-of-type { margin-top: 4px; }
.kuraa-codemenu-item:hover, .kuraa-codemenu-item:focus-visible { background: var(--accent-soft, #eee); }
.kuraa-codemenu-item.danger { color: var(--danger, #b42318); }
.kuraa-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: baseline; flex: none; }
.kuraa-code { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; border-bottom: 1px solid var(--border, #ddd); }
.kuraa-code-head { display: flex; align-items: center; gap: 6px; }
.kuraa-code-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kuraa-code-list { display: flex; flex-direction: column; max-height: 220px; overflow: auto; }
.kuraa-code-choice { all: unset; cursor: pointer; display: flex; align-items: center; padding: 3px 6px; border-radius: 4px; }
.kuraa-code-choice:hover, .kuraa-code-choice:focus-visible { background: var(--accent-soft, #eee); }
.kuraa-codes input:not([type]), .kuraa-codes select { font: inherit; padding: 4px 6px; border: 1px solid var(--border, #ddd); border-radius: 4px; background: var(--bg, #fff); color: inherit; }
.kuraa-codes label { display: flex; gap: 6px; align-items: center; }
.kuraa-error { color: var(--danger, #b42318); }
.kuraa-settings { display: flex; flex-direction: column; gap: 6px; }
.kuraa-check { display: flex; gap: 6px; align-items: center; }
`;
  const style = document.createElement('style');
  style.dataset.feature = 'annotations';
  style.textContent = css;
  document.head.append(style);
}

export const annotationsClient = defineClientFeature({
  id: 'annotations',
  editor,
  helpGroup: 'Comments and coding',
  // Done in the open document, by its editor (commands, in editor()), with the focus there.
  commands: [
    { id: 'comment', label: 'Comment', keys: COMMENT_KEYS, about: 'editor', help: 'Comment on the selected text, in a box beside it (↵ saves)' },
    { id: 'code', label: 'Code #', keys: CODE_KEYS, about: 'editor', help: 'Code the selected text, or the point at the caret, as typing # does (where the workspace codes)' },
  ],
  panels: [
    { id: 'comments', label: 'Comments', about: 'document', keys: PANEL_KEYS, help: 'Show the document’s comments', mount: mountComments },
    { id: 'recent', label: 'Recent comments', about: 'workspace', mount: mountRecent },
    { id: 'codes', label: 'Codes', about: 'workspace', mount: mountCodes },
    { id: 'retrieve', label: 'Retrieve', about: 'workspace', mount: mountRetrieve },
  ],
  documentMenu: (ctx) => [
    ...(commenting(ctx) ? [
      { command: 'panel:comments', testid: 'menu-comments' },
    ] : []),
    ...(coding(ctx) ? [
      { command: 'panel:codes', testid: 'menu-codes' },
    ] : []),
  ],
  settings: { workspace: { label: 'Annotations', inline: true, mount: mountSettings } },
});

export const clients = { annotations: annotationsClient };
