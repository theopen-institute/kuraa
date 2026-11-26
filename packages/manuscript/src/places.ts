// Where a manuscript keeps its files, where the workspace has manuscripts
// manage them (0090, its setting "Manuscripts keep their files"): each chapter
// in its home folder; a part's chapters (and its file) in a folder of the
// part's name inside it; the appendices in `appendices/`. Names stay as they
// are: only folders follow the manuscript, so reordering moves nothing.
import { isBookDocument, type Manuscript } from './book.js';

/** A part's or a title's folder name: lower-case letters, digits and dashes. */
export function slugOf(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'part';
}

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The folder a part's chapters go in: its title's, or its file's name. */
const partFolder = (part: string) => slugOf(isBookDocument(part) ? nameOf(part).replace(/\.[^.]+$/, '') : part);

/**
 * The moves that put a manuscript's files where it keeps them, as [from, to]:
 * only those not there already. Its home is its own, else its project's folder.
 */
export function movesFor(m: Pick<Manuscript, 'folder' | 'chapters' | 'appendices'> & { home: string | null }): [string, string][] {
  const home = m.home ?? m.folder;
  const out: [string, string][] = [];
  const put = (path: string, folder: string) => {
    const to = `${folder}${nameOf(path)}`;
    if (to !== path) out.push([path, to]);
  };
  for (const e of m.chapters) {
    if ('chapter' in e) put(e.chapter, home);
    else {
      const folder = `${home}${partFolder(e.part)}/`;
      if (isBookDocument(e.part)) put(e.part, folder);
      for (const c of e.chapters) put(c, folder);
    }
  }
  for (const a of m.appendices) put(a, `${home}appendices/`);
  // Two going to the same place: the first goes, the other stays where it is.
  const seen = new Set<string>();
  return out.filter(([, to]) => !seen.has(to) && !!seen.add(to));
}
