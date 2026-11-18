import type { Mark } from 'prosemirror-model';
import type { DocumentType, NodeViewHint } from '@kuraa/kernel';
import { createPandocType, pandocMarks, pandocNodeViews, PANDOC_VERSION } from '@kuraa/format-pandoc';

// R Markdown: Pandoc markdown plus knitr code chunks and inline R code.
// Built only through the PandocExtension point; nothing is executed.

/** ```{r label, echo=FALSE} — an engine name first, inside braces. */
const CHUNK_INFO = /^\{\s*([A-Za-z][\w-]*)([\s,][^}]*)?\}$/;
/** `r expr` */
const INLINE_R = /^r\s+([\s\S]+)$/;

export const RMARKDOWN_VERSION = 1;

export const rmarkdown: DocumentType = createPandocType({
  id: 'rmarkdown',
  // Changes to either schema must invalidate rooms.
  version: PANDOC_VERSION * 1000 + RMARKDOWN_VERSION,
  label: 'R Markdown',
  priority: 10,
  extensions: ['.Rmd'],
  match: (path) => /\.rmd$/i.test(path),
  // A page with a line of text and a code chunk.
  icon: { paths: ['M4 1.5h5.5l3 3v10H4z', 'M9.5 1.5v3h3', 'M6 7h4.5', 'M7.25 9.25 6 10.5l1.25 1.25', 'M9.25 9.25l1.25 1.25-1.25 1.25'] },

  nodes: {
    code_chunk: {
      attrs: { engine: { default: 'r' }, header: { default: 'r' }, fence: { default: '```' } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre.code-chunk', preserveWhitespace: 'full' }],
      toDOM: (node) => ['pre', { class: 'code-chunk', 'data-engine': node.attrs.engine }, ['code', 0]],
    },
  },

  marks: {
    code: {
      ...pandocMarks.code,
      attrs: { engine: { default: null } },
    },
  },

  parse: {
    block(node, ctx) {
      if (node.type !== 'code') return undefined;
      const src = ctx.slice(node);
      const m = /^ {0,3}(`{3,})[ \t]*([^\n]*)/.exec(src);
      const info = (m?.[2] ?? '').trim();
      const chunk = CHUNK_INFO.exec(info);
      if (!m || !chunk) return undefined;
      const value = String(node.value ?? '');
      return ctx.schema.nodes.code_chunk!.create(
        { engine: chunk[1], header: info.slice(1, -1), fence: m[1] },
        value ? ctx.schema.text(value) : null,
      );
    },
    inline(node, ctx, marks) {
      if (node.type !== 'inlineCode') return undefined;
      const m = INLINE_R.exec(String(node.value ?? ''));
      if (!m?.[1]) return undefined;
      return [ctx.schema.text(m[1], ctx.schema.marks.code!.create({ engine: 'r' }).addToSet(marks))];
    },
  },

  serialize: {
    block(node) {
      if (node.type.name !== 'code_chunk') return undefined;
      const text = node.textContent;
      let fence = String(node.attrs.fence || '```');
      while (text.includes(fence)) fence += '`';
      return `${fence}{${node.attrs.header}}\n${text}${text && !text.endsWith('\n') ? '\n' : ''}${fence}`;
    },
    code(text: string, mark: Mark) {
      if (!mark.attrs.engine) return undefined;
      const ticks = text.includes('`') ? '``' : '`';
      return `${ticks}${mark.attrs.engine} ${text}${ticks}`;
    },
  },

  // Code keeps its lines whole and scrolls sideways, as in RStudio.
  nodeViews: {
    code_chunk: { kind: 'code', language: 'r', header: { attr: 'header', prefix: '{', suffix: '}' }, run: { engineAttr: 'engine' }, wrap: false },
    code_block: { ...pandocNodeViews.code_block!, wrap: false } as NodeViewHint,
  },
});
