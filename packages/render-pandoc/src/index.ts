// Markdown rendered without Podman (decisions 0107, 0113): pandoc's WebAssembly
// build, which sees only a folder the host fills for each render, and Typst's
// (typst.ts) for PDFs, sealed in a context with nothing of Node's, given only
// copies of what it may read. A renderer, in the run component
// API's terms: it runs no code of the document's, so it needs no environment.
// R Markdown, whose chunks are code, is still the R engine's, as is a PDF a
// header asks LaTeX for, where code runs.
//
// Where the programs are: where.ts (the desktop app's resources, a bundle's
// render/ folder, or scripts/fetch-render-tools.mjs's cache).
import { defineRunComponent, type Renderer, type RenderFormat } from '@kuraa/run-kit';
import { latexAsked, renderMarkdown } from './render.js';
import { pandocWasm, typstParts } from './where.js';

export { PANDOC_VERSION, TYPST_VERSION, cacheDir, pandocWasm, typstParts } from './where.js';
export { sealGlue } from './typst.js';
export { headerOf, headerOptions } from './header.js';

const NO_PANDOC = 'pandoc is not on this computer (it comes with the app; in a checkout, `node scripts/fetch-render-tools.mjs` fetches it).';
const NO_TYPST = 'Making a PDF needs Typst’s fonts, which are not on this computer (they come with the app; in a checkout, `node scripts/fetch-render-tools.mjs` fetches them).';

export const pandocRenderer: Renderer = {
  id: 'pandoc',
  label: 'pandoc and Typst',
  extensions: ['.md', '.markdown'],
  formats: ['html', 'docx', 'pdf', 'epub'],
  async unavailable(format: RenderFormat) {
    if (!pandocWasm()) return NO_PANDOC;
    if (format === 'pdf' && !typstParts()) return NO_TYPST;
    return null;
  },
  async prefersEngine(req) {
    if (req.format !== 'pdf') return null;
    const latex = await latexAsked(req.input);
    return latex ? `The header asks for ${latex}, which is used where code runs.` : null;
  },
  async render(ctx, req) {
    const wasm = pandocWasm();
    if (!wasm) return { ok: false, message: NO_PANDOC, log: '' };
    return renderMarkdown(ctx, req, { wasm, typst: typstParts() });
  },
};

export default defineRunComponent({
  name: '@kuraa/render-pandoc',
  renderers: [pandocRenderer],
});
