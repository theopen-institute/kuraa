// Citations in the editor. Typing one makes it a citation, written back as the
// Pandoc citation it is: `[@a; @b, p. 3]` when the bracket closes, `@a` when a
// space or punctuation follows the key, `@a [p. 3]` when the locator's bracket
// closes after an in-text citation. Backspace straight afterwards turns it back
// into text, which is then written escaped (`\@a`), as Pandoc reads text.
//
// Typing @ (alone or in brackets) offers the keys of the document's
// bibliography, as "Author (Year) Title": arrows choose, Enter or Tab takes,
// Escape closes. Citations show as chips naming what they cite ("Smith 2020");
// a key the bibliography does not have is marked.
import type { EditorContext } from '@kuraa/editor-kit';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';
import { parse as parseYaml } from 'yaml';
import { CITATION_KEY, citeKey, readCitation } from '../citations.js';
import { bibliographyPaths, entryLabel, headerReferences, readBibliography, type BibEntry } from '../bibliography.js';
import { workspacePath } from './paths.js';

const CITE = 'citation';

// ---------------------------------------------------------------------------
// The document's bibliography

/** The entries the document's bibliography holds, shared by its plugins and chips. */
export class Bibliography {
  entries = new Map<string, BibEntry>();
  /** Whether any bibliography was read: only then is a key it lacks marked. */
  loaded = false;
  private listeners = new Set<() => void>();
  private source = '';
  private readAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly ctx: EditorContext) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Read the header's bibliography again if it changed, or (with `stale`) if it was read longer ago than that. */
  refresh(doc: PMNode, staleMs = Infinity): Promise<void> {
    const header = doc.firstChild?.type.name === 'front_matter' ? doc.firstChild.textContent : '';
    if (header === this.source && Date.now() - this.readAt < staleMs) return this.loading ?? Promise.resolve();
    this.source = header;
    this.readAt = Date.now();
    const load = this.load(header);
    this.loading = load.finally(() => {
      if (this.loading === load) this.loading = null;
    });
    return this.loading;
  }

  private async load(header: string): Promise<void> {
    let meta: unknown = null;
    try {
      meta = header ? parseYaml(header) : null;
    } catch { /* a header being typed: nothing to read yet */ }
    const entries: BibEntry[] = [...headerReferences(meta)];
    let loaded = entries.length > 0;
    const files = this.ctx.files;
    if (files && this.ctx.path) {
      const texts = await Promise.all(bibliographyPaths(meta).map(async (p) => {
        const path = workspacePath(this.ctx.path!, p);
        return path ? { path, text: await files.text(path).catch(() => null) } : null;
      }));
      for (const t of texts) {
        if (!t || t.text === null) continue;
        loaded = true;
        entries.push(...readBibliography(t.text, t.path));
      }
    }
    if (header !== this.source) return; // read again meanwhile
    this.entries = new Map(entries.map((e) => [e.key, e]));
    this.loaded = loaded;
    for (const fn of this.listeners) fn();
  }

  /** Entries matching what was typed after the @: by key, then by author, title or year. */
  search(query: string, limit = 8): BibEntry[] {
    const q = query.toLowerCase();
    const all = [...this.entries.values()];
    const score = (e: BibEntry) => {
      const key = e.key.toLowerCase();
      if (!q) return 1;
      if (key.startsWith(q)) return 0;
      if (e.authors.some((a) => a.toLowerCase().startsWith(q))) return 1;
      if (key.includes(q) || `${e.authors.join(' ')} ${e.year} ${e.title}`.toLowerCase().includes(q)) return 2;
      return -1;
    };
    return all
      .map((e) => ({ e, s: score(e) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || (a.e.authors[0] ?? a.e.title).localeCompare(b.e.authors[0] ?? b.e.title) || a.e.year.localeCompare(b.e.year))
      .slice(0, limit)
      .map((x) => x.e);
  }
}

const bibliographies = new WeakMap<EditorContext, Bibliography>();
/** The bibliography of the document a context belongs to: the plugins and the chips share it. */
export function bibliographyOf(ctx: EditorContext): Bibliography {
  let b = bibliographies.get(ctx);
  if (!b) bibliographies.set(ctx, (b = new Bibliography(ctx)));
  return b;
}

/** "Hall et al. (2017) The City as a Refuge", for the picker and the chip's tooltip. */
export function describeEntry(e: BibEntry): string {
  const who = e.authors.length > 2 ? `${e.authors[0]} et al.` : e.authors.join(' & ');
  return [who, e.year ? `(${e.year})` : '', e.title].filter(Boolean).join(' ');
}

/** What a citation chip says: "Smith 2020", "(see Smith 2020, p. 3; 2019)". Unknown keys as @key. */
export function citationLabel(text: string, bib: Bibliography): { label: string; unknown: string[] } {
  const c = readCitation(text);
  if (!c) return { label: text, unknown: [] };
  const unknown: string[] = [];
  const parts = c.items.map((it) => {
    const e = bib.entries.get(it.key);
    if (!e && bib.loaded) unknown.push(it.key);
    const name = e ? (it.suppressAuthor ? e.year || entryLabel(e) : entryLabel(e)) : `${it.suppressAuthor ? '-' : ''}@${it.key}`;
    const suffix = it.suffix ? (/^[,;.:]/.test(it.suffix) ? it.suffix : `, ${it.suffix}`) : '';
    return `${it.prefix ? `${it.prefix} ` : ''}${name}${suffix}`;
  });
  return { label: c.bracketed ? `(${parts.join('; ')})` : parts.join('; '), unknown };
}

// ---------------------------------------------------------------------------
// The chip

class CitationView implements NodeView {
  dom: HTMLElement;
  private readonly off: () => void;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly bib: Bibliography, private readonly ctx: EditorContext) {
    this.dom = document.createElement('span');
    this.dom.dataset.testid = 'citation';
    this.render();
    this.off = bib.subscribe(() => this.render());
    this.dom.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (!this.view.editable) return;
      void this.ctx.ui.askText('Edit the citation (Pandoc markdown)', String(this.node.attrs.text), 'Save').then((value) => {
        const pos = this.getPos();
        if (value === null || pos === undefined || this.view.isDestroyed) return;
        const text = value.trim();
        const tr = this.view.state.tr;
        if (!text) tr.delete(pos, pos + this.node.nodeSize);
        else tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, text });
        this.view.dispatch(tr);
      });
    });
  }

  private render() {
    const text = String(this.node.attrs.text);
    const { label, unknown } = citationLabel(text, this.bib);
    this.dom.className = `atom citation${unknown.length ? ' citation-unknown' : ''}`;
    this.dom.textContent = label;
    const c = readCitation(text);
    const lines = (c?.items ?? []).map((it) => {
      const e = this.bib.entries.get(it.key);
      return e ? describeEntry(e) : this.bib.loaded ? `Not in the bibliography: ${it.key}` : `@${it.key}`;
    });
    this.dom.title = [...lines, `${text} · double-click to edit`].join('\n');
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation() { return true; }
  destroy() { this.off(); }
}

