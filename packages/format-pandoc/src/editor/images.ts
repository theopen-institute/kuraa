// Images in the editor. `![alt](src)` typed becomes an image. Image files
// pasted or dropped are shown in the client's dialog first (0108: how large
// each is as kept, the details removed from it, a smaller size, its
// description), then kept in the workspace (in `images/` next to the document,
// under a safe name not yet taken), and images pointing at them go where they
// were put, in order. Images show by loading the workspace's file from the host;
// an image at a web address shows only once the person asks (its server would
// otherwise learn who opened the document, and when: anyone editing it could
// put one there to find out), and anything else (file:, javascript:) does not.
import type { EditorContext, ImageToAdd } from '@kuraa/editor-kit';
import { IMAGE_MIME, MAX_IMAGE_BYTES } from '@kuraa/kernel';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';
import { safeUrl } from '../schema.js';
import { attrValue, cssLength, formatAttrs, imageAlign, parseAttrs, withAttr, withImageAlign, type ImageAlign } from '../attributes.js';
import { workspacePath } from './paths.js';

/** What can be added, by type: the image types every browser shows, and SVG (only ever shown as an image). */
export const IMAGE_TYPES: Record<string, string> = Object.fromEntries(Object.entries(IMAGE_MIME).map(([ext, mime]) => [mime, ext]));
/** The largest image that can be kept. */
export { MAX_IMAGE_BYTES };

export function imageRules(schema: Schema): InputRule[] {
  const image = schema.nodes.image;
  if (!image) return [];
  return [
    new InputRule(/(?<!\\)!\[([^\[\]]*)\]\(([^()\s]+)(?:\s+"([^"]*)")?\)$/, (state, m, start, end) => {
      const code = state.schema.marks.code;
      if (code && state.doc.rangeHasMark(start, end, code)) return null;
      return state.tr.replaceWith(start, end, image.create({ src: m[2], alt: m[1], title: m[3] ?? null }, null, state.doc.resolve(start).marks()));
    }),
    // `{width=50%}` typed straight after an image: its attributes, as Pandoc reads them there (0130).
    new InputRule(/\{([^{}\n]*)\}$/, (state, m, start, end) => {
      const $start = state.doc.resolve(start);
      const before = $start.nodeBefore;
      if (before?.type !== image) return null;
      const code = state.schema.marks.code;
      if (code && state.doc.rangeHasMark(start, end, code)) return null;
      const typed = parseAttrs(`{${m[1]}}`);
      const had = parseAttrs(String(before.attrs.attrs ?? ''));
      const merged = {
        id: typed.id || had.id,
        classes: [...new Set([...had.classes, ...typed.classes])],
        kv: [...had.kv.filter(([k]) => !typed.kv.some(([t]) => t === k)), ...typed.kv],
      };
      const at = start - before.nodeSize;
      return state.tr.delete(start, end).setNodeMarkup(at, undefined, { ...before.attrs, attrs: formatAttrs(merged) });
    }),
  ];
}

/** Web addresses the person chose to load images from, while this page is open: shown at once from then on. */
const loadedRemote = new Set<string>();

/** Where an image's src shows it from: the workspace, a web address (asked first), data in the document itself, or nowhere. */
export function imageSource(docPath: string | undefined, src: string): { kind: 'workspace'; path: string } | { kind: 'remote'; url: string } | { kind: 'data'; url: string } | { kind: 'none' } {
  const safe = safeUrl(src, 'image');
  if (!safe) return { kind: 'none' };
  if (/^data:/i.test(safe)) return { kind: 'data', url: safe };
  if (/^https?:/i.test(safe)) return { kind: 'remote', url: safe };
  const local = docPath ? workspacePath(docPath, safe) : null;
  return local ? { kind: 'workspace', path: local } : { kind: 'none' };
}

