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
//
// Yours are in the room, changed live; everyone else's are in the room while a
// device of theirs is, else read from their files and found again by quote.
// Drawn with the DOM alone: a feature does not depend on the client's framework.
import { keymap } from 'prosemirror-keymap';
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';
import { defineClientFeature, type FeatureClientContext, type FeatureEditorContext, type FeaturePanelContext, type Json } from '@kuraa/feature-kit/client';
import { SUFFIX, aboutOf, creatorOf, findPassage, kindOf, readPage, textOf, type About, type Item } from './format.js';
import type { RoomAnnotation } from './index.js';

const COMMENT_KEYS = 'Mod-Alt-m';
const PANEL_KEYS = 'Mod-Alt-k';

/** An annotation as shown: whose, where it is in the document now (if it is about a passage that is found). */
interface Shown {
  id: string;
  person: string;
  mine: boolean;
  item: Item;
  kind: 'comment' | 'reply' | 'other';
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
}

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

function editor(ctx: FeatureEditorContext) {
  const store: Store = { ctx, view: null, files: [], pending: null, onDocument: false, replyTo: null, editing: null, drafts: new Map(), focus: null, listeners: new Set(), cached: { doc: null, shown: [] } };
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
        const decos = collect(store, state.doc).filter((s) => s.kind === 'comment' && s.from !== null && s.to !== null && s.to <= size).map((s) =>
          Decoration.inline(s.from!, s.to!, { class: s.id === store.focus ? 'kuraa-commented kuraa-commented-focus' : 'kuraa-commented', 'data-annotation': s.id }));
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
          if (stores.get(ctx.path) === store) stores.delete(ctx.path);
        },
      };
    },
  });
  return {
    plugins: () => [plugin, keymap({ [COMMENT_KEYS]: (state: EditorState) => startComment(store, state) })],
    margin: (view: EditorView) => collect(store, view.state.doc).filter((s) => s.kind === 'comment' && s.from !== null).map((s) => ({
      key: s.id,
      pos: s.from!,
      label: '💬',
      title: `${creatorOf(s.item) || 'Someone'}: ${textOf(s.item)}`,
      run: () => {
        store.focus = s.id;
        ctx.openPanel('comments');
        tell(store);
      },
    })),
    selectionActions: (view: EditorView) => (ctx.state ? [{ label: 'Comment', keys: COMMENT_KEYS, testid: 'annotations-comment', run: () => void startComment(store, view.state) }] : []),
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
  ],
  documentMenu: (ctx) => [
    { label: 'Comments', keys: PANEL_KEYS, testid: 'menu-comments', run: () => ctx.openPanel('comments') },
    { label: 'Recent comments', testid: 'menu-recent-comments', run: () => ctx.openPanel('recent') },
  ],
  help: [
    { group: 'Comments', keys: [COMMENT_KEYS], does: 'Comment on the selected text' },
    { group: 'Comments', keys: [PANEL_KEYS], does: 'Show the document’s comments' },
  ],
});

export const clients = { annotations: annotationsClient };