export function citationViews(ctx: EditorContext): Record<string, NodeViewConstructor> {
  const bib = bibliographyOf(ctx);
  return { [CITE]: (node, view, getPos) => new CitationView(node, view, getPos, bib, ctx) };
}

// ---------------------------------------------------------------------------
// Typing citations

/** Whether `text` (a textblock's text up to a point) leaves a bracket open. */
function insideBrackets(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

const inCode = (state: EditorState, from: number, to: number) => {
  const code = state.schema.marks.code;
  return !!code && (state.doc.rangeHasMark(from, to, code) || !!code.isInSet(state.storedMarks ?? state.doc.resolve(from).marks()));
};

const textBefore = (state: EditorState, pos: number) => {
  const $pos = state.doc.resolve(pos);
  return $pos.parent.textBetween(0, $pos.parentOffset, undefined, '￼');
};

/** Holds a citation: a key after the start, a space or a semicolon. */
const CITES = new RegExp(String.raw`(^|[\s;])-?@${CITATION_KEY}`, 'u');
const BARE = new RegExp(String.raw`(?<![\p{L}\p{N}_@\\\[;-])@(${CITATION_KEY})([.:!?]*[\s,;)])$`, 'u');
const BARE_AT_END = new RegExp(String.raw`(?<![\p{L}\p{N}_@\\\[;-])@(${CITATION_KEY})([.:!?]*)$`, 'u');

/** Turn `@key` ending at `end` (perhaps with punctuation after it) into a citation; null if there is none. */
function bareCitation(state: EditorState, end: number, typed = ''): Transaction | null {
  const type = state.schema.nodes[CITE];
  if (!type) return null;
  const before = textBefore(state, end);
  const m = (typed ? BARE : BARE_AT_END).exec(before + typed);
  if (!m) return null;
  const tail = m[2]!.length - typed.length; // punctuation already in the document after the key
  const keyEnd = end - tail;
  const from = keyEnd - (m[0].length - m[2]!.length);
  if (insideBrackets(before.slice(0, before.length - (end - from))) || inCode(state, from, keyEnd)) return null;
  const marks = state.doc.resolve(from).marks();
  const tr = state.tr.replaceWith(from, keyEnd, type.create({ text: `@${m[1]}` }, null, marks));
  return tr;
}

export function citationRules(schema: Schema): InputRule[] {
  const type = schema.nodes[CITE];
  if (!type) return [];
  return [
    // A bracket closing a citation: [@a], [see @a, p. 3; -@b].
    new InputRule(/(?<![\\!^\]])\[([^\[\]￼]*)\]$/, (state, m, start, end) => {
      const inner = m[1]!;
      if (inCode(state, start, end)) return null;
      if (CITES.test(inner)) return state.tr.replaceWith(start, end, type.create({ text: `[${inner}]` }, null, state.doc.resolve(start).marks()));
      // A locator after an in-text citation: @a [p. 3].
      const $start = state.doc.resolve(start);
      if (start - 1 <= $start.start() || state.doc.textBetween(start - 1, start) !== ' ' || inner.includes('@')) return null;
      const cite = state.doc.resolve(start - 1).nodeBefore;
      const text = String(cite?.attrs.text ?? '');
      if (cite?.type !== type || !/^@/.test(text) || text.includes('[')) return null;
      const from = start - 1 - cite.nodeSize;
      return state.tr.replaceWith(from, end, type.create({ text: `${text} [${inner}]` }, null, cite.marks));
    }),
    // A key and then a space or punctuation: @smith2020, (the punctuation stays text).
    new InputRule(new RegExp(String.raw`@${CITATION_KEY}[.:!?]*[\s,;)]$`, 'u'), (state, m, start, end) => {
      const tr = bareCitation(state, end, m[0].slice(-1));
      if (!tr) return null;
      return tr.insertText(m[0].slice(-1), tr.mapping.map(end));
    }),
  ];
}