/** Whether a paragraph holds an image and nothing else (spaces aside): a figure, placed on its own line (0130). */
export function aloneImage(paragraph: PMNode): PMNode | null {
  if (paragraph.type.name !== 'paragraph') return null;
  let image: PMNode | null = null;
  let other = false;
  paragraph.forEach((child) => {
    if (child.type.name === 'image' && !image) image = child;
    else if (!(child.isText && !child.text!.trim())) other = true;
  });
  return other ? null : image;
}

const SVG = 'http://www.w3.org/2000/svg';
/** A small drawing of lines of text placed left, centred or right, for the placement buttons. */
function alignIcon(align: ImageAlign): SVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const rows: [number, number][] = align === 'left' ? [[2, 9], [2, 14], [2, 9]] : align === 'right' ? [[7, 14], [2, 14], [7, 14]] : [[4.5, 11.5], [2, 14], [4.5, 11.5]];
  rows.forEach(([x1, x2], i) => {
    const line = document.createElementNS(SVG, 'line');
    Object.entries({ x1, x2, y1: 4 + i * 4, y2: 4 + i * 4 }).forEach(([k, v]) => line.setAttribute(k, String(v)));
    svg.append(line);
  });
  return svg;
}

const ALIGN_LABEL: Record<ImageAlign, string> = { left: 'Left', center: 'Centre', right: 'Right' };

/** The width of what an element's percentages are of: its content box. */
function contentWidth(el: HTMLElement): number {
  const s = getComputedStyle(el);
  return el.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0);
}

