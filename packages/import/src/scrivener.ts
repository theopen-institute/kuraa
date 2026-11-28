// A Scrivener project (2 or 3) made into a folder (0114). Its binder is its
// structure: folders and documents in the binder's order; a document with
// documents under it a folder, its own text first, untitled (the folder's name
// is its heading in a book). Each document's synopsis, label, status and
// keywords go in its header (0094); whether it is in the Draft's compile, in
// Compile's settings, as do the project's title, author and word target
// (0093, 0106). Research's PDFs and images come as files; notes, into a Notes
// folder. The Trash, snapshots and comments are left (the words a comment was
// on are kept), and said so.
//
//   Scrivener 3: <Project>.scrivx, Files/Data/<UUID>/content.rtf, synopsis.txt, notes.rtf, content.<ext>
//   Scrivener 2: <Project>.scrivx, Files/Docs/<ID>.rtf, <ID>_synopsis.txt, <ID>_notes.rtf, <ID>.<ext>
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { ConvertedFile } from '@kuraa/feature-kit/host';
import { splitHeader } from './word.js';
import type { Planned, PlannedDocument, PlannedFolder } from './plan.js';

export interface ScrivenerItem {
  id: string;
  type: string;
  title: string;
  label: string | null;
  status: string | null;
  keywords: string[];
  include: boolean;
  children: ScrivenerItem[];
}

export interface ScrivenerProject {
  title: string | null;
  author: string | null;
  /** The Draft's target in words. */
  target: number | null;
  items: ScrivenerItem[];
}

/** The project's file among a project's files (paths relative to it): the one named as the project, else one that is no conflicted copy. */
export function projectFile(paths: string[], name: string): string | null {
  const top = paths.filter((p) => !p.includes('/') && p.toLowerCase().endsWith('.scrivx'));
  return top.find((p) => p.slice(0, -'.scrivx'.length) === name) ?? top.find((p) => !/conflict/i.test(p)) ?? top[0] ?? null;
}

const kids = (e: Element, tag: string): Element[] => {
  const out: Element[] = [];
  for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).tagName === tag) out.push(n as Element);
  return out;
};
const kid = (e: Element | null | undefined, tag: string): Element | null => (e ? kids(e, tag)[0] ?? null : null);
const text = (e: Element | null | undefined): string => (e?.textContent ?? '').trim();
const path = (e: Element | null, ...tags: string[]): Element | null => tags.reduce<Element | null>((at, t) => kid(at, t), e);

/** What a project's file says: its binder, and the names of its labels, statuses and keywords. */
export function readProject(xml: string): ScrivenerProject {
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'ScrivenerProject') throw new Error('This is not a Scrivener project’s file.');
  const named = (list: Element | null, tag: string) => {
    const m = new Map<string, string>();
    for (const e of list ? kids(list, tag) : []) {
      const id = e.getAttribute('ID') ?? '';
      const name = text(kid(e, 'Title')) || text(e);
      if (id && id !== '-1' && name) m.set(id, name);
    }
    return m;
  };
  const labels = named(path(root, 'LabelSettings', 'Labels'), 'Label');
  const statuses = named(path(root, 'StatusSettings', 'StatusItems'), 'Status');
  const keywords = named(kid(root, 'Keywords'), 'Keyword');
  const item = (e: Element): ScrivenerItem => {
    const meta = kid(e, 'MetaData');
    const ids = [...(kid(e, 'Keywords') ? kids(kid(e, 'Keywords')!, 'KeywordID') : []), ...(kid(meta, 'Keywords') ? kids(kid(meta, 'Keywords')!, 'KeywordID') : [])].map((k) => text(k));
    const refs = meta ? [...meta.getElementsByTagName('KeywordRef')].map((k) => k.getAttribute('ID') ?? '') : [];
    return {
      id: e.getAttribute('UUID') ?? e.getAttribute('ID') ?? '',
      type: e.getAttribute('Type') ?? 'Text',
      title: text(kid(e, 'Title')),
      label: labels.get(text(kid(meta, 'LabelID'))) ?? null,
      status: statuses.get(text(kid(meta, 'StatusID'))) ?? null,
      keywords: [...new Set([...ids, ...refs].map((id) => keywords.get(id)).filter((k): k is string => !!k))],
      include: text(kid(meta, 'IncludeInCompile')).toLowerCase() !== 'no',
      children: kid(e, 'Children') ? kids(kid(e, 'Children')!, 'BinderItem').map(item) : [],
    };
  };
  const props = kid(root, 'ProjectProperties');
  const full = text(kid(props, 'FullName')) || [text(kid(props, 'FirstName')), text(kid(props, 'LastName'))].filter(Boolean).join(' ');
  const target = kid(kid(root, 'ProjectTargets'), 'DraftTarget');
  const words = Number(text(target));
  return {
    title: text(kid(props, 'ProjectTitle')) || null,
    author: full || null,
    target: target && (target.getAttribute('Type') ?? 'Words') === 'Words' && Number.isFinite(words) && words > 0 ? Math.round(words) : null,
    items: kid(root, 'Binder') ? kids(kid(root, 'Binder')!, 'BinderItem').map(item) : [],
  };
}