// ---------------------------------------------------------------------------
// The picker

interface PickerState {
  /** Where the typed `@` (or `-@`) starts, and the cursor. */
  from: number;
  to: number;
  query: string;
  /** Inside brackets: a pick completes the key as text; elsewhere it makes the citation. */
  bracketed: boolean;
}

interface PickerPluginState {
  open: PickerState | null;
  /** The `@` the picker was closed at (Escape), so it stays closed there. */
  dismissed: number | null;
}

const pickerKey = new PluginKey<PickerPluginState>('citation-picker');
const AT_CURSOR = /(?<![\p{L}\p{N}_@\\])(-?)@([\p{L}\p{N}_:.#$%&+?<>~/-]*)$/u;

function pickerFor(state: EditorState, dismissed: number | null): PickerState | null {
  const { empty, from } = state.selection;
  if (!empty || !state.selection.$from.parent.inlineContent || state.selection.$from.parent.type.spec.code) return null;
  const before = textBefore(state, from).slice(-200);
  const m = AT_CURSOR.exec(before);
  if (!m) return null;
  const at = from - m[0].length;
  if (inCode(state, at, from)) return null;
  const head = before.slice(0, before.length - m[0].length);
  if (dismissed === at) return null;
  return { from: at, to: from, query: m[2]!, bracketed: insideBrackets(head) };
}

class PickerView {
  private readonly dom: HTMLElement;
  private items: { entry: BibEntry; el: HTMLElement }[] = [];
  private active = 0;
  private shown: PickerState | null = null;
  private readonly off: () => void;

  constructor(private readonly view: EditorView, private readonly bib: Bibliography) {
    this.dom = document.createElement('div');
    this.dom.className = 'citation-picker';
    this.dom.dataset.testid = 'citation-picker';
    this.dom.setAttribute('role', 'listbox');
    this.dom.style.display = 'none';
    document.body.append(this.dom);
    this.off = bib.subscribe(() => this.update(view));
    void bib.refresh(view.state.doc);
  }

  update(view: EditorView, prev?: EditorState): void {
    if (prev && prev.doc.firstChild !== view.state.doc.firstChild) void this.bib.refresh(view.state.doc);
    const p = pickerKey.getState(view.state)?.open ?? null;
    if (p && !this.shown) void this.bib.refresh(view.state.doc, 15_000);
    const changed = !p || !this.shown || p.query !== this.shown.query || p.from !== this.shown.from;
    this.shown = p;
    if (!p) return this.hide();
    if (changed) this.fill(p);
    if (!this.items.length) return this.hide();
    const at = view.coordsAtPos(p.from);
    this.dom.style.display = '';
    this.dom.style.left = `${Math.max(4, Math.min(at.left, window.innerWidth - this.dom.offsetWidth - 8))}px`;
    const below = at.bottom + 4;
    this.dom.style.top = below + this.dom.offsetHeight > window.innerHeight - 8 ? `${Math.max(4, at.top - this.dom.offsetHeight - 4)}px` : `${below}px`;
  }

  private fill(p: PickerState) {
    this.dom.replaceChildren();
    this.active = 0;
    this.items = this.bib.search(p.query).map((entry, i) => {
      const el = document.createElement('div');
      el.className = 'citation-option';
      el.setAttribute('role', 'option');
      el.dataset.testid = `citation-option:${entry.key}`;
      const who = document.createElement('span');
      who.className = 'citation-option-label';
      who.textContent = describeEntry(entry) || entry.key;
      const key = document.createElement('span');
      key.className = 'citation-option-key';
      key.textContent = `@${entry.key}`;
      el.append(who, key);
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.active = i;
        this.pick();
      });
      return { entry, el };
    });
    for (const it of this.items) this.dom.append(it.el);
    this.highlight();
  }

  private highlight() {
    this.items.forEach((it, i) => {
      it.el.classList.toggle('active', i === this.active);
      it.el.setAttribute('aria-selected', String(i === this.active));
    });
    this.items[this.active]?.el.scrollIntoView?.({ block: 'nearest' });
  }

  private hide() {
    this.dom.style.display = 'none';
    this.items = [];
  }

  get open(): boolean {
    return this.dom.style.display !== 'none' && this.items.length > 0;
  }

  key(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
      this.highlight();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      this.pick();
      return true;
    }
    if (e.key === 'Escape') {
      const p = this.shown;
      if (p) this.view.dispatch(this.view.state.tr.setMeta(pickerKey, { dismiss: p.from }));
      return true;
    }
    return false;
  }

  private pick() {
    const p = this.shown;
    const entry = this.items[this.active]?.entry;
    if (!p || !entry) return;
    const { state } = this.view;
    const type = state.schema.nodes[CITE]!;
    const dash = state.doc.textBetween(p.from, p.from + 1) === '-' ? '-' : '';
    const tr = state.tr;
    if (p.bracketed) {
      tr.insertText(`${dash}${citeKey(entry.key)}`, p.from, p.to);
    } else {
      const from = p.from + dash.length;
      tr.replaceWith(from, p.to, type.create({ text: citeKey(entry.key) }, null, state.doc.resolve(from).marks()));
      tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(p.to)));
    }
    this.view.dispatch(tr.scrollIntoView());
    this.hide();
  }

  destroy() {
    this.off();
    this.dom.remove();
  }
}

