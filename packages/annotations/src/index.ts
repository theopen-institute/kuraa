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
import { mergeLines } from '@kuraa/kernel';
import { OWN_NAME, defineFeature, type FeatureResponse, type Json } from '@kuraa/feature-kit/host';
import { EXTENSION, SUFFIX, aboutOf, codeOf, creatorOf, describePages, findPassage, kindOf, mergePages, readPage, selectorsFor, textOf, writePage, type Item } from './format.js';
import { CODEBOOK, COLOURS, TOP_CODEBOOK, codeAndBelow, mergeCodebooks, parseCodebook, randomId, readCodebook, resolveCode, writeCodebook } from './codebook.js';
import type { FeatureContext, FeatureSettings } from '@kuraa/feature-kit/host';

export * from './format.js';
export * from './codebook.js';

/** Whether a workspace codes (a setting of its own: comments are for any workspace, coding a method a project chooses). */
export const codingOn = (settings: FeatureSettings) => settings.coding === true;
/** The codebook a workspace's setting names, if it names one it may (see codebookPath); null for none. */
const chosenCodebook = (settings: FeatureSettings): string | null =>
  typeof settings.codebook === 'string' && (settings.codebook === CODEBOOK || settings.codebook === TOP_CODEBOOK || /^(?:[^/.\0][^\0]*\/)?[^/\0]+\.codebook\.jsonld$/.test(settings.codebook)) && !settings.codebook.split('/').includes('..') ? settings.codebook : null;
/**
 * Where a workspace keeps its codebook: its setting (.kuraa/codebook.jsonld, codebook.jsonld at the top, or a name ending
 * .codebook.jsonld, so that the codebook type knows it by its name and merges it as one), else .kuraa/codebook.jsonld,
 * with the workspace's other settings and records.
 */
export const codebookPath = (settings: FeatureSettings) => chosenCodebook(settings) ?? CODEBOOK;

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

/**
 * The codebook: shown as JSON-LD text, merged by code (everyone's, changed at once on several devices). Known by its name
 * (.kuraa/codebook.jsonld, codebook.jsonld at the top, or a name ending .codebook.jsonld, as codebookPath allows): never a file elsewhere that
 * happens to be called codebook.jsonld. Where a side is not a codebook (a hand edit gone wrong), merged line by line instead,
 * a conflict kept for people to settle, never its codes taken for removed.
 */
const codebookType = {
  ...createTextType({ id: 'codebook', label: 'Codebook', description: 'A workspace’s codes, for coding passages', files: [{ extensions: ['.jsonld'], language: 'json' }], priority: 4, version: 2 }),
  match: (path: string) => path === CODEBOOK || path === TOP_CODEBOOK || path.endsWith('.codebook.jsonld'),
  merge: (base: string, a: string, b: string, sides: Parameters<typeof mergeLines>[3]) => {
    const merged = mergeCodebooks(base, a, b);
    return merged === null ? mergeLines(base, a, b, sides) : { text: merged, conflicts: 0 };
  },
};

/** Everyone's codings this device holds: in each person's file beside each document. */
async function everyonesCodings(ctx: FeatureContext): Promise<{ path: string; person: string; item: Item; docText: string | null }[]> {
  const out: { path: string; person: string; item: Item; docText: string | null }[] = [];
  const texts = new Map<string, string | null>();
  for (const p of await ctx.list()) {
    const doc = ctx.documentOf(p);
    if (!doc) continue;
    const items = readPage(await ctx.read(p)).filter((i) => kindOf(i) === 'coding');
    if (!items.length) continue;
    if (!texts.has(doc)) texts.set(doc, await ctx.read(doc));
    const person = p.slice(p.lastIndexOf('/@') + 2, p.lastIndexOf('/@') + 66);
    for (const item of items) out.push({ path: doc, person, item, docText: texts.get(doc) ?? null });
  }
  return out;
}

/** The document as an annotation's file names it: beside it, one folder up. */
const sourceOf = (path: string) => `../${path.slice(path.lastIndexOf('/') + 1)}`;

