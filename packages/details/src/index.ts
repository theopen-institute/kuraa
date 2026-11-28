// Document details (docs/decisions/0094-word-counts-and-document-details.md):
// a synopsis, a label, a status and keywords for each document, kept in its
// header. Its host half reads every document's, for the file tree's marks and
// the panel's suggestions, and tells the client halves when a document's
// change (here, or arriving from elsewhere).
//
//   its routes   GET documents
//   it writes    nothing: details are set in the open document, as any edit
//   its settings statuses: the statuses offered (Scrivener's, where none)
import { defineFeature, type FeatureContext, type Json } from '@kuraa/feature-kit/host';
import { detailsOfText, hasDetails, isEmpty, type Details } from './details.js';

export { detailsOfText, type Details } from './details.js';

export const detailsFeature = defineFeature({
  id: 'details',
  label: 'Document details',
  description: 'A synopsis, a label, a status and keywords for each document, kept in its header; labels coloured in the file tree.',
  onByDefault: true,
  open(ctx: FeatureContext) {
    /** What is known of each document's details, by path: only those with any. */
    let known: Map<string, Details> | null = null;
    const readAll = async () => {
      const out = new Map<string, Details>();
      for (const p of await ctx.list()) {
        const type = ctx.typeOf(p);
        if (!hasDetails(type) || ctx.documentOf(p) !== null) continue;
        const text = await ctx.read(p);
        const d = text === null ? null : detailsOfText(type, text);
        if (d && !isEmpty(d)) out.set(p, d);
      }
      return out;
    };
    const all = async () => (known ??= await readAll());
    /** A document's details again, from its text: said to the client halves if they changed. */
    const again = async (path: string, text: string | null) => {
      const type = ctx.typeOf(path);
      if (!known || !hasDetails(type)) return;
      const d = text === null ? null : detailsOfText(type, text);
      const was = known.get(path);
      if (JSON.stringify(was ?? null) === JSON.stringify(d && !isEmpty(d) ? d : null)) return;
      if (d && !isEmpty(d)) known.set(path, d);
      else known.delete(path);
      ctx.tell({ changed: path });
    };
    const forget = () => {
      known = null;
      ctx.tell({ changed: '' });
    };
    const stops = [
      ctx.on('save', ({ path, text }) => void again(path, text)),
      ctx.on('rename', forget),
      ctx.on('delete', forget),
      ctx.on('merge', forget),
    ];
    return {
      routes: [{
        method: 'GET',
        path: 'documents',
        handle: async () => ({ body: { documents: Object.fromEntries(await all()) } as unknown as Json }),
      }],
      close: () => stops.forEach((s) => s()),
    };
  },
});