/** The picker, and an in-text citation finished by Enter (no space typed after it). */
export function citationPlugins(ctx: EditorContext): Plugin[] {
  const bib = bibliographyOf(ctx);
  let picker: PickerView | null = null;
  return [
    new Plugin<PickerPluginState>({
      key: pickerKey,
      state: {
        init: () => ({ open: null, dismissed: null }),
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(pickerKey) as { dismiss: number } | undefined;
          let dismissed = prev.dismissed;
          if (meta) dismissed = meta.dismiss;
          else if (dismissed !== null && tr.docChanged) dismissed = tr.mapping.map(dismissed);
          // Opened by one's own typing, and kept open while the typed key goes on.
          if (!prev.open && (!tr.docChanged || ctx.isRemote(tr))) return { open: null, dismissed };
          if (prev.open && !tr.docChanged && !tr.selectionSet && !meta) return prev;
          return { open: pickerFor(state, dismissed), dismissed };
        },
      },
      view: (view) => (picker = new PickerView(view, bib)),
      props: {
        handleKeyDown(view, e) {
          if (picker?.key(e)) {
            e.preventDefault();
            return true;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && view.state.selection.empty) {
            // Convert, then let Enter go on to the keymap with the new state.
            const tr = bareCitation(view.state, view.state.selection.from);
            if (tr) view.dispatch(tr);
          }
          return false;
        },
      },
    }),
  ];
}
