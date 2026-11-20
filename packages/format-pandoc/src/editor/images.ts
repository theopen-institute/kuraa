// Images in the editor. `![alt](src)` typed becomes an image. An image file
// pasted or dropped is kept in the workspace (in `images/` next to the
// document, under a safe name not yet taken) and an image pointing at it goes
// where it was put. Images show by loading the workspace's file from the host;
// web addresses show as they are, and anything else (file:, javascript:) does not.
import type { EditorContext } from '@kuraa/editor-kit';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';
import { safeUrl } from '../schema.js';
import { workspacePath } from './paths.js';

/** What can be added: the image types every browser shows, and SVG (only ever shown as an image). */
export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
};
/** The largest image that can be added. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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

class ImageView implements NodeView {
  dom: HTMLElement;
  private readonly img: HTMLImageElement;
  private shown = '';

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
    this.dom.classList.remove('image-missing');
    this.img.removeAttribute('src');
    const safe = safeUrl(src, 'image');
    if (!safe) return this.missing();
    const local = this.ctx.path ? workspacePath(this.ctx.path, safe) : null;
    if (!local || /^(https?:|data:)/i.test(safe)) {
      if (/^(https?:|data:)/i.test(safe)) this.img.src = safe;
      else this.missing();
      return;
    }
    if (!this.ctx.files) return this.missing();
    void this.ctx.files.imageUrl(local).then((url) => {
      if (this.shown !== src) return;
      if (url) this.img.src = url;
      else this.missing();
    });
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

/** Upload each image, showing where it will go meanwhile, then put an image there (where that place has moved to). */
function addImages(view: EditorView, ctx: EditorContext, files: File[], pos: number): void {
  const files$ = ctx.files;
  const image = view.state.schema.nodes.image;
  if (!files$ || !image) return;
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      ctx.ui.notify?.(`${file.name || 'The image'} is larger than 20 MB, the most an image may be.`, 'warn');
      continue;
    }
    const id = {};
    view.dispatch(view.state.tr.setMeta(uploadsKey, { add: { id, pos } }));
    const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(0, 10)}.${IMAGE_TYPES[file.type] ?? 'png'}`;
    files$.uploadImage(file, name).then((src) => {
      if (view.isDestroyed) return;
      const at = placeOf(view, id);
      if (at === null) return;
      const alt = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
      view.dispatch(view.state.tr.replaceWith(at, at, image.create({ src, alt })).setMeta(uploadsKey, { remove: { id } }));
    }, (e: Error) => {
      if (view.isDestroyed) return;
      view.dispatch(view.state.tr.setMeta(uploadsKey, { remove: { id } }));
      ctx.ui.notify?.(`Could not add ${file.name || 'the image'}: ${e.message}`, 'warn');
    });
  }
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
            set = set.add(tr.doc, [Decoration.widget(meta.add.pos, widget, { id: meta.add.id })]);
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
          addImages(view, ctx, files, view.state.selection.from);
          return true;
        },
        handleDrop(view, event) {
          const files = imagesIn(event.dataTransfer?.files);
          if (!files.length || !view.editable) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          addImages(view, ctx, files, at ? at.pos : view.state.selection.from);
          return true;
        },
      },
    }),
  ];
}