/** Where an item's text, synopsis, notes and media are among the project's files, Scrivener 3's way or 2's. */
export function itemFiles(id: string, has: (path: string) => boolean, all: string[]): { text: string | null; synopsis: string | null; notes: string | null; media: string | null } {
  const first = (...paths: string[]) => paths.find(has) ?? null;
  const v3 = `Files/Data/${id}/`;
  const v2 = `Files/Docs/${id}`;
  const media = all.find((p) => p.startsWith(`${v3}content.`) && !/\.(rtf|styles|comments|txt)$/i.test(p))
    ?? all.find((p) => p.startsWith(`${v2}.`) && !/\.(rtf|links|txt|checksum)$/i.test(p) && p.slice(v2.length + 1).indexOf('/') < 0)
    ?? null;
  return {
    text: first(`${v3}content.rtf`, `${v2}.rtf`),
    synopsis: first(`${v3}synopsis.txt`, `${v2}_synopsis.txt`),
    notes: first(`${v3}notes.rtf`, `${v2}_notes.rtf`),
    media,
  };
}

/** Scrivener's comments in the text (links to scrivcmt://), their words kept: the text, and how many there were. */
export function withoutComments(markdown: string): { text: string; comments: number } {
  let comments = 0;
  const text = markdown.replace(/\[((?:[^\]\\]|\\.)*)\]\(scrivcmt:\/\/[^)]*\)(\{[^}]*\})?/g, (_m, words: string) => {
    comments++;
    return words;
  });
  return { text, comments };
}

const FOLDERS = new Set(['DraftFolder', 'ResearchFolder', 'Folder', 'Root']);

export interface ScrivenerPlan {
  folder: PlannedFolder;
  /** What was not brought, in words. */
  left: string[];
}

/**
 * The folder a project makes, its documents' texts converted by `convert`
 * (pandoc, a few at a time). `files`: the project's files by their paths in it.
 */
