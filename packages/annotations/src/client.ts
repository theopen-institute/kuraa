// The annotations feature's client half (./index has its host half): comments
// and replies, on passages and documents (docs/decisions/0082-annotations.md).
//
// - In the document: commented passages tinted, and a 💬 in the margin at each,
//   which opens its thread; Comment beside a selection (⌥⌘M), in any document
//   you read, whether or not you may change it.
// - The Comments panel (⌥⌘K): the document's threads in order, each comment
//   with its replies; reply, and edit or delete your own; comment on the whole
//   document; whose are shown (everyone's, or yours: your choice, in this
//   browser); and those no longer found, whose passages are gone.
// - Recent comments (a panel of the workspace): everyone's newest, each opening
//   at its passage.
// - Coding (where the workspace codes, step 3): Code beside a selection (⌥⌘U);
//   coded passages underlined in their codes' colours, a mark for each in the
//   margin; the Codes panel (the codebook as a tree, with counts: add, rename,
//   define, colour, nest, merge, delete; apply one to the passage selected; the
//   codings at a passage, removing your own); the Retrieve panel (every passage
//   coded with a code, and those under it, across the workspace).
//
// Yours are in the room, changed live; everyone else's are in the room while a
// device of theirs is, else read from their files and found again by quote.
// Drawn with the DOM alone: a feature does not depend on the client's framework.
import { keymap } from 'prosemirror-keymap';
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';
import { defineClientFeature, type FeatureClientContext, type FeatureEditorContext, type FeaturePanelContext, type Json } from '@kuraa/feature-kit/client';
import { SUFFIX, aboutOf, codeOf, creatorOf, findPassage, kindOf, readPage, textOf, type About, type Item } from './format.js';
import { codeTree, resolveCode, type Code, type Codebook } from './codebook.js';
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
  /** A comment being written on a passage: anchors at its ends, and its quote. */
  pending: { from: Json; to: Json; quote: string } | null;
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
  /** A passage being coded: anchors at its ends, and its quote. */
  coding: { from: Json; to: Json; quote: string } | null;
  /** The passage whose codings are shown (its mark in the margin was clicked): where it starts. */
  codedAt: number | null;
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
    path: 'codebook.jsonld',
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
        const found = from !== null && to !== null && to > from && to <= doc.content.size;
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
          shown.push({ id: String(item.id), person: f.person, mine: state?.me === f.person, item, kind: kindOf(item), about, from: at ? map.toDoc(at.from) : null, to: at ? map.toDoc(at.to, -1) : null, lost: about?.kind === 'passage' && !at });
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

/** Begin a comment on what is selected: the panel opens with it. */
function startComment(store: Store, state: EditorState): boolean {
  const room = store.ctx.state;
  const { from, to, empty } = state.selection;
  if (!room || empty) return false;
  const quote = state.doc.textBetween(from, to, ' ');
  if (!quote.trim()) return false;
  store.pending = { from: room.anchorAt(from, 1), to: room.anchorAt(to, -1), quote };
  store.onDocument = false;
  store.focus = null;
  store.ctx.openPanel('comments');
  tell(store);
  return true;
}

/** Begin coding what is selected: the Codes panel opens with it, to apply a code. */
function startCoding(store: Store, state: EditorState): boolean {
  const room = store.ctx.state;
  const { from, to, empty } = state.selection;
  if (!room || empty) return false;
  const quote = state.doc.textBetween(from, to, ' ');
  if (!quote.trim()) return false;
  store.coding = { from: room.anchorAt(from, 1), to: room.anchorAt(to, -1), quote };
  store.codedAt = null;
  store.ctx.openPanel('codes');
  tell(store);
  return true;
}

