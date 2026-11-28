// What an import makes, before anything is written (0114): folders in order,
// documents (a title, their details, their text, the images they show) and
// other files (a research PDF). Then the new files that make it: each folder's
// documents named from their titles as the app names them, their images in
// their own files folder (0109), each folder's order (.kuraa-order) and, where
// it says something, what Compile keeps for it (.kuraa-compile.yml: 0093, 0106).
import { stringify } from 'yaml';
import { filesFolderOf, folderName, pathForTitle, slugify } from '@kuraa/kernel';
import { emptyCompile, writeCompile, type FolderCompile } from '@kuraa/compile';
import type { NewFile } from '@kuraa/feature-kit/host';

/** A document's details (0094), as its header keeps them. */
export interface Details {
  synopsis?: string;
  label?: string;
  status?: string;
  keywords?: string[];
}

export interface PlannedDocument {
  kind: 'document';
  /** Its title, in its header and the tree; null: none (its folder's heading is its heading in a book), named by `name`. */
  title: string | null;
  /** What its file is named from where it has no title. */
  name?: string;
  details?: Details;
  /** Its text (pandoc's Markdown), naming its images by the names in `media`. */
  body: string;
  media: { name: string; bytes: Uint8Array }[];
  /** Left out of Compile. */
  leftOut?: boolean;
}

export interface PlannedFile {
  kind: 'file';
  title: string;
  /** With its dot: '.pdf'. */
  extension: string;
  bytes: Uint8Array;
  leftOut?: boolean;
}

export interface PlannedFolder {
  kind: 'folder';
  title: string;
  items: Planned[];
  /** What Compile keeps for it (its title, author, target, numbering…), besides what is left out. */
  compile?: Partial<FolderCompile>;
  leftOut?: boolean;
}

export type Planned = PlannedDocument | PlannedFile | PlannedFolder;

/** A document's file: its header (title and details) and its text. */
export function documentText(title: string | null, details: Details | undefined, body: string): string {
  const header: Record<string, unknown> = {};
  if (title) header.title = title;
  if (details?.synopsis?.trim()) header.synopsis = details.synopsis.trim();
  if (details?.label?.trim()) header.label = details.label.trim();
  if (details?.status?.trim()) header.status = details.status.trim();
  if (details?.keywords?.length) header.keywords = details.keywords;
  const text = body.replace(/^\s+|\s+$/g, '');
  const head = Object.keys(header).length ? `---\n${stringify(header, { lineWidth: 0 })}---\n\n` : '';
  return `${head}${text}${text ? '\n' : ''}`;
}

const extOf = (name: string) => {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
};
const stemOf = (name: string) => {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

/** What a plan writes, and how much of each kind. */
export interface Written {
  files: NewFile[];
  /** The folder the import made (its path). */
  root: string;
  /** The first document, to open. */
  first: string | null;
  documents: number;
  folders: number;
  images: number;
  others: number;
}

/**
 * The new files that make a planned folder, put in `into` ('' the top): the
 * folder named from its title (made unique among `taken`, the names already in
 * `into`), and everything in it.
 */
export function writePlan(root: PlannedFolder, into: string, taken: string[]): Written {
  const out: Written = { files: [], root: '', first: null, documents: 0, folders: 0, images: 0, others: 0 };
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const folder = (f: PlannedFolder, parent: string, names: string[]): string => {
    const path = join(parent, folderName(f.title, names));
    out.folders++;
    const here: string[] = [];
    const paths: string[] = [];
    const leftOut: string[] = [];
    for (const item of f.items) {
      let name: string;
      if (item.kind === 'folder') {
        name = folder(item, path, here).slice(path.length + 1);
      } else if (item.kind === 'document') {
        const file = pathForTitle(item.title ?? item.name ?? 'Untitled', '.md', `${path}/`, paths);
        name = file.slice(path.length + 1);
        // Its images in its own files folder, named as they were (made unique), its text naming them there.
        let body = item.body;
        const used = new Set<string>();
        for (const m of item.media) {
          if (!body.includes(m.name)) continue;
          const ext = extOf(m.name);
          let stem = slugify(stemOf(m.name));
          for (let n = 2; used.has(`${stem}${ext}`); n++) stem = `${slugify(stemOf(m.name))}-${n}`;
          used.add(`${stem}${ext}`);
          const at = `${filesFolderOf(file)}/${stem}${ext}`;
          out.files.push({ path: at, bytes: m.bytes });
          out.images++;
          body = body.split(m.name).join(`${filesFolderOf(name)}/${stem}${ext}`);
        }
        out.files.push({ path: file, text: documentText(item.title, item.details, body) });
        out.documents++;
        out.first ??= file;
      } else {
        const file = pathForTitle(item.title, item.extension, `${path}/`, paths);
        name = file.slice(path.length + 1);
        out.files.push({ path: file, bytes: item.bytes });
        out.others++;
      }
      here.push(name);
      paths.push(join(path, name));
      if (item.leftOut) leftOut.push(name);
    }
    // Its order: as it was.
    if (here.length) out.files.push({ path: `${path}/.kuraa-order`, text: `# The order of this folder in Kuraa: one file or folder name per line; others follow, by name.\n${here.map((n) => `${n}\n`).join('')}` });
    const compile = writeCompile({ ...emptyCompile(path), ...f.compile, folder: path, exclude: leftOut });
    if (compile) out.files.push({ path: `${path}/.kuraa-compile.yml`, text: compile });
    // A folder with nothing in it still is one (git keeps no empty folder).
    if (!f.items.length) out.files.push({ path: `${path}/.gitkeep`, text: '' });
    return path;
  };
  out.root = folder(root, into, taken);
  return out;
}