export async function planScrivener(project: ScrivenerProject, name: string, files: Map<string, Uint8Array>, convert: (name: string, bytes: Uint8Array) => Promise<ConvertedFile>, o: { snapshots?: boolean; progress?: (done: number, total: number) => void } = {}): Promise<ScrivenerPlan> {
  const all = [...files.keys()];
  const has = (p: string) => files.has(p);
  const left: string[] = [];
  let comments = 0;
  let trashed = 0;
  let failed = 0;
  const skippedKinds = new Map<string, number>();

  // Every text to convert, a few at a time.
  const wanted: { item: ScrivenerItem; what: 'text' | 'notes'; file: string }[] = [];
  const walk = (items: ScrivenerItem[], inTrash: boolean) => {
    for (const it of items) {
      if (it.type === 'TrashFolder') {
        const count = (xs: ScrivenerItem[]): number => xs.reduce((n, x) => n + 1 + count(x.children), 0);
        trashed += count(it.children);
        continue;
      }
      if (inTrash) continue;
      const f = itemFiles(it.id, has, all);
      if (f.text) wanted.push({ item: it, what: 'text', file: f.text });
      if (f.notes) wanted.push({ item: it, what: 'notes', file: f.notes });
      walk(it.children, inTrash);
    }
  };
  walk(project.items, false);
  const converted = new Map<string, { body: string; media: { name: string; bytes: Uint8Array }[] }>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const w = wanted[next++]!;
      const r = await convert(`${w.item.id}.rtf`, files.get(w.file)!);
      if (r.ok) {
        const clean = withoutComments(splitHeader(r.markdown).body.trim());
        comments += clean.comments;
        converted.set(w.file, { body: clean.text, media: r.media });
      } else failed++;
      o.progress?.(++done, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker));

  const notes: PlannedDocument[] = [];
  const decode = (p: string | null) => (p ? new TextDecoder().decode(files.get(p)).trim() : '');
  const plan = (it: ScrivenerItem): Planned | null => {
    const f = itemFiles(it.id, has, all);
    const content = f.text ? converted.get(f.text) : undefined;
    const title = it.title || 'Untitled';
    const details = { synopsis: decode(f.synopsis), label: it.label ?? undefined, status: it.status ?? undefined, keywords: it.keywords };
    if (f.notes && converted.get(f.notes)?.body) notes.push({ kind: 'document', title, body: converted.get(f.notes)!.body, media: converted.get(f.notes)!.media });
    if (FOLDERS.has(it.type) || it.children.length) {
      const folder: PlannedFolder = { kind: 'folder', title, items: [], ...(it.include ? {} : { leftOut: true }) };
      // Its own text first, without a title of its own: the folder's name is its heading.
      if (content?.body) folder.items.push({ kind: 'document', title: null, name: title, details, body: content.body, media: content.media });
      for (const c of it.children) {
        const p = plan(c);
        if (p) folder.items.push(p);
      }
      return folder;
    }
    if (it.type === 'Text') return { kind: 'document', title, details, body: content?.body ?? '', media: content?.media ?? [], ...(it.include ? {} : { leftOut: true }) };
    // Research: a PDF, an image, a film, as it is.
    if (f.media) {
      const ext = f.media.slice(f.media.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', title, extension: ext, bytes: files.get(f.media)!, ...(it.include ? {} : { leftOut: true }) };
    }
    skippedKinds.set(it.type, (skippedKinds.get(it.type) ?? 0) + 1);
    return null;
  };

  const root: PlannedFolder = { kind: 'folder', title: project.title || name, items: [] };
  for (const it of project.items) {
    if (it.type === 'TrashFolder') continue;
    const p = plan(it);
    if (!p) continue;
    // The Draft: the book Compile makes, with the project's title, author and target.
    if (it.type === 'DraftFolder' && p.kind === 'folder') {
      p.compile = { title: project.title || name, ...(project.author ? { author: project.author } : {}), ...(project.target ? { target: project.target } : {}) };
    }
    root.items.push(p);
  }
  if (notes.length) root.items.push({ kind: 'folder', title: 'Notes', items: notes });
  if (trashed) left.push(`${trashed} ${trashed === 1 ? 'item' : 'items'} in Scrivener’s Trash`);
  if (comments) left.push(comments === 1 ? '1 comment (the words it was on are kept)' : `${comments} comments (the words they were on are kept)`);
  for (const [kind, n] of skippedKinds) left.push(`${n} ${kind === 'WebArchive' ? (n === 1 ? 'web page' : 'web pages') : `${kind} ${n === 1 ? 'item' : 'items'}`} kept in the project in a way that cannot be brought`);
  if (failed) left.push(`${failed} ${failed === 1 ? 'text' : 'texts'} that could not be read`);
  if (o.snapshots) left.push('snapshots (earlier versions Scrivener kept)');
  return { folder: root, left };
}