function editor(ctx: FeatureEditorContext) {
  const store: Store = { ctx, view: null, files: [], pending: null, onDocument: false, replyTo: null, editing: null, drafts: new Map(), focus: null, listeners: new Set(), cached: { doc: null, shown: [] }, coding: null, codedAt: null };
  const codes = codesOf(ctx);
  // Only the live document's is its panel's (a past version's is its own).
  if (ctx.state) stores.set(ctx.path, store);
  let liveKey = '';
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
        const decos = shown.filter((s) => s.kind === 'comment').map((s) =>
          Decoration.inline(s.from!, s.to!, { class: s.id === store.focus ? 'kuraa-commented kuraa-commented-focus' : 'kuraa-commented', 'data-annotation': s.id }));
        // Coded passages: underlined in their codes' colours (where the workspace codes).
        if (coding(ctx)) {
          for (const s of shown) {
            if (s.kind !== 'coding') continue;
            const code = codeFor(codes, s.item);
            decos.push(Decoration.inline(s.from!, s.to!, { class: 'kuraa-coded', style: `--kuraa-code: ${code?.color ?? '#888'}`, title: code ? code.label : 'A code no longer in the codebook', 'data-annotation': s.id }));
          }
        }
        return DecorationSet.create(state.doc, decos);
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
        destroy: () => {
          off?.();
          store.listeners.delete(redraw);
          codes.listeners.delete(redraw);
          if (stores.get(ctx.path) === store) stores.delete(ctx.path);
        },
      };
    },
  });
  return {
    plugins: () => [plugin, keymap({ [COMMENT_KEYS]: (state: EditorState) => startComment(store, state), [CODE_KEYS]: (state: EditorState) => coding(ctx) && startCoding(store, state) })],
    margin: (view: EditorView) => {
      const shown = collect(store, view.state.doc).filter((s) => s.from !== null);
      const items = shown.filter((s) => s.kind === 'comment').map((s) => ({
        key: s.id,
        pos: s.from!,
        label: '💬',
        title: `${creatorOf(s.item) || 'Someone'}: ${textOf(s.item)}`,
        run: () => {
          store.focus = s.id;
          ctx.openPanel('comments');
          tell(store);
        },
      }));
      if (!coding(ctx)) return items;
      // One mark per coded passage start, in its first code's colour, saying every code there.
      const byStart = new Map<number, Shown[]>();
      for (const s of shown) if (s.kind === 'coding') byStart.set(s.from!, [...(byStart.get(s.from!) ?? []), s]);
      for (const [pos, list] of byStart) {
        const labels = list.map((s) => codeFor(codes, s.item)?.label ?? 'A code no longer in the codebook');
        items.push({
          key: `coded:${pos}`,
          pos,
          label: list.length > 1 ? `●${list.length}` : '●',
          title: `Coded: ${[...new Set(labels)].join(', ')}`,
          color: codeFor(codes, list[0]!.item)?.color,
          run: () => {
            store.codedAt = pos;
            store.coding = null;
            ctx.openPanel('codes');
            tell(store);
          },
        } as (typeof items)[number] & { color?: string });
      }
      return items;
    },
    selectionActions: (view: EditorView) => (ctx.state ? [
      { label: 'Comment', keys: COMMENT_KEYS, testid: 'annotations-comment', run: () => void startComment(store, view.state) },
      ...(coding(ctx) ? [{ label: 'Code', keys: CODE_KEYS, testid: 'annotations-code', run: () => void startCoding(store, view.state) }] : []),
    ] : []),
    destroy: () => {
      if (stores.get(ctx.path) === store) stores.delete(ctx.path);
    },
  };
}

// ---------------------------------------------------------------------------
// The Comments panel

