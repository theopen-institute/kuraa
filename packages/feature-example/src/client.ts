// The example feature's client half (./index has its host half): marks shown in
// the document and its margin, Mark beside a selection, a panel listing them,
// an item in the document's menu and in a file's, its settings for the
// workspace, and a line on the shortcuts sheet. Drawn with the DOM alone: a
// feature does not depend on the client's framework.
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { defineClientFeature, type FeatureEditorContext, type FeatureState, type Json } from '@kuraa/feature-kit/client';
import { SUFFIX, findQuote, readMarks } from './marks.js';
import type { Node } from 'prosemirror-model';
import type { RoomMark } from './index.js';

/** A mark as shown: where it is in the document now, and whose. */
interface Shown {
  id: string;
  from: number;
  to: number;
  quote: string;
  by: string;
  color: string;
  /** Yours: you may take it away. */
  mine: boolean;
}

/** The marks in one person's map in a live document, where they are now (lost ones are not shown in the text). */
function fromMap(state: FeatureState, entries: { [key: string]: Json }, mine: boolean): Shown[] {
  const out: Shown[] = [];
  for (const [id, v] of Object.entries(entries)) {
    const m = v as RoomMark;
    if (!m || typeof m !== 'object' || 'lost' in m) continue;
    const from = state.positionOf(m.from);
    const to = state.positionOf(m.to);
    if (from === null || to === null || to <= from) continue;
    out.push({ id, from, to, quote: m.quote, by: m.by, color: m.color, mine });
  }
  return out;
}

/** Everyone's marks in a live document: yours, and those of others in the room. */
function liveMarks(state: FeatureState): Shown[] {
  return [
    ...fromMap(state, state.entries(), true),
    ...Object.values(state.others()).flatMap((entries) => fromMap(state, entries, false)),
  ];
}

/** Marks from people's files (those with no device in the room, or a past version's), found in a document by their quotes. */
function fromFiles(files: { person: string; text: string }[], doc: Node, ctx: FeatureEditorContext): Shown[] {
  const text = ctx.type.serialize(doc);
  const map = ctx.sourceMap(doc);
  const out: Shown[] = [];
  for (const f of files) {
    for (const m of readMarks(f.text)) {
      const at = findQuote(text, m.quote, m.start);
      if (at === null) continue;
      out.push({ id: `${f.person}:${m.id}`, from: map.toDoc(at), to: map.toDoc(at + m.quote.length, -1), quote: m.quote, by: m.by, color: m.color, mine: false });
    }
  }
  return out;
}

const markKey = new PluginKey('example-marks');
const newId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const labelOf = (ctx: { status(): { settings: { [k: string]: Json } } }) => {
  const l = ctx.status().settings.label;
  return typeof l === 'string' && l ? l.slice(0, 3) : '●';
};

function select(view: EditorView, m: Shown) {
  const { doc } = view.state;
  if (m.to > doc.content.size) return;
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, m.from, m.to)).scrollIntoView());
}

/** The marks shown in an open document: live ones, and those from files, found again as the document changes. */
function marksOf(ctx: FeatureEditorContext) {
  let files: { person: string; text: string }[] = [];
  let found: { doc: Node | null; marks: Shown[] } = { doc: null, marks: [] };
  return {
    /** Read the files again (people come and go from the room). */
    async load() {
      files = await ctx.companions(SUFFIX);
      found = { doc: null, marks: [] };
    },
    all(doc: Node): Shown[] {
      const state = ctx.state;
      // People whose maps are in the room are shown live; the rest from their files.
      const live = state ? new Set([state.me, ...Object.keys(state.others())]) : new Set<string>();
      if (found.doc !== doc) found = { doc, marks: fromFiles(files.filter((f) => !live.has(f.person)), doc, ctx) };
      return [...(state ? liveMarks(state) : []), ...found.marks].sort((a, b) => a.from - b.from);
    },
  };
}

function editor(ctx: FeatureEditorContext) {
  const marks = marksOf(ctx);
  const plugin = new Plugin({
    key: markKey,
    props: {
      decorations: (state) => {
        const size = state.doc.content.size;
        return DecorationSet.create(state.doc, marks.all(state.doc).filter((m) => m.to <= size).map((m) =>
          Decoration.inline(m.from, m.to, { class: m.mine ? 'example-mark example-mark-mine' : 'example-mark', style: `background-color: ${m.color || '#e6b800'}33`, 'data-mark': m.id })));
      },
    },
    view: (view) => {
      // Drawn again when the marks change (here or by anyone in the room), after whatever changed them is done.
      let queued = false;
      const refresh = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(markKey, true));
        });
      };
      const reload = () => void marks.load().then(() => {
        refresh();
        ctx.redraw();
      });
      const off = ctx.state?.observe(() => {
        refresh();
      });
      reload();
      return { destroy: () => off?.() };
    },
  });
  return {
    plugins: () => [plugin],
    margin: (view: EditorView) => marks.all(view.state.doc).map((m) => ({
      key: m.id,
      pos: m.from,
      label: labelOf(ctx),
      color: m.color,
      title: `${m.by || 'Someone'} marked “${m.quote}”`,
      run: () => select(view, m),
    })),
    // Yours to mark, in a document you may change or not: what you mark is yours (0082). A command (0091):
    // its label and keys are the feature's `commands`; what it does in this document, here.
    selectionActions: () => (ctx.state ? [{ command: 'mark', testid: 'example-mark-selection' }] : []),
    commands: {
      mark: (view: EditorView) => {
        const state = ctx.state;
        const { from, to } = view.state.selection;
        const quote = view.state.doc.textBetween(from, to, ' ');
        if (!state || !quote.trim()) return false;
        const me = ctx.person();
        state.update({ set: { [newId()]: { from: state.anchorAt(from, 1), to: state.anchorAt(to, -1), quote, by: me.name, color: me.color } } });
        return true;
      },
    },
  };
}