class ImageView implements NodeView {
  dom: HTMLElement;
  private readonly img: HTMLImageElement;
  private shown = '';
  /** Asks to load an image at a web address, until it is. */
  private ask: HTMLButtonElement | null = null;
  /** Its handles and its bar, when it can be changed: theirs are the events on them, not the editor's. */
  private controls: HTMLElement[] = [];
  private bar: HTMLElement | null = null;
  /** The width shown while a handle is dragged. */
  private badge: HTMLElement | null = null;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly ctx: EditorContext) {
    this.dom = document.createElement('span');
    this.dom.className = 'image-node';
    this.dom.dataset.testid = 'image';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.dom.append(this.img);
    this.img.addEventListener('error', () => this.missing());
    this.dom.addEventListener('dblclick', (e) => {
      if (this.controls.some((c) => c.contains(e.target as Node))) return;
      e.preventDefault();
      this.describe();
    });
    if (view.editable) this.addControls();
    this.render();
  }

  private describe() {
    if (!this.view.editable) return;
    void this.ctx.ui.askText('Describe the image (its alt text)', String(this.node.attrs.alt), 'Save').then((alt) => {
      const pos = this.getPos();
      if (alt === null || pos === undefined || this.view.isDestroyed) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, alt }));
    });
  }

  /** Change its attribute text (its width, its place), as one edit. */
  private setAttrs(attrs: string) {
    const pos = this.getPos();
    if (pos === undefined || this.view.isDestroyed || attrs === this.node.attrs.attrs) return;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, attrs });
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
  }

  /** Whether it is alone in its paragraph, so placed on a line of its own. */
  private alone(): boolean {
    const pos = this.getPos();
    if (pos === undefined) return false;
    return aloneImage(this.view.state.doc.resolve(pos).parent) === this.node;
  }

  /**
   * A handle on each side, to drag it wider or narrower (its width a whole
   * percentage of the line's, as Pandoc writes it: `{width=60%}`), and a bar
   * above it while it is selected: placed left, centred or right (when alone
   * on its line), its own size again, its description.
   */
  private addControls() {
    for (const side of ['left', 'right'] as const) {
      const handle = document.createElement('span');
      handle.className = `image-handle image-handle-${side}`;
      handle.dataset.testid = `image-handle-${side}`;
      handle.contentEditable = 'false';
      handle.title = 'Drag to resize';
      handle.addEventListener('pointerdown', (e) => this.resize(e, handle, side));
      this.controls.push(handle);
      this.dom.append(handle);
    }
    const bar = document.createElement('span');
    bar.className = 'image-bar';
    bar.dataset.testid = 'image-bar';
    bar.contentEditable = 'false';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Image');
    this.bar = bar;
    this.controls.push(bar);
    this.dom.append(bar);
  }

  /** The bar's buttons for the image as it is now. */
  private fillBar() {
    const bar = this.bar;
    if (!bar) return;
    bar.replaceChildren();
    const raw = String(this.node.attrs.attrs ?? '');
    const button = (label: string, title: string, testid: string, act: () => void, content?: Node) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'image-bar-button';
      b.title = title;
      b.dataset.testid = testid;
      if (content) {
        b.append(content);
        b.setAttribute('aria-label', label);
      } else b.textContent = label;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        act();
      });
      bar.append(b);
      return b;
    };
    if (this.alone()) {
      const now = imageAlign(raw);
      for (const align of ['left', 'center', 'right'] as const) {
        const b = button(ALIGN_LABEL[align], `${ALIGN_LABEL[align]}`, `image-align-${align}`, () => this.setAttrs(withImageAlign(raw, align)), alignIcon(align));
        b.setAttribute('aria-pressed', String(now === align));
      }
      bar.append(Object.assign(document.createElement('span'), { className: 'image-bar-gap' }));
    }
    if (attrValue(raw, 'width') !== null || attrValue(raw, 'height') !== null) {
      button('Own size', 'Show it at its own size again', 'image-own-size', () => this.setAttrs(withAttr(withAttr(raw, 'width', null), 'height', null)));
    }
    button('Describe…', 'Describe the image (its alt text, and its caption when it is alone on its line)', 'image-describe', () => this.describe());
  }

  /** A handle dragged: wider or narrower, both sides moving when it is centred; written when let go. */
  private resize(e: PointerEvent, handle: HTMLElement, side: 'left' | 'right') {
    if (!this.view.editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = this.dom.parentElement;
    if (!box) return;
    const whole = contentWidth(box);
    if (whole <= 0) return;
    const startX = e.clientX;
    const startW = this.dom.getBoundingClientRect().width;
    const centred = this.alone() && imageAlign(String(this.node.attrs.attrs)) === 'center';
    const raw = String(this.node.attrs.attrs ?? '');
    let pct = Math.round((startW / whole) * 100);
    handle.setPointerCapture(e.pointerId);
    this.dom.classList.add('image-resizing');
    const badge = document.createElement('span');
    badge.className = 'image-badge';
    badge.contentEditable = 'false';
    this.badge = badge;
    this.dom.append(badge);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (side === 'right' ? 1 : -1) * (centred ? 2 : 1);
      const px = Math.min(whole, Math.max(24, startW + dx));
      pct = Math.max(5, Math.min(100, Math.round((px / whole) * 100)));
      this.dom.style.width = `${pct}%`;
      this.img.style.height = '';
      badge.textContent = `${pct}%`;
    };
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', done);
      handle.removeEventListener('pointercancel', done);
      this.dom.classList.remove('image-resizing');
      badge.remove();
      this.badge = null;
      // Its height goes with its width: a height kept would stretch it.
      const next = withAttr(withAttr(raw, 'height', null), 'width', `${pct}%`);
      if (next !== raw) this.setAttrs(next);
      else this.layout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done);
    handle.addEventListener('pointercancel', done);
  }

  /** Its width and height, as its attributes say (a bare number being pixels, as in Pandoc). */
  private layout() {
    const raw = String(this.node.attrs.attrs ?? '');
    const width = cssLength(attrValue(raw, 'width'));
    const height = cssLength(attrValue(raw, 'height'));
    this.dom.style.width = width ?? '';
    this.dom.classList.toggle('image-sized', !!width);
    this.img.style.height = height ?? '';
    if (this.dom.classList.contains('ProseMirror-selectednode')) this.fillBar();
  }

  selectNode() {
    this.dom.classList.add('ProseMirror-selectednode');
    this.fillBar();
  }

  deselectNode() {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  private render() {
    const { src, alt, title } = this.node.attrs as { src: string; alt: string; title: string | null };
    this.img.alt = alt;
    this.dom.title = [title, src, 'Double-click to describe it'].filter(Boolean).join('\n');
    if (!this.badge) this.layout();
    if (src === this.shown) return;
    this.shown = src;
    this.dom.classList.remove('image-missing', 'image-remote');
    this.ask?.remove();
    this.ask = null;
    this.img.removeAttribute('src');
    const source = imageSource(this.ctx.path, src);
    if (source.kind === 'none') return this.missing();
    if (source.kind === 'data') {
      this.img.src = source.url;
      return;
    }
    if (source.kind === 'remote') return loadedRemote.has(source.url) ? void (this.img.src = source.url) : this.askToLoad(source.url);
    if (!this.ctx.files) return this.missing();
    void this.ctx.files.imageUrl(source.path).then((url) => {
      if (this.shown !== src) return;
      if (url) this.img.src = url;
      else this.missing();
    });
  }

  /** In the image's place: where it is, and a button to load it. */
  private askToLoad(url: string) {
    this.dom.classList.add('image-remote');
    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'image-load';
    ask.dataset.testid = 'image-load';
    let where = url;
    try {
      where = new URL(url).host;
    } catch { /* as written */ }
    ask.textContent = `Show image from ${where}`;
    ask.title = `${url}\nShowing it lets that website know you opened this document.`;
    ask.addEventListener('click', (e) => {
      e.preventDefault();
      loadedRemote.add(url);
      this.dom.classList.remove('image-remote');
      ask.remove();
      this.ask = null;
      if (this.shown === String(this.node.attrs.src)) this.img.src = url;
    });
    this.ask = ask;
    this.dom.append(ask);
  }

  private missing() {
    this.dom.classList.add('image-missing');
    this.dom.dataset.missing = `Image not found: ${String(this.node.attrs.src)}`;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  /** The button's clicks are its own, not the editor's (which would select the image); so are its handles' and its bar's. */
  stopEvent(e: Event): boolean {
    if (this.ask !== null && e.target === this.ask) return true;
    return this.controls.some((c) => c.contains(e.target as Node));
  }

  ignoreMutation() { return true; }
}

/** The paragraphs that hold an image alone, marked so: placed as it says (`fig-align`), centred when it says nothing. */
function placements(doc: PMNode): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return !node.isTextblock;
    const image = aloneImage(node);
    if (image) found.push(Decoration.node(pos, pos + node.nodeSize, { class: 'image-alone', 'data-align': imageAlign(String(image.attrs.attrs ?? '')) }));
    return false;
  });
  return DecorationSet.create(doc, found);
}