/** A new annotation of this person's. */
function newItem(ctx: FeatureClientContext, me: string, motivation: 'commenting' | 'replying', value: string, target: Json): Item {
  const now = new Date().toISOString();
  return {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: 'Annotation',
    motivation,
    created: now,
    modified: now,
    creator: { id: `urn:kuraa:person:${me}`, type: 'Person', name: ctx.person().name },
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
  root.append(body);
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
      s.pending = null;
      tell(s);
    }, 'annotations-on-document') : null, el('label', { text: 'Show ' }, whose)));
    if (!state) body.append(el('p', { cls: 'kuraa-note', text: 'Your comments are not kept here: this computer has no identity of yours yet, or the document is opened where comments are not kept.' }));

    // Writing a comment: on the passage selected, or on the document.
    if (s.pending && state) {
      const p = s.pending;
      body.append(el('div', { cls: 'kuraa-thread kuraa-new' }, el('blockquote', { text: p.quote }), composer('new:passage', 'Your comment', (text) => {
        const item = newItem(pctx, me!, 'commenting', text, { source: `../${name}`, selector: [{ type: 'TextQuoteSelector', exact: p.quote }] });
        state.update({ set: { [String(item.id)]: { item, from: p.from, to: p.to } as unknown as Json } });
        s.pending = null;
        s.focus = String(item.id);
        tell(s);
      }, () => {
        s.pending = null;
        tell(s);
      })));
    }
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
          const was = state.entries()[a.id] as unknown as RoomAnnotation | undefined;
          if (was) {
            const b = (was.item.body && typeof was.item.body === 'object' && !Array.isArray(was.item.body) ? was.item.body : {}) as { [k: string]: Json };
            state.update({ set: { [a.id]: { ...was, item: { ...was.item, body: { ...b, value: text }, modified: new Date().toISOString() } } as unknown as Json } });
          }
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
    if (!comments.length && !s.pending && !s.onDocument) list.append(el('p', { cls: 'kuraa-note', text: 'No comments yet. Select some text, then Comment (or press ⌥⌘M).' }));
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
  root.append(body);
  let live = true;
  const draw = async () => {
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
    creator: { id: `urn:kuraa:person:${me}`, type: 'Person', name: ctx.person().name },
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
  root.append(body);
  const codes = codesOf(pctx);
  let counts: { [id: string]: number } = {};
  let filter = '';
  let editing: string | null = null;
  let error: string | null = null;
  let store: Store | null = null;
  /** The passage the find box was last given the focus for: given it once, as it appears, never taken back on a redraw. */
  let focusedFor: object | null = null;
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
  const apply = (code: string) => {
    const s = store;
    const state = pctx.state();
    if (!s?.coding || !state) return;
    const name = pctx.path()!.slice(pctx.path()!.lastIndexOf('/') + 1);
    const item = newCoding(pctx, state.me, code, s.coding.quote, `../${name}`);
    state.update({ set: { [String(item.id)]: { item, from: s.coding.from, to: s.coding.to } as unknown as Json } });
    s.coding = null;
    filter = '';
    tell(s);
    countsSoon();
  };

  function draw() {
    const now = stores.get(pctx.path() ?? '') ?? null;
    if (now !== store) {
      store?.listeners.delete(draw);
      store = now;
      store?.listeners.add(draw);
    }
    // Where the focus is, to put it back once drawn again.
    const active = document.activeElement as (HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null }) | null;
    const focusKey = active && body.contains(active) ? active.dataset.key ?? null : null;
    const caret = focusKey ? [active!.selectionStart ?? null, active!.selectionEnd ?? null] as const : null;
    body.replaceChildren();
    if (!coding(pctx)) {
      body.append(el('p', { cls: 'kuraa-note', text: 'Coding is off for this workspace. Turn it on in Settings › Workspace, under Annotations.' }));
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
    const s = store;
    const state = pctx.state();

    // Coding the passage selected: a code to apply, found by name, or made.
    if (s?.coding && state) {
      const box = el('div', { cls: 'kuraa-thread kuraa-new', testid: 'codes-apply-box' });
      box.append(el('blockquote', { text: s.coding.quote }));
      const find = el('input', { testid: 'codes-filter' }) as HTMLInputElement;
      find.dataset.key = 'find';
      find.placeholder = 'Find a code, or name a new one';
      find.value = filter;
      find.oninput = () => {
        filter = find.value;
        draw();
      };
      find.onkeydown = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          s.coding = null;
          tell(s);
        }
      };
      box.append(find);
      const wanted = filter.trim().toLowerCase();
      const matching = tree.filter(({ code }) => !wanted || code.label.toLowerCase().includes(wanted));
      const list = el('div', { cls: 'kuraa-code-list' });
      for (const { code, depth } of matching.slice(0, 40)) {
        const b = button(code.label, () => apply(code.id), 'codes-apply', 'kuraa-code-choice');
        b.style.paddingLeft = `${6 + depth * 12}px`;
        b.prepend(swatch(code.color));
        list.append(b);
      }
      box.append(list);
      if (wanted && !tree.some(({ code }) => code.label.toLowerCase() === wanted)) {
        box.append(button(`New code “${filter.trim()}”, applied`, () => void change({ op: 'add', label: filter.trim() }).then((id) => id && apply(id)), 'codes-create-apply'));
      }
      box.append(el('div', { cls: 'kuraa-actions' }, button('Cancel', () => {
        s.coding = null;
        tell(s);
      }, 'codes-cancel')));
      body.append(box);
      if (focusedFor !== s.coding) {
        focusedFor = s.coding;
        queueMicrotask(() => {
          if (!find.isConnected) return;
          find.focus();
          find.setSelectionRange(find.value.length, find.value.length);
        });
      } else if (document.activeElement === body.ownerDocument.body) {
        // Drawn again while it was being typed in: the focus back where it was.
        queueMicrotask(() => find.isConnected && find.focus());
      }
    }

    // The codings at a passage (its mark in the margin): each person's, yours to remove.
    if (s?.codedAt !== null && s?.codedAt !== undefined && s.view) {
      const here = collect(s, s.view.state.doc).filter((a) => a.kind === 'coding' && a.from === s.codedAt);
      if (here.length) {
        const box = el('div', { cls: 'kuraa-thread', testid: 'codes-here' });
        const about = here[0]!.about;
        if (about?.kind === 'passage') box.append(el('blockquote', { text: about.exact }));
        for (const a of here) {
          const code = codeFor(codes, a.item);
          const row = el('div', { cls: 'kuraa-comment', testid: 'codes-here-row' });
          row.append(el('div', {}, swatch(code?.color), el('span', { text: ` ${code?.label ?? 'A code no longer in the codebook'}` })), el('div', { cls: 'kuraa-meta', text: `${creatorOf(a.item) || 'Someone'} · ${when(String(a.item.created ?? ''))}` }));
          if (a.mine && state) row.append(el('div', { cls: 'kuraa-actions' }, button('Remove', () => {
            state.update({ remove: [a.id] });
            tell(s);
            countsSoon();
          }, 'codes-remove', 'danger')));
          box.append(row);
        }
        body.append(box);
      }
    }

    // The codebook: a tree, each with its count; add, and change each.
    const list = el('div', { cls: 'kuraa-codebook', testid: 'codes-tree' });
    if (!tree.length) list.append(el('p', { cls: 'kuraa-note', text: 'No codes yet: add one below, or select some text, then Code (⌥⌘U).' }));
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
  const off = pctx.onDocument(() => {
    const now = stores.get(pctx.path() ?? '') ?? null;
    if (now !== store) draw();
    countsSoon();
  });
  return () => {
    clearTimeout(countsTimer);
    off();
    codes.listeners.delete(draw);
    store?.listeners.delete(draw);
    body.remove();
  };
}