export const annotationsFeature = defineFeature({
  id: 'annotations',
  label: 'Annotations',
  description: 'Comment on passages and documents, and reply: each person’s kept beside the document in a file of their own, never in it.',
  types: [pageType, codebookType],
  companions: [SUFFIX],
  // Where the workspace names none, the one at the top too: to move it into .kuraa.
  files: (settings) => (chosenCodebook(settings) ? [codebookPath(settings)] : [CODEBOOK, TOP_CODEBOOK]),
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
    // Changes to the codebook, one at a time: each reads what the last wrote.
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = queue.then(fn, fn);
      queue = next.catch(() => undefined);
      return next;
    };
    /**
     * Where the codebook is now: where codebookPath says, except that one still at the top (not yet moved: this device
     * may not change .kuraa, say, or it came from a device on 0.6.0) is used until it is.
     */
    const where = async () => {
      const path = codebookPath(ctx.settings());
      if (chosenCodebook(ctx.settings()) || (await ctx.read(path)) !== null) return path;
      return (await ctx.read(TOP_CODEBOOK)) !== null ? TOP_CODEBOOK : path;
    };
    const codebook = async () => readCodebook(await ctx.read(await where()));
    /** The codebook to change: null (refused, never overwritten) where its file is not a codebook as it stands. */
    const codebookToChange = async () => parseCodebook(await ctx.read(await where()));
    /**
     * A codebook at the workspace's top, where the workspace names none, moved into .kuraa: in one commit, its history
     * following it. Where both are there (a device on 0.6.0 made one at the top since), the top one's codes merged in and
     * it removed. Left as it is where this device may not (it is used from there meanwhile), or where either is not a
     * codebook as it stands (a hand edit gone wrong: people put it right first).
     */
    const moveIn = () => inTurn(async () => {
      if (chosenCodebook(ctx.settings())) return;
      const top = await ctx.read(TOP_CODEBOOK);
      if (top === null) return;
      try {
        const kept = await ctx.read(CODEBOOK);
        if (kept === null) await ctx.move(TOP_CODEBOOK, CODEBOOK);
        else {
          const merged = parseCodebook(top) && parseCodebook(kept) ? mergeCodebooks('', kept, top) : null;
          if (merged === null) return ctx.log(`${TOP_CODEBOOK} and ${CODEBOOK} are both here, and one is not a codebook as it stands: neither changed`);
          await ctx.write(CODEBOOK, merged);
          await ctx.write(TOP_CODEBOOK, null);
        }
        ctx.tell({ codebook: true });
      } catch (e) {
        ctx.log(`${TOP_CODEBOOK} not moved into .kuraa: ${(e as Error).message}`);
      }
    });
    void moveIn();
    // Again where one comes in from a device on 0.6.0, or the workspace stops naming its own.
    ctx.on('merge', ({ paths }) => {
      if (paths.includes(TOP_CODEBOOK)) void moveIn();
    });
    ctx.on('settings', () => void moveIn());
    return {
      routes: [
        {
          // The codebook, and whether the workspace codes.
          method: 'GET',
          path: 'codebook',
          async handle(): Promise<FeatureResponse> {
            return { body: { path: await where(), coding: codingOn(ctx.settings()), book: (await codebook()) as unknown as Json } };
          },
        },
        {
          // Change the codebook: add, change (name, definition, colour, parent), merge one code into another, delete one.
          method: 'POST',
          path: 'codebook',
          handle: ({ body, person }) => inTurn(async (): Promise<FeatureResponse> => {
            if (!codingOn(ctx.settings())) return { status: 409, body: { error: 'Coding is off for this workspace' } };
            const b = (body ?? {}) as { op?: string; id?: string; into?: string; label?: string; definition?: string | null; color?: string; broader?: string | null };
            const book = await codebookToChange();
            if (!book) return { status: 409, body: { error: `${await where()} is not a codebook as it stands (perhaps an edit by hand went wrong): put it right first, and nothing of it is lost` } };
            const now = new Date().toISOString();
            const byId = new Map(book.codes.map((c) => [c.id, c]));
            const label = typeof b.label === 'string' ? b.label.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
            const colour = typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color.toLowerCase() : undefined;
            const parentOk = (parent: string | null | undefined, self?: string) => parent === null || parent === undefined || (byId.has(parent) && (!self || !codeAndBelow(book, self).has(parent)));
            let id = b.id;
            if (b.op === 'add') {
              if (!label) return { status: 400, body: { error: 'A code needs a name' } };
              if (!parentOk(b.broader)) return { status: 400, body: { error: 'No such code to put it under' } };
              id = `urn:uuid:${randomId()}`;
              book.codes.push({ id, label, ...(b.broader ? { broader: b.broader } : {}), color: colour ?? COLOURS[book.codes.length % COLOURS.length]!, ...(typeof b.definition === 'string' && b.definition.trim() ? { definition: b.definition.trim() } : {}), modified: now });
            } else {
              const code = id ? byId.get(id) : undefined;
              if (!code) return { status: 404, body: { error: 'No such code' } };
              if (b.op === 'change') {
                if (label !== undefined && !label) return { status: 400, body: { error: 'A code needs a name' } };
                if (!parentOk(b.broader, code.id)) return { status: 400, body: { error: 'A code cannot be put under itself, or one under it' } };
                if (label) code.label = label;
                if (b.definition !== undefined) {
                  if (b.definition && b.definition.trim()) code.definition = b.definition.trim();
                  else delete code.definition;
                }
                if (colour) code.color = colour;
                if (b.broader !== undefined) {
                  if (b.broader) code.broader = b.broader;
                  else delete code.broader;
                }
              } else if (b.op === 'merge') {
                const into = b.into ? resolveCode(book, b.into) : null;
                if (!into || into.id === code.id || codeAndBelow(book, code.id).has(into.id)) return { status: 400, body: { error: 'Merge it into another code, not itself or one under it' } };
                // Kept, saying what replaces it: codings of it, everyone's own, count as the other's. Its children move up to it.
                code.replacedBy = into.id;
                for (const c of book.codes) if (c.broader === code.id) {
                  c.broader = into.id;
                  c.modified = now;
                }
              } else if (b.op === 'delete') {
                for (const c of book.codes) if (c.broader === code.id) {
                  if (code.broader) c.broader = code.broader;
                  else delete c.broader;
                  c.modified = now;
                }
                // Kept, marked deleted, never taken away: codings may name it that no device here can see (not yet saved, on
                // another device, of a code merged into it), and they are their makers' own, not to be rewritten.
                code.deleted = true;
              } else return { status: 400, body: { error: 'Not a change to the codebook' } };
              code.modified = now;
            }
            await ctx.write(await where(), writeCodebook(book), { by: person });
            ctx.tell({ codebook: true });
            return { body: { id: id ?? null, book: book as unknown as Json } };
          }),
        },
        {
          // How many passages each code has (merged codes' counting as what replaces them), everyone's, this device holds.
          method: 'GET',
          path: 'counts',
          async handle(): Promise<FeatureResponse> {
            const book = await codebook();
            const counts: { [id: string]: number } = {};
            for (const c of await everyonesCodings(ctx)) {
              const id = codeOf(c.item);
              const code = id ? resolveCode(book, id) : null;
              if (code) counts[code.id] = (counts[code.id] ?? 0) + 1;
            }
            return { body: counts };
          },
        },
        {
          // Every passage coded with a code (and the codes under it, if asked), across the documents this device holds.
          method: 'GET',
          path: 'retrieve',
          async handle({ query }): Promise<FeatureResponse> {
            const book = await codebook();
            const wanted = query.get('code') ?? '';
            if (!book.codes.some((c) => c.id === wanted)) return { status: 404, body: { error: 'No such code' } };
            const codes = query.get('below') === '1' ? codeAndBelow(book, wanted) : new Set(book.codes.filter((c) => resolveCode(book, c.id)?.id === wanted || c.id === wanted).map((c) => c.id));
            const rows: Json[] = [];
            for (const c of await everyonesCodings(ctx)) {
              const id = codeOf(c.item);
              if (!id || !codes.has(id)) continue;
              const about = aboutOf(c.item);
              const at = about?.kind === 'passage' && c.docText !== null ? findPassage(c.docText, about) : null;
              rows.push({ path: c.path, person: c.person, id: String(c.item.id), code: resolveCode(book, id)?.id ?? id, by: creatorOf(c.item), created: String(c.item.created ?? ''), quote: about?.kind === 'passage' ? about.exact : null, at });
            }
            rows.sort((a, b) => {
              const x = a as { path: string; at: { from: number } | null };
              const y = b as { path: string; at: { from: number } | null };
              return x.path.localeCompare(y.path) || (x.at?.from ?? 0) - (y.at?.from ?? 0);
            });
            return { body: rows };
          },
        },
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
                if (kind !== 'comment' && kind !== 'reply') continue;
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
