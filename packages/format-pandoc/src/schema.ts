import type { MarkSpec, NodeSpec } from 'prosemirror-model';

// Schema fragments for Pandoc markdown. Exported as plain objects so that other
// document types (R Markdown) can compose them through createPandocType.

const codeText = (group: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  content: 'text*',
  marks: '',
  group,
  code: true,
  defining: true,
  ...extra,
});

export const pandocNodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    attrs: { level: { default: 1 }, attrs: { default: '' } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, node.attrs.attrs ? { 'data-attrs': node.attrs.attrs } : {}, 0],
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  code_block: codeText('block', {
    attrs: { info: { default: '' }, fence: { default: '```' } },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', ['code', 0]],
  }),

  front_matter: codeText('block', {
    parseDOM: [{ tag: 'pre.front-matter', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', { class: 'front-matter' }, ['code', 0]],
  }),

  /** Tier 3: anything the parser does not recognise, kept verbatim. */
  raw_block: codeText('block', {
    parseDOM: [{ tag: 'pre.raw-block', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', { class: 'raw-block' }, ['code', 0]],
  }),

  math_display: codeText('block', {
    parseDOM: [{ tag: 'pre.math-display', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', { class: 'math-display' }, ['code', 0]],
  }),

  bullet_list: {
    attrs: { tight: { default: true }, bullet: { default: '-' } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: (node) => ['ul', { 'data-tight': node.attrs.tight ? 'true' : null }, 0],
  },

  ordered_list: {
    attrs: { order: { default: 1 }, tight: { default: true }, delim: { default: '.' } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ order: Number((dom as HTMLElement).getAttribute('start') ?? 1) }) }],
    toDOM: (node) => ['ol', { start: node.attrs.order === 1 ? null : node.attrs.order, 'data-tight': node.attrs.tight ? 'true' : null }, 0],
  },

  list_item: {
    attrs: { checked: { default: null } },
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: (node) =>
      ['li', node.attrs.checked === null ? {} : { 'data-checked': String(node.attrs.checked), class: 'task' }, 0],
  },

  footnote_def: {
    attrs: { label: { default: '1' } },
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'aside.footnote', getAttrs: (dom) => ({ label: (dom as HTMLElement).dataset.label ?? '1' }) }],
    toDOM: (node) => ['aside', { class: 'footnote', 'data-label': node.attrs.label }, 0],
  },

  fenced_div: {
    attrs: { attrs: { default: '' }, fence: { default: 3 } },
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'div.fenced-div', getAttrs: (dom) => ({ attrs: (dom as HTMLElement).dataset.attrs ?? '' }) }],
    toDOM: (node) => ['div', { class: 'fenced-div', 'data-attrs': node.attrs.attrs }, 0],
  },

  definition_list: {
    content: '(dl_term dl_def+)+',
    group: 'block',
    parseDOM: [{ tag: 'dl' }],
    toDOM: () => ['dl', 0],
  },
  dl_term: { content: 'inline*', defining: true, parseDOM: [{ tag: 'dt' }], toDOM: () => ['dt', 0] },
  dl_def: { attrs: { loose: { default: false } }, content: 'block+', defining: true, parseDOM: [{ tag: 'dd' }], toDOM: () => ['dd', 0] },

  table: {
    attrs: { align: { default: '' }, caption: { default: '' }, captionBefore: { default: false } },
    content: 'table_row+',
    group: 'block',
    isolating: true,
    parseDOM: [{ tag: 'table' }],
    toDOM: () => ['table', ['tbody', 0]],
  },
  table_row: { content: 'table_cell+', parseDOM: [{ tag: 'tr' }], toDOM: () => ['tr', 0] },
  table_cell: {
    attrs: { header: { default: false } },
    content: 'inline*',
    isolating: true,
    parseDOM: [{ tag: 'td' }, { tag: 'th', attrs: { header: true } }],
    toDOM: (node) => [node.attrs.header ? 'th' : 'td', 0],
  },

  text: { group: 'inline' },

  image: {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: { src: { default: '' }, alt: { default: '' }, title: { default: null }, attrs: { default: '' } },
    parseDOM: [{
      tag: 'img[src]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement;
        return { src: el.getAttribute('src'), alt: el.getAttribute('alt') ?? '', title: el.getAttribute('title') };
      },
    }],
    toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },

  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  raw_inline: atom('raw-inline', 'text'),
  math_inline: { ...atom('math-inline', 'tex'), attrs: { tex: { default: '' }, display: { default: false } } },
  citation: atom('citation', 'text'),
  footnote_ref: atom('footnote-ref', 'label'),
};

function atom(className: string, attr: string): NodeSpec {
  return {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { [attr]: { default: '' } },
    parseDOM: [{ tag: `span.${className}`, getAttrs: (dom) => ({ [attr]: (dom as HTMLElement).dataset.value ?? '' }) }],
    toDOM: (node) => ['span', { class: className, 'data-value': node.attrs[attr] }, String(node.attrs[attr])],
  };
}

export const pandocMarks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: { default: '' }, title: { default: null }, auto: { default: false } },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href'), title: (dom as HTMLElement).getAttribute('title') }) }],
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
  },
  span: {
    attrs: { attrs: { default: '' } },
    parseDOM: [{ tag: 'span.bracketed-span', getAttrs: (dom) => ({ attrs: (dom as HTMLElement).dataset.attrs ?? '' }) }],
    toDOM: (mark) => ['span', { class: 'bracketed-span', 'data-attrs': mark.attrs.attrs }, 0],
  },
  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: () => ['strong', 0],
  },
  strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] },
  superscript: { excludes: 'subscript', parseDOM: [{ tag: 'sup' }], toDOM: () => ['sup', 0] },
  subscript: { excludes: 'superscript', parseDOM: [{ tag: 'sub' }], toDOM: () => ['sub', 0] },
  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
};