export const marksClient = defineClientFeature({
  id: 'marks',
  editor,
  helpGroup: 'Marks (example)',
  // Commands (0091): one done in the open document by its editor, with keys the core binds there; one done
  // anywhere, offered in ＋ by the view below.
  commands: [
    { id: 'mark', label: 'Mark', keys: 'Mod-Alt-y', about: 'editor', help: 'Mark the selected text' },
    { id: 'hello', label: 'Say hello (example)', run: (ctx) => ctx.notify(`Hello from ${ctx.status().label}.`) },
  ],
  panels: [{
    id: 'marks',
    label: 'Marks',
    about: 'document',
    keys: 'Mod-Alt-j',
    help: 'Show the marks in this document',
    mount(el, ctx) {
      const list = document.createElement('ul');
      list.className = 'example-marks';
      list.dataset.testid = 'example-marks';
      el.append(list);
      const draw = () => {
        const state = ctx.state();
        const view = ctx.view();
        list.replaceChildren();
        if (!state) {
          const li = document.createElement('li');
          li.textContent = 'This document keeps no marks here.';
          list.append(li);
          return;
        }
        const shown = liveMarks(state);
        if (!shown.length) {
          const li = document.createElement('li');
          li.textContent = 'No marks yet: select some text, then Mark.';
          list.append(li);
        }
        for (const m of shown) {
          const li = document.createElement('li');
          li.dataset.testid = 'example-mark-row';
          const go = document.createElement('button');
          go.type = 'button';
          go.textContent = `“${m.quote}”`;
          go.title = `${m.by}: go to it`;
          go.onclick = () => view && select(view, m);
          li.append(go);
          // Only your own are yours to take away (0082).
          if (m.mine) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.dataset.testid = 'example-mark-remove';
            remove.onclick = () => state.update({ remove: [m.id] });
            li.append(' ', remove);
          } else li.append(` (${m.by})`);
          list.append(li);
        }
      };
      draw();
      const off = ctx.onDocument(draw);
      return () => off();
    },
  }],
  documentMenu: () => [{ command: 'panel:marks', testid: 'menu-example-marks' }],
  // A navigation view (0087): the workspace's documents, as a plain list, drawn wherever the layout in use puts views.
  views: [{
    id: 'marked',
    label: 'Documents (example)',
    mount(el, ctx) {
      const list = document.createElement('ul');
      list.dataset.testid = 'example-view';
      el.append(list);
      const draw = () => {
        list.replaceChildren(...ctx.files().filter((f) => f.type && 'title' in f).map((f) => {
          const li = document.createElement('li');
          const open = document.createElement('button');
          open.type = 'button';
          open.textContent = f.title || f.path;
          open.dataset.testid = `example-view:${f.path}`;
          open.onclick = () => ctx.open(f.path);
          li.append(open);
          return li;
        }));
      };
      draw();
      const off = ctx.onChange(draw);
      return () => {
        off();
        el.replaceChildren();
      };
    },
    newItems: () => [{ command: 'hello', testid: 'context:example-hello' }],
  }],
  // A layout (0087) that gives no navigation of its own (the core's menu at the upper left stays): a bar of
  // the views' names, the one chosen drawn below it. Used where this browser names it (kuraa:layout).
  layout: {
    id: 'example-bar',
    label: 'Bar (example)',
    navigation: false,
    mount(el, ctx) {
      const bar = document.createElement('nav');
      bar.dataset.testid = 'example-layout';
      const body = document.createElement('div');
      el.append(bar, body);
      let chosen: string | null = null;
      let down: (() => void) | null = null;
      const draw = () => {
        const views = ctx.views();
        const view = views.find((v) => v.key === chosen) ?? views[0];
        bar.replaceChildren(...views.map((v) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = v.label;
          b.dataset.testid = `example-layout-view:${v.key}`;
          b.onclick = () => {
            chosen = v.key;
            draw();
          };
          return b;
        }));
        if (view && body.dataset.view !== view.key) {
          down?.();
          body.replaceChildren();
          body.dataset.view = view.key;
          down = view.mount(body);
        }
      };
      draw();
      const off = ctx.onChange(draw);
      return () => {
        off();
        down?.();
        el.replaceChildren();
      };
    },
  },
  // A file's menu (a folder's path ends in /: nothing there).
  fileMenu: (path, ctx) => (path.endsWith('/') ? [] : [{
    label: 'Clear your marks…',
    testid: 'context:example-clear-marks',
    run: async () => {
      if (!(await ctx.ui.askConfirm(`Clear your marks in ${path}? Others’ are theirs, and stay.`, 'Clear', true))) return;
      try {
        await ctx.request('POST', 'clear', { path });
        ctx.notify(`Your marks in ${path} are cleared.`);
      } catch (e) {
        ctx.notify((e as Error).message, 'warn');
      }
    },
  }]),
  settings: {
    workspace: {
      label: 'Marks',
      mount(el, ctx) {
        const label = document.createElement('label');
        label.textContent = 'Shown in the margin ';
        const input = document.createElement('input');
        input.value = labelOf(ctx);
        input.maxLength = 3;
        input.dataset.testid = 'example-marks-label';
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = 'Save';
        save.dataset.testid = 'example-marks-save';
        save.onclick = async () => {
          try {
            await ctx.saveSettings({ ...ctx.status().settings, label: input.value });
            ctx.notify('Saved for everyone in this workspace.');
          } catch (e) {
            ctx.notify((e as Error).message, 'warn');
          }
        };
        label.append(input);
        el.append(label, ' ', save);
        return () => el.replaceChildren();
      },
    },
  },
});

export const clients = { marks: marksClient };
