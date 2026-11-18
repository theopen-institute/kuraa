// The document's header: the YAML metadata block at the top of a Pandoc file.
// It is edited in the client's Header dialog, not in the page: here it is drawn
// as nothing, the cursor is kept out of it, and typing cannot change it. The
// Source view shows it as text, and edits there (and the dialog's) go through.
//
// pandocHeaderFields is what the dialog offers to add: Pandoc's own metadata
// fields and the template variables people most often set in the header.
import { DELIBERATE_EDIT, type EditorContext, type HeaderField, type HeaderSpec } from '@kuraa/editor-kit';
import type { Node as PMNode, NodeType, Schema } from 'prosemirror-model';
import { AllSelection, NodeSelection, Plugin, Selection, TextSelection } from 'prosemirror-state';
import type { NodeViewConstructor } from 'prosemirror-view';

const HEADER_NODE = 'front_matter';

const TITLE = 'Title and authors';
const LANGUAGE = 'Language';
const CITATIONS = 'Citations';
const CONTENTS = 'Contents and numbering';
const PDF = 'Page and fonts (PDF)';
const HTML = 'Web page (HTML)';
const SLIDES = 'Slides';
const INCLUDES = 'Raw additions';

export const pandocHeaderFields: HeaderField[] = [
  { key: 'title', label: 'Title', group: TITLE, kind: 'text' },
  { key: 'subtitle', label: 'Subtitle', group: TITLE, kind: 'text' },
  { key: 'author', label: 'Authors', description: 'One per line.', group: TITLE, kind: 'list' },
  { key: 'date', label: 'Date', description: 'Written as you want it shown.', group: TITLE, kind: 'date' },
  { key: 'abstract', label: 'Abstract', group: TITLE, kind: 'paragraph' },
  { key: 'abstract-title', label: 'Abstract heading', description: 'Instead of “Abstract”.', group: TITLE, kind: 'text' },
  { key: 'keywords', label: 'Keywords', description: 'Stored in the PDF, HTML, EPUB or Word file’s properties.', group: TITLE, kind: 'list' },
  { key: 'subject', label: 'Subject', description: 'Stored in the file’s properties.', group: TITLE, kind: 'text' },
  { key: 'description', label: 'Description', description: 'Stored in the file’s properties.', group: TITLE, kind: 'paragraph' },
  { key: 'category', label: 'Category', description: 'Stored in the Word file’s properties.', group: TITLE, kind: 'text' },
  { key: 'thanks', label: 'Thanks', description: 'A footnote on the title (PDF).', group: TITLE, kind: 'text' },

  { key: 'lang', label: 'Language', description: 'An IETF language tag: hyphenation, quotation marks and spell checking in the output.', group: LANGUAGE, kind: 'text', choices: ['en', 'en-US', 'en-GB', 'de', 'de-DE', 'fr', 'fr-FR', 'es', 'it', 'nl', 'pt', 'pt-BR', 'sv', 'da', 'nb', 'fi', 'pl', 'ru', 'ja', 'zh', 'ko', 'ar', 'he'] },
  { key: 'dir', label: 'Text direction', description: 'ltr or rtl.', group: LANGUAGE, kind: 'text', choices: ['ltr', 'rtl'] },

  { key: 'bibliography', label: 'Bibliography files', description: 'BibTeX, CSL JSON or other bibliography files, relative to this one.', group: CITATIONS, kind: 'list', choices: ['references.bib'] },
  { key: 'csl', label: 'Citation style', description: 'A CSL style file or its URL; Chicago author-date if not set.', group: CITATIONS, kind: 'text', choices: ['apa.csl', 'chicago-note-bibliography.csl', 'ieee.csl', 'nature.csl'] },
  { key: 'link-citations', label: 'Link citations', description: 'Citations link to their entry in the bibliography.', group: CITATIONS, kind: 'boolean' },
  { key: 'link-bibliography', label: 'Link bibliography', description: 'DOIs and URLs in the bibliography are links.', group: CITATIONS, kind: 'boolean' },
  { key: 'reference-section-title', label: 'Bibliography heading', description: 'A heading put above the bibliography.', group: CITATIONS, kind: 'text', choices: ['References', 'Bibliography', 'Works cited'] },
  { key: 'nocite', label: 'Also list', description: 'Entries listed though not cited: @key @key, or @* for every entry.', group: CITATIONS, kind: 'text', choices: ['@*'] },
  { key: 'suppress-bibliography', label: 'No bibliography', description: 'Format citations but leave out the bibliography.', group: CITATIONS, kind: 'boolean' },
  { key: 'notes-after-punctuation', label: 'Notes after punctuation', description: 'In note styles, a footnote mark goes after a following comma or full stop.', group: CITATIONS, kind: 'boolean', initial: false },

  { key: 'toc', label: 'Table of contents', description: 'In PDF output. (Elsewhere, Pandoc’s --toc.)', group: CONTENTS, kind: 'boolean' },
  { key: 'toc-title', label: 'Contents heading', description: 'Instead of “Contents”.', group: CONTENTS, kind: 'text' },
  { key: 'toc-depth', label: 'Contents depth', description: 'How many heading levels the contents list.', group: CONTENTS, kind: 'number', initial: 3 },
  { key: 'numbersections', label: 'Number sections', description: 'In PDF output. (Elsewhere, Pandoc’s --number-sections.)', group: CONTENTS, kind: 'boolean' },
  { key: 'secnumdepth', label: 'Numbering depth', description: 'How many heading levels are numbered (PDF).', group: CONTENTS, kind: 'number', initial: 3 },
  { key: 'lof', label: 'List of figures', description: 'In PDF output.', group: CONTENTS, kind: 'boolean' },
  { key: 'lot', label: 'List of tables', description: 'In PDF output.', group: CONTENTS, kind: 'boolean' },

  { key: 'documentclass', label: 'Document class', description: 'The LaTeX class: the overall look of a PDF.', group: PDF, kind: 'text', choices: ['article', 'report', 'book', 'memoir', 'scrartcl', 'scrreprt', 'scrbook'] },
  { key: 'classoption', label: 'Class options', group: PDF, kind: 'list', choices: ['oneside', 'twoside', 'twocolumn', 'landscape'] },
  { key: 'papersize', label: 'Paper size', group: PDF, kind: 'text', choices: ['a4', 'letter', 'a5', 'legal'] },
  { key: 'geometry', label: 'Margins', description: 'Options for the geometry package, one per line.', group: PDF, kind: 'list', choices: ['margin=1in', 'margin=2.5cm', 'left=3cm', 'right=3cm', 'top=2cm', 'bottom=2cm'] },
  { key: 'fontsize', label: 'Font size', group: PDF, kind: 'text', choices: ['10pt', '11pt', '12pt'] },
  { key: 'mainfont', label: 'Main font', description: 'A font installed on the computer that makes the PDF (XeLaTeX or LuaLaTeX).', group: PDF, kind: 'text' },
  { key: 'sansfont', label: 'Sans-serif font', group: PDF, kind: 'text' },
  { key: 'monofont', label: 'Monospace font', group: PDF, kind: 'text' },
  { key: 'mathfont', label: 'Maths font', group: PDF, kind: 'text' },
  { key: 'fontfamily', label: 'Font package', description: 'A LaTeX font package (pdfLaTeX).', group: PDF, kind: 'text', choices: ['lmodern', 'libertinus', 'mathpazo', 'times', 'charter'] },
  { key: 'linestretch', label: 'Line spacing', description: '1.25 for a little more, 2 for double.', group: PDF, kind: 'number', initial: 1.25 },
  { key: 'indent', label: 'Indent paragraphs', description: 'Instead of a space between them.', group: PDF, kind: 'boolean' },
  { key: 'pagestyle', label: 'Page style', group: PDF, kind: 'text', choices: ['plain', 'empty', 'headings'] },
  { key: 'colorlinks', label: 'Coloured links', group: PDF, kind: 'boolean' },
  { key: 'linkcolor', label: 'Link colour', description: 'Also for HTML.', group: PDF, kind: 'text', choices: ['blue', 'red', 'teal', 'magenta'] },
  { key: 'urlcolor', label: 'URL colour', group: PDF, kind: 'text', choices: ['blue', 'red', 'teal', 'magenta'] },
  { key: 'citecolor', label: 'Citation colour', group: PDF, kind: 'text', choices: ['blue', 'red', 'teal', 'magenta'] },
  { key: 'links-as-notes', label: 'Links as footnotes', description: 'Print each link’s address in a footnote.', group: PDF, kind: 'boolean' },

  { key: 'document-css', label: 'Pandoc’s styles', description: 'Use Pandoc’s built-in CSS even with a stylesheet of your own.', group: HTML, kind: 'boolean' },
  { key: 'css', label: 'Stylesheets', description: 'CSS files, relative to this one.', group: HTML, kind: 'list' },
  { key: 'maxwidth', label: 'Maximum width', group: HTML, kind: 'text', choices: ['36em', '48em', '60em'] },
  { key: 'backgroundcolor', label: 'Background colour', group: HTML, kind: 'text' },
  { key: 'fontcolor', label: 'Text colour', group: HTML, kind: 'text' },
  { key: 'monobackgroundcolor', label: 'Code background', group: HTML, kind: 'text' },

  { key: 'theme', label: 'Theme', description: 'For Beamer or reveal.js slides.', group: SLIDES, kind: 'text', choices: ['default', 'metropolis', 'Madrid', 'Warsaw', 'black', 'white', 'moon', 'serif'] },
  { key: 'colortheme', label: 'Colour theme', description: 'Beamer.', group: SLIDES, kind: 'text', choices: ['default', 'beaver', 'dolphin', 'seahorse', 'whale'] },
  { key: 'aspectratio', label: 'Aspect ratio', description: 'Beamer: 169 for 16:9, 43 for 4:3.', group: SLIDES, kind: 'text', choices: ['169', '1610', '43'] },
  { key: 'institute', label: 'Institutes', description: 'Beamer.', group: SLIDES, kind: 'list' },

  { key: 'header-includes', label: 'Header includes', description: 'Raw LaTeX or HTML added to the output’s preamble, one per line.', group: INCLUDES, kind: 'list' },
  { key: 'include-before', label: 'Before the text', description: 'Raw content put before the document’s text.', group: INCLUDES, kind: 'list' },
  { key: 'include-after', label: 'After the text', description: 'Raw content put after the document’s text.', group: INCLUDES, kind: 'list' },
];

