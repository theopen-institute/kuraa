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
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';
import { safeUrl } from '../schema.js';
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

class ImageView implements NodeView {
  dom: HTMLElement;
  private readonly img: HTMLImageElement;
  private shown = '';
  /** Asks to load an image at a web address, until it is. */
  private ask: HTMLButtonElement | null = null;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly ctx: EditorContext) {
    this.dom = document.createElement('span');
    this.dom.className = 'image-node';
    this.dom.dataset.testid = 'image';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.dom.append(this.img);
    this.img.addEventListener('error', () => this.missing());
    this.dom.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (!this.view.editable) return;
      void this.ctx.ui.askText('Describe the image (its alt text)', String(this.node.attrs.alt), 'Save').then((alt) => {
        const pos = this.getPos();
        if (alt === null || pos === undefined || this.view.isDestroyed) return;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, alt }));
      });
    });
    this.render();
  }

  private render() {
    const { src, alt, title } = this.node.attrs as { src: string; alt: string; title: string | null };
    this.img.alt = alt;
    this.dom.title = [title, src, 'Double-click to describe it'].filter(Boolean).join('\n');
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

  /** The button's clicks are its own, not the editor's (which would select the image). */
  stopEvent(e: Event): boolean {
    return this.ask !== null && e.target === this.ask;
  }

  ignoreMutation() { return true; }
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