/** Every passage coded with a code (and those under it, if asked), across the workspace, each opening at its passage. */
function mountRetrieve(root: HTMLElement, pctx: FeaturePanelContext): () => void {
  injectStyle();
  const body = el('div', { cls: 'kuraa-comments', testid: 'annotations-retrieve' });
  root.append(body);
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

/** Settings › Workspace › Annotations: whether the workspace codes. */
function mountSettings(root: HTMLElement, ctx: FeatureClientContext): () => void {
  injectStyle();
  const body = el('div', { cls: 'kuraa-settings' });
  const box = el('input', { testid: 'annotations-coding' }) as HTMLInputElement;
  box.type = 'checkbox';
  box.checked = coding(ctx);
  box.disabled = !ctx.status().mayChange;
  box.onchange = async () => {
    box.disabled = true;
    try {
      await ctx.saveSettings({ ...ctx.status().settings, coding: box.checked });
      ctx.notify(box.checked ? 'Coding is on for this workspace.' : 'Coding is off for this workspace. Codings and the codebook are kept.');
    } catch (e) {
      box.checked = !box.checked;
      ctx.notify((e as Error).message, 'warn');
    } finally {
      box.disabled = !ctx.status().mayChange;
    }
  };
  body.append(
    el('label', { cls: 'kuraa-check' }, box, ' Coding: a codebook, and passages coded with it'),
    el('p', { cls: 'kuraa-note', text: `Comments are on wherever Annotations is. Coding is a method a project chooses: its codebook is ${codesOf(ctx).path}, in the workspace, everyone’s; each person’s codings are their own, beside each document.` }),
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
.kuraa-actions { display: flex; gap: 6px; }
.kuraa-composer { display: flex; flex-direction: column; gap: 6px; }
.kuraa-composer textarea { min-height: 64px; resize: vertical; font: inherit; padding: 6px; border: 1px solid var(--border, #ddd); border-radius: 4px; background: var(--bg, #fff); color: inherit; }
.kuraa-lost summary { cursor: pointer; color: var(--muted, #666); }
.kuraa-recent { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border, #ddd); border-radius: 6px; }
.kuraa-recent:hover, .kuraa-recent:focus-visible { border-color: var(--accent, #c08a00); }
.kuraa-coded { text-decoration: underline; text-decoration-color: var(--kuraa-code, #888); text-decoration-thickness: 2px; text-underline-offset: 3px; text-decoration-skip-ink: none; }
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
  panels: [
    { id: 'comments', label: 'Comments', about: 'document', keys: PANEL_KEYS, mount: mountComments },
    { id: 'recent', label: 'Recent comments', about: 'workspace', mount: mountRecent },
    { id: 'codes', label: 'Codes', about: 'workspace', mount: mountCodes },
    { id: 'retrieve', label: 'Retrieve', about: 'workspace', mount: mountRetrieve },
  ],
  documentMenu: (ctx) => [
    { label: 'Comments', keys: PANEL_KEYS, testid: 'menu-comments', run: () => ctx.openPanel('comments') },
    { label: 'Recent comments', testid: 'menu-recent-comments', run: () => ctx.openPanel('recent') },
    ...(coding(ctx) ? [
      { label: 'Codes', testid: 'menu-codes', run: () => ctx.openPanel('codes') },
      { label: 'Retrieve coded passages', testid: 'menu-retrieve', run: () => ctx.openPanel('retrieve') },
    ] : []),
  ],
  settings: { workspace: { label: 'Annotations', mount: mountSettings } },
  help: [
    { group: 'Comments and coding', keys: [COMMENT_KEYS], does: 'Comment on the selected text' },
    { group: 'Comments and coding', keys: [PANEL_KEYS], does: 'Show the document’s comments' },
    { group: 'Comments and coding', keys: [CODE_KEYS], does: 'Code the selected text (where the workspace codes)' },
  ],
});

export const clients = { annotations: annotationsClient };