export function headerSpec(extra: HeaderField[] = []): HeaderSpec {
  const keys = new Set(extra.map((f) => f.key));
  return { node: HEADER_NODE, fields: [...pandocHeaderFields.filter((f) => !keys.has(f.key)), ...extra] };
}

/** The header block, drawn as nothing. */
const hidden: NodeViewConstructor = () => {
  const dom = document.createElement('div');
  dom.className = 'doc-header-hidden';
  dom.hidden = true;
  dom.contentEditable = 'false';
  return { dom, ignoreMutation: () => true, stopEvent: () => true };
};

/** Where the page's content starts: after the header, or 0 without one. */
const headerEnd = (doc: PMNode, type: NodeType): number => (doc.firstChild?.type === type ? doc.firstChild.nodeSize : 0);

/**
 * The cursor kept out of the header (a selection reaching into it starts after
 * it instead), and the header kept from changes typed in the page. Edits made on
 * purpose (DELIBERATE_EDIT), and other people's, go through.
 */
function headerGuard(type: NodeType, ctx: EditorContext): Plugin {
  return new Plugin({
    filterTransaction(tr) {
      if (!tr.docChanged || tr.getMeta(DELIBERATE_EDIT) || ctx.isRemote(tr)) return true;
      const before = tr.before.firstChild;
      if (before?.type !== type) return true;
      const after = tr.doc.firstChild;
      return !!after && after.eq(before);
    },
    appendTransaction(_trs, _old, state) {
      const end = headerEnd(state.doc, type);
      const sel = state.selection;
      if (!end || (sel.from >= end && !(sel instanceof AllSelection))) return null;
      const start = Selection.findFrom(state.doc.resolve(end), 1);
      if (!start) return null;
      if (sel.empty || sel instanceof NodeSelection) return state.tr.setSelection(start);
      const clamp = (pos: number) => state.doc.resolve(Math.max(pos, start.from));
      return state.tr.setSelection(TextSelection.between(clamp(sel.anchor), clamp(sel.head)));
    },
  });
}

/** What the header needs in the editor: its plugin and its (empty) node view. */
export function headerBehaviour(schema: Schema, ctx: EditorContext): { plugins: Plugin[]; nodeViews: Record<string, NodeViewConstructor> } {
  const type = schema.nodes[HEADER_NODE];
  if (!type) return { plugins: [], nodeViews: {} };
  return { plugins: ctx.readOnly ? [] : [headerGuard(type, ctx)], nodeViews: { [HEADER_NODE]: hidden } };
}
