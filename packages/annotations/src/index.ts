// Annotations (docs/decisions/0082-annotations.md): coding and comments on
// documents, kept beside them, never in them. Its host half is here; its client
// half is ./client; the files' format, which both share, ./format.
//
// Step 2 of the build: comments and replies, on passages and on documents, on
// the base coding will share. Each person's are their own file, in a folder
// beside the document, a W3C AnnotationPage; in a room, their own map, by
// annotation id: { item } (the annotation as JSON-LD), with anchors at its
// passage's ends ({ from, to }) while it is found, or `lost` once its passage
// is gone (kept, never dropped).
import { createTextType } from '@kuraa/format-text';
import { OWN_NAME, defineFeature, type FeatureResponse, type Json } from '@kuraa/feature-kit/host';
import { EXTENSION, SUFFIX, aboutOf, creatorOf, describePages, findPassage, kindOf, mergePages, readPage, selectorsFor, textOf, writePage, type Item } from './format.js';

export * from './format.js';

/** An annotation in a room: the annotation, and while its passage is found, anchors at its ends. */
export interface RoomAnnotation {
  item: Item;
  from?: Json;
  to?: Json;
  lost?: boolean;
}

/** People's annotation files: shown as JSON-LD text, merged by id (a person's two devices may both write theirs). */
const pageType = {
  ...createTextType({ id: 'annotations', label: 'Annotations', description: 'A person’s annotations on a document, kept beside it', files: [{ extensions: [EXTENSION], language: 'json' }], priority: 5 }),
  match: (path: string) => OWN_NAME.test(path.slice(path.lastIndexOf('/') + 1)) && path.slice(0, path.lastIndexOf('/')).endsWith(SUFFIX) && path.endsWith(EXTENSION),
  merge: (base: string, a: string, b: string) => ({ text: mergePages(base, a, b), conflicts: 0 }),
  conflicts: () => 0,
};

/** The document as an annotation's file names it: beside it, one folder up. */
const sourceOf = (path: string) => `../${path.slice(path.lastIndexOf('/') + 1)}`;

export const annotationsFeature = defineFeature({
  id: 'annotations',
  label: 'Annotations',
  description: 'Comment on passages and documents, and reply: each person’s kept beside the document in a file of their own, never in it.',
  types: [pageType],
  companions: [SUFFIX],
  room: {
    companion: SUFFIX,
    extension: EXTENSION,
    seed({ companion, text, sourceMap, anchorAt }) {
      const out: { [id: string]: Json } = {};
      for (const item of readPage(companion)) {
        const about = aboutOf(item);
        if (about?.kind !== 'passage') {
          out[String(item.id)] = { item } as unknown as Json;
          continue;
        }
        const at = findPassage(text, about);
        out[String(item.id)] = (at
          ? { item, from: anchorAt(sourceMap.toDoc(at.from), 1), to: anchorAt(sourceMap.toDoc(at.to, -1), -1) }
          : { item, lost: true }) as unknown as Json;
      }
      return out;
    },
    // The file as it is, with what its person changed here; each passage named as the text has it now.
    write({ path, person, entries, removed, companion, text, sourceMap, positionOf }) {
      const items = new Map(readPage(companion).map((i) => [String(i.id), i]));
      for (const id of removed) items.delete(id);
      for (const [id, v] of Object.entries(entries)) {
        const e = v as unknown as RoomAnnotation;
        if (!e || typeof e !== 'object' || !e.item || typeof e.item !== 'object') continue;
        let item: Item = { ...e.item, id };
        if (e.from !== undefined && e.to !== undefined && !e.lost) {
          const from = positionOf(e.from);
          const to = positionOf(e.to);
          if (from !== null && to !== null && to > from) {
            const start = sourceMap.toText(from);
            const end = sourceMap.toText(to, -1);
            item = { ...item, target: { source: sourceOf(path), selector: selectorsFor(text, start, end) } };
          }
          // Its text gone: kept as it was named last, to be found again or placed anew.
        }
        items.set(id, item);
      }
      return writePage([...items.values()], person);
    },
  },
  describe: ({ before, after }) => describePages(before, after),
  open(ctx) {
    return {
      routes: [
        {
          // The workspace's newest comments and replies, everyone's, on the documents this device holds.
          method: 'GET',
          path: 'recent',
          async handle({ query }): Promise<FeatureResponse> {
            const limit = Math.min(Number(query.get('limit')) || 50, 200);
            const out: { path: string; id: string; kind: string; text: string; by: string; created: string; quote: string | null; at: { from: number; to: number } | null }[] = [];
            for (const p of await ctx.list()) {
              const doc = ctx.documentOf(p);
              if (!doc) continue;
              const items = readPage(await ctx.read(p));
              if (!items.length) continue;
              const docText = await ctx.read(doc);
              for (const item of items) {
                const kind = kindOf(item);
                if (kind === 'other') continue;
                const about = aboutOf(item);
                const found = about?.kind === 'passage' && docText !== null ? findPassage(docText, about) : null;
                out.push({ path: doc, id: String(item.id), kind, text: textOf(item), by: creatorOf(item), created: String(item.created ?? ''), quote: about?.kind === 'passage' ? about.exact : null, at: found });
              }
            }
            out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
            return { body: out.slice(0, limit) as unknown as Json };
          },
        },
      ],
    };
  },
});

export default annotationsFeature;
