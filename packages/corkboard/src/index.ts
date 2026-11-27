// The corkboard and the outline (docs/decisions/0095-corkboard-and-outline.md):
// a folder's documents and folders, in the file tree's order, as index cards or
// as rows, in the main area. Its host half gives what they show of each: a
// document's synopsis, label and status (its header: Document details', 0094),
// its words and its target; a folder's documents and words, all through it.
// It tells its client halves when a document there is saved, or files move.
//
//   its routes   GET cards?folder=
import { defineFeature, type FeatureContext, type Json } from '@kuraa/feature-kit/host';
import { detailsOfText } from '@kuraa/details/details';
import { markdownWords } from '@kuraa/kernel';

const DOCUMENT = /\.(md|markdown|qmd|rmd)$/i;
const HEADER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)/;

/** A document's card: its details, words and target. */
export interface DocumentCard {
  synopsis: string | null;
  label: string | null;
  status: string | null;
  words: number;
  target: number | null;
}

/** A folder's card: its documents and their words, all through it. */
export interface FolderCard {
  documents: number;
  words: number;
}

/** A document's target, as its header says it (target-words, 0094). */
function targetOf(text: string): number | null {
  const m = /^target-words:\s*["']?([\d,_ ]+)["']?\s*$/m.exec(HEADER.exec(text)?.[1] ?? '');
  const n = m ? Number(m[1]!.replace(/[,_ ]/g, '')) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

/** What a folder's cards show ('' the top level): its documents', and its folders'. */
export async function cards(ctx: FeatureContext, folder: string): Promise<{ documents: Record<string, DocumentCard>; folders: Record<string, FolderCard> }> {
  const prefix = folder ? `${folder}/` : '';
  const documents: Record<string, DocumentCard> = {};
  const folders: Record<string, FolderCard> = {};
  for (const p of await ctx.list()) {
    if (!p.startsWith(prefix) || !DOCUMENT.test(p) || ctx.documentOf(p) !== null) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    const text = (await ctx.read(p)) ?? '';
    const words = markdownWords(text);
    if (slash < 0) {
      const d = detailsOfText(text);
      documents[p] = { synopsis: d.synopsis, label: d.label, status: d.status, words, target: targetOf(text) };
    } else {
      const sub = prefix + rest.slice(0, slash);
      const f = folders[sub] ?? { documents: 0, words: 0 };
      f.documents++;
      f.words += words;
      folders[sub] = f;
    }
  }
  return { documents, folders };
}

export const corkboardFeature = defineFeature({
  id: 'corkboard',
  label: 'Corkboard and outline',
  description: 'A folder’s documents as index cards, or as an outline, in the file tree’s order: drag to arrange them, edit their synopses and statuses in place.',
  onByDefault: true,
  open(ctx) {
    // Told again: a document saved (its synopsis, its words), files moved or brought in.
    const changed = () => ctx.tell({ changed: true });
    const stops = (['save', 'rename', 'delete', 'merge', 'commit'] as const).map((e) => ctx.on(e, changed));
    return {
      routes: [{
        method: 'GET',
        path: 'cards',
        handle: async (req) => {
          const folder = (req.query.get('folder') ?? '').replace(/^\/+|\/+$/g, '');
          if (folder.split('/').some((s) => s === '..')) return { status: 400, body: { message: 'folder: a folder of the workspace' } };
          return { body: (await cards(ctx, folder)) as unknown as Json };
        },
      }],
      close: () => stops.forEach((s) => s()),
    };
  },
});
