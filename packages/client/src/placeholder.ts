// What an empty document says: "Start writing…", no more (0076; the cues and
// keys are in Markdown and shortcuts, ⌘/). Shown in the first empty paragraph,
// or below the header when there is nothing else, and gone at the first
// character typed.
// Only this view draws it; nothing is added to the document until someone types.
// Screen readers and apps that read the screen get it as the editor's
// placeholder (aria-placeholder), not as text: the drawn words are hidden from
// them (style.css), so they don't take it for something written (0118).
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { defaultBlock } from './blocks.js';

/**
 * Where the placeholder goes in `doc`: the position of its one empty text block,
 * or -1 for after the header (a document with nothing else), or null if the
 * document is not empty. `header` is the name of the node holding the header,
 * which does not count.
 */
export function emptyAt(doc: PMNode, header?: string): number | null {
  let at: number | null = -1;
  let blocks = 0;
  doc.forEach((node, offset) => {
    if (at === null || (header && node.type.name === header)) return;
    blocks++;
    if (blocks > 1 || !node.isTextblock || node.content.size > 0 || node.type.spec.code) at = null;
    else at = offset;
  });
  return at;
}

export function placeholderPlugin(text: string, header?: string): Plugin {
  return new Plugin({
    props: {
      attributes(state): Record<string, string> {
        return emptyAt(state.doc, header) === null ? {} : { 'aria-placeholder': text };
      },
      decorations(state) {
        const at = emptyAt(state.doc, header);
        if (at === null) return null;
        if (at >= 0) {
          const node = state.doc.nodeAt(at)!;
          return DecorationSet.create(state.doc, [Decoration.node(at, at + node.nodeSize, { class: 'empty-placeholder', 'data-placeholder': text })]);
        }
        // Only the header: a line below it to click, which makes the paragraph to type in.
        const widget = Decoration.widget(state.doc.content.size, (view) => {
          const el = document.createElement('p');
          el.className = 'empty-placeholder empty-placeholder-widget';
          el.dataset.placeholder = text;
          el.contentEditable = 'false';
          el.setAttribute('aria-hidden', 'true');
          el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const block = defaultBlock(view.state.schema);
            if (!block) return;
            const end = view.state.doc.content.size;
            const tr = view.state.tr.insert(end, block.create());
            view.focus();
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)));
          });
          return el;
        }, { side: 1, key: 'empty-placeholder', ignoreSelection: true });
        return DecorationSet.create(state.doc, [widget]);
      },
    },
  });
}