const placeKey = new PluginKey<DecorationSet>('image-placement');

/** Images alone on their line, placed: in the editor and when only read. */
export function imagePlacement(): Plugin {
  return new Plugin<DecorationSet>({
    key: placeKey,
    state: {
      init: (_config, state) => placements(state.doc),
      apply: (tr, set) => (tr.docChanged ? placements(tr.doc) : set),
    },
    props: { decorations: (state) => placeKey.getState(state) },
  });
}

export function imageViews(ctx: EditorContext): Record<string, NodeViewConstructor> {
  return { image: (node, view, getPos) => new ImageView(node, view, getPos, ctx) };
}

// ---------------------------------------------------------------------------
// Adding image files

const uploadsKey = new PluginKey<DecorationSet>('image-uploads');

/** The images among files pasted or dropped. */
function imagesIn(files: FileList | null | undefined): File[] {
  return [...(files ?? [])].filter((f) => f.type in IMAGE_TYPES || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name));
}

/** Whether a file has a name of its own (one pasted from a screenshot has none, or the browser's `image.png`). */
const named = (file: File) => !!file.name && file.name !== 'image.png';

/** The name an image is kept under: its file's, or (pasted, with none of its own) the day's. */
function nameOf(file: File): string {
  return named(file) ? file.name : `pasted-${new Date().toISOString().slice(0, 10)}.${IMAGE_TYPES[file.type] ?? 'png'}`;
}

