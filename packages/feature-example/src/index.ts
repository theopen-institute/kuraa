// An example feature (docs/decisions/0082-annotations.md): marks, passages
// someone marked in a document, kept beside it. Not in the standard list: it is
// what the tests use to drive every hook a feature has, and a model for writing
// one. Its host half is here; its client half is ./client.
//
//   its file type      `<document>.marks/@<id>.json`, merged by id (marks.ts)
//   its companions     each person's marks file, in a folder beside each document
//   its room state     each person's marks, by id: anchors at their ends, live as people type
//   its routes         GET all (everyone's marks on every document), POST clear (yours on one)
//   what it listens to renames and settings, to say so in the host's log
import { createTextType } from '@kuraa/format-text';
import { defineFeature, type FeatureResponse, type Json } from '@kuraa/feature-kit/host';
import { OWN_NAME } from '@kuraa/feature-kit/host';
import { EXTENSION, SUFFIX, describeMarks, findQuote, mergeMarks, readMarks, writeMarks } from './marks.js';

export { EXTENSION, SUFFIX, readMarks, writeMarks, mergeMarks, findQuote, type Mark } from './marks.js';

/** What a mark is in a room: its ends as anchors, or (lost) where it last was. */
export type RoomMark =
  | { from: Json; to: Json; quote: string; by: string; color: string }
  | { lost: true; start: number | null; end: number | null; quote: string; by: string; color: string };

/** Marks files: shown as JSON, merged by id (a person's two devices may both write theirs). Above the text type, which would take any .json. */
const textOfMarks = createTextType({ id: 'marks', label: 'Marks', description: 'What the marks example keeps beside a document', files: [{ extensions: [EXTENSION], language: 'json' }], priority: 5 });
const marksType = {
  ...textOfMarks,
  match: (path: string) => OWN_NAME.test(path.slice(path.lastIndexOf('/') + 1)) && path.slice(0, path.lastIndexOf('/')).endsWith(SUFFIX) && path.endsWith(EXTENSION),
  merge: (base: string, a: string, b: string) => ({ text: mergeMarks(base, a, b), conflicts: 0 }),
  conflicts: () => 0,
};

export const marksFeature = defineFeature({
  id: 'marks',
  label: 'Marks (example)',
  description: 'Mark passages in a document, kept beside it in a file of their own.',
  types: [marksType],
  companions: [SUFFIX],
  room: {
    companion: SUFFIX,
    extension: EXTENSION,
    seed({ companion, text, sourceMap, anchorAt }) {
      const out: { [id: string]: Json } = {};
      for (const m of readMarks(companion)) {
        const at = findQuote(text, m.quote, m.start);
        const base = { quote: m.quote, by: m.by, color: m.color };
        if (at === null) {
          out[m.id] = { lost: true, start: m.start, end: m.end, ...base };
          continue;
        }
        out[m.id] = { from: anchorAt(sourceMap.toDoc(at), 1), to: anchorAt(sourceMap.toDoc(at + m.quote.length, -1), -1), ...base };
      }
      return out;
    },
    // The file as it is, with what its person changed here: their other marks stay as the file says.
    write({ entries, removed, companion, text, sourceMap, positionOf }) {
      const marks = new Map(readMarks(companion).map((m) => [m.id, m]));
      for (const id of removed) marks.delete(id);
      for (const [id, v] of Object.entries(entries)) {
        const m = v as RoomMark;
        if (!m || typeof m !== 'object' || typeof m.quote !== 'string') continue;
        const base = { id, quote: m.quote, by: m.by ?? '', color: m.color ?? '' };
        if ('lost' in m) {
          marks.set(id, { ...base, start: m.start, end: m.end });
          continue;
        }
        const from = positionOf(m.from);
        const to = positionOf(m.to);
        if (from === null || to === null || to <= from) {
          // Its text is gone: kept, with no place, never dropped.
          marks.set(id, { ...base, start: null, end: null });
          continue;
        }
        const start = sourceMap.toText(from);
        const end = sourceMap.toText(to, -1);
        marks.set(id, { ...base, start, end, quote: text.slice(start, end) });
      }
      return writeMarks([...marks.values()]);
    },
  },
  describe: ({ before, after }) => describeMarks(before, after),
  open(ctx) {
    ctx.on('rename', ({ from, to }) => ctx.log(`${from} is now ${to}; its marks went with it`));
    ctx.on('settings', ({ settings }) => ctx.log(`settings are now ${JSON.stringify(settings)}`));
    return {
      routes: [
        {
          method: 'GET',
          path: 'all',
          async handle(): Promise<FeatureResponse> {
            const out: Json[] = [];
            for (const p of await ctx.list()) {
              const doc = ctx.documentOf(p);
              if (!doc) continue;
              const person = p.slice(p.lastIndexOf('/@') + 2, p.lastIndexOf('/@') + 66);
              out.push({ path: doc, person, marks: readMarks(await ctx.read(p)) as unknown as Json });
            }
            return { body: out };
          },
        },
        {
          method: 'POST',
          path: 'clear',
          async handle({ body, person }): Promise<FeatureResponse> {
            const path = (body as { path?: unknown } | undefined)?.path;
            if (typeof path !== 'string') return { status: 400, body: { error: 'Which document?' } };
            await ctx.write(ctx.companionOf(path), null, { by: person });
            return { body: { cleared: path } };
          },
        },
      ],
    };
  },
});

export default marksFeature;