/** Its description to begin with: its file's name in words; none for one with no name of its own. */
function altOf(file: File, name: string): string {
  return named(file) ? name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') : '';
}

/**
 * Add image files where they were put: a place held for them (it moves with
 * edits around it) while the client's dialog asks how to add them, then each
 * kept in the workspace in turn and put there, in order.
 */
async function addImages(view: EditorView, ctx: EditorContext, files: File[], pos: number): Promise<void> {
  const files$ = ctx.files;
  const image = view.state.schema.nodes.image;
  if (!files$ || !image) return;
  const id = {};
  view.dispatch(view.state.tr.setMeta(uploadsKey, { add: { id, pos } }));
  const done = () => {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(uploadsKey, { remove: { id } }));
  };
  let chosen: ImageToAdd[] | null = files.map((file) => {
    const name = nameOf(file);
    return { file, name, alt: altOf(file, name) };
  });
  if (ctx.ui.chooseImages) {
    chosen = await ctx.ui.chooseImages(chosen).catch((e: Error) => {
      ctx.ui.notify?.(`Could not add the images: ${e.message}`, 'warn');
      return null;
    });
  } else {
    chosen = chosen.filter(({ file, name }) => {
      if (file.size <= MAX_IMAGE_BYTES) return true;
      ctx.ui.notify?.(`${name} is larger than 20 MB, the most an image may be.`, 'warn');
      return false;
    });
  }
  for (const { file, name, alt } of chosen ?? []) {
    if (view.isDestroyed) return;
    try {
      const src = await files$.uploadImage(file, name);
      if (view.isDestroyed) return;
      const at = placeOf(view, id);
      if (at === null) break;
      view.dispatch(view.state.tr.replaceWith(at, at, image.create({ src, alt })));
    } catch (e) {
      ctx.ui.notify?.(`Could not add ${name}: ${(e as Error).message}`, 'warn');
    }
  }
  done();
}

function placeOf(view: EditorView, id: object): number | null {
  const found = uploadsKey.getState(view.state)?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.length ? found[0]!.from : null;
}

export function imagePlugins(ctx: EditorContext): Plugin[] {
  if (!ctx.files || !ctx.path) return [];
  return [
    new Plugin<DecorationSet>({
      key: uploadsKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          set = set.map(tr.mapping, tr.doc);
          const meta = tr.getMeta(uploadsKey) as { add?: { id: object; pos: number }; remove?: { id: object } } | undefined;
          if (meta?.add) {
            const widget = document.createElement('span');
            widget.className = 'image-uploading';
            widget.textContent = 'Adding image…';
            // Its side: images put at its place go before it, so the next goes after them.
            set = set.add(tr.doc, [Decoration.widget(meta.add.pos, widget, { id: meta.add.id, side: 1 })]);
          }
          if (meta?.remove) set = set.remove(set.find(undefined, undefined, (spec) => spec.id === meta.remove!.id));
          return set;
        },
      },
      props: {
        decorations: (state) => uploadsKey.getState(state),
        handlePaste(view, event) {
          const files = imagesIn(event.clipboardData?.files);
          if (!files.length || !view.editable) return false;
          event.preventDefault();
          const { from, to } = view.state.selection;
          if (from !== to) view.dispatch(view.state.tr.deleteSelection());
          void addImages(view, ctx, files, view.state.selection.from);
          return true;
        },
        handleDrop(view, event) {
          const files = imagesIn(event.dataTransfer?.files);
          if (!files.length || !view.editable) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          void addImages(view, ctx, files, at ? at.pos : view.state.selection.from);
          return true;
        },
      },
    }),
  ];
}
