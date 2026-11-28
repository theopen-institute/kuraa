// A Scrivener project (2 or 3) made into a folder (0116). Its binder is its
// structure: folders and documents in the binder's order; a document with
// documents under it a folder, its own text first, untitled (the folder's name
// is its heading in a book). Each document's synopsis, label, status and
// keywords go in its header (0094); whether it is in the Draft's compile, in
// Compile's settings, as do the project's title, author and word target
// (0093, 0106). Research's PDFs and images come as files; notes, into a Notes
// folder, with the project's notes (Scrivener 2's). Its comments become Kuraa's
// comments on the words they were on (0082), its linked footnotes footnotes in
// the text. The Trash and snapshots are left, and said so.
//
//   Scrivener 3: <Project>.scrivx, Files/Data/<UUID>/content.rtf, synopsis.txt, notes.rtf, content.<ext>,
//                content.comments (comments and linked footnotes)
//   Scrivener 2: <Project>.scrivx, Files/Docs/<ID>.rtf, <ID>_synopsis.txt, <ID>_notes.rtf, <ID>.<ext>,
//                <ID>.links (comments and linked footnotes), Files/ProjectNotes/index.xml and <ID>.rtf
//
// A comment or linked footnote is anchored in the text by a link to
// scrivcmt://<its ID> on the words it is about; its own text is RTF, in the
// comments file: Scrivener 2's <Links><CommentsAndFootnotes><Comment ID
// IsFootnote><RTF>; Scrivener 3's <Comments><Comment ID Footnote Author Date>
// with the RTF as its text (read leniently: either name, either place).
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { ConvertedFile } from '@kuraa/feature-kit/host';
import { splitHeader as headerOf } from './word.js';
import type { ImportedComment, Planned, PlannedDocument, PlannedFolder } from './plan.js';

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

/** A comment or linked footnote, as its file keeps it: its text RTF. */
export interface ScrivenerNote {
  id: string;
  footnote: boolean;
  author: string | null;
  date: string | null;
  rtf: string;
}

/** A document's comments and linked footnotes (Scrivener 2's .links, 3's content.comments). */
export function readNotes(xml: string): ScrivenerNote[] {
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(xml, 'text/xml');
  const out: ScrivenerNote[] = [];
  for (const c of [...doc.getElementsByTagName('Comment')]) {
    const id = c.getAttribute('ID') ?? '';
    if (!id) continue;
    const flag = (c.getAttribute('IsFootnote') ?? c.getAttribute('Footnote') ?? '').toLowerCase();
    // Its RTF: in a child of its own (RTF, Notes, Text), or its own text (CDATA).
    const child = kid(c, 'RTF') ?? kid(c, 'Notes') ?? kid(c, 'Text');
    let rtf = child?.textContent ?? '';
    if (!child) for (let n = c.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 || n.nodeType === 4) rtf += n.nodeValue ?? '';
    out.push({ id, footnote: flag === 'yes' || flag === 'true', author: c.getAttribute('Author') || null, date: c.getAttribute('Date') || null, rtf: rtf.trim() });
  }
  return out;
}

/** Scrivener 2's project notes: their IDs and titles (Files/ProjectNotes/index.xml). */
export function readProjectNotes(xml: string): { id: string; title: string }[] {
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(xml, 'text/xml');
  return [...doc.getElementsByTagName('Note')].map((n) => ({ id: n.getAttribute('ID') ?? '', title: text(kid(n, 'Title')) })).filter((n) => n.id);
}

/** Markdown as it reads, its spacing kept: notes' marks, links' addresses, emphasis and escapes taken away. */
const asRead = (md: string) => md
  .replace(/\[\^[^\]]*\]/g, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)(\{[^}]*\})?/g, '$1')
  .replace(/(\*\*|__|\*|_|~~|`)/g, '')
  .replace(/\\(.)/g, '$1')
  .replace(/\n/g, ' ');

/** A converted note's text, for a comment (as it is) or a footnote (its paragraphs after the first indented). */
const footnoteText = (md: string) => md.split('\n').map((l, i) => (i === 0 || !l ? l : `    ${l}`)).join('\n');

/**
 * A document's text with its notes' anchors made Kuraa's: a comment's link
 * gives back its words, and the comment quotes them (with what is around
 * them); a footnote's, its words and a footnote ([^s1]) defined at the end.
 * Notes whose anchor is not in the text are comments on the whole document.
 */
export function anchorNotes(markdown: string, notes: Map<string, { footnote: boolean; body: string; author: string | null; date: string | null }>): { text: string; comments: ImportedComment[] } {
  const comments: ImportedComment[] = [];
  const footnotes: string[] = [];
  const LINK = /\[((?:[^\]\\]|\\.)*)\]\(scrivcmt:\/\/([^)\s]*)\)(\{[^}]*\})?/g;
  const idOf = (raw: string) => raw.replace(/\/+$/, '');
  // A note's anchor may come as several links, where its words change formatting: each note's last, for its footnote's place.
  const lastOf = new Map<string, number>();
  for (const m of markdown.matchAll(LINK)) lastOf.set(idOf(m[2]!), m.index!);
  /** Each comment's anchor, from its first piece to its last, in the text made. */
  const spans = new Map<string, { from: number; to: number }>();
  let out = '';
  let last = 0;
  for (const m of markdown.matchAll(LINK)) {
    out += markdown.slice(last, m.index);
    last = m.index! + m[0].length;
    const id = idOf(m[2]!);
    const note = notes.get(id);
    const from = out.length;
    out += m[1]!;
    if (!note) continue;
    if (note.footnote) {
      if (lastOf.get(id) === m.index) {
        footnotes.push(footnoteText(note.body));
        out += `[^s${footnotes.length}]`;
      }
    } else spans.set(id, { from: spans.get(id)?.from ?? from, to: out.length });
  }
  out += markdown.slice(last);
  for (const [id, n] of notes) {
    const span = spans.get(id);
    const exact = span ? asRead(out.slice(span.from, span.to)).replace(/\s+/g, ' ').trim() : '';
    if (!span || !exact) {
      // Not in the text (or on nothing): a comment on the whole document; a footnote whose anchor was not found, too.
      if (!span && n.footnote && lastOf.has(id)) continue;
      comments.push({ body: n.footnote ? `Footnote: ${n.body}` : n.body, author: n.author, date: n.date, quote: null });
      continue;
    }
    // What is around it in its paragraph, as it reads (the quote decides; this says which, where it is there twice).
    const before = out.slice(0, span.from).split(/\n\s*\n/).pop()!;
    const after = out.slice(span.to).split(/\n\s*\n/)[0]!;
    comments.push({ body: n.body, author: n.author, date: n.date, quote: { exact, prefix: asRead(before).slice(-32), suffix: asRead(after).slice(0, 32) } });
  }
  const text = footnotes.length ? `${out.replace(/\s+$/, '')}\n\n${footnotes.map((f, i) => `[^s${i + 1}]: ${f}`).join('\n\n')}` : out;
  return { text, comments };
}

/** Where an item's text, synopsis, notes, comments and media are among the project's files, Scrivener 3's way or 2's. */
export function itemFiles(id: string, has: (path: string) => boolean, all: string[]): { text: string | null; synopsis: string | null; notes: string | null; comments: string | null; media: string | null } {
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
    comments: first(`${v3}content.comments`, `${v2}.links`),
    media,
  };
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
  let trashed = 0;
  let failed = 0;
  const skippedKinds = new Map<string, number>();

  // Every text to convert, a few at a time: documents', notes', comments' and footnotes', the project's notes.
  const wanted: { key: string; name: string; bytes: Uint8Array }[] = [];
  const want = (key: string, bytes: Uint8Array | undefined) => {
    if (bytes) wanted.push({ key, name: `${key.replace(/[^A-Za-z0-9-]+/g, '-')}.rtf`, bytes });
  };
  const notesOf = new Map<string, ScrivenerNote[]>();
  const walk = (items: ScrivenerItem[], inTrash: boolean) => {
    for (const it of items) {
      if (it.type === 'TrashFolder') {
        const count = (xs: ScrivenerItem[]): number => xs.reduce((n, x) => n + 1 + count(x.children), 0);
        trashed += count(it.children);
        continue;
      }
      if (inTrash) continue;
      const f = itemFiles(it.id, has, all);
      if (f.text) want(f.text, files.get(f.text));
      if (f.notes) want(f.notes, files.get(f.notes));
      if (f.comments) {
        const list = readNotes(new TextDecoder().decode(files.get(f.comments)));
        notesOf.set(it.id, list);
        for (const n of list) if (n.rtf) want(`${f.comments}#${n.id}`, new TextEncoder().encode(n.rtf));
      }
      walk(it.children, inTrash);
    }
  };
  walk(project.items, false);
  const projectNotes = files.has('Files/ProjectNotes/index.xml') ? readProjectNotes(new TextDecoder().decode(files.get('Files/ProjectNotes/index.xml'))) : [];
  for (const p of projectNotes) want(`Files/ProjectNotes/${p.id}.rtf`, files.get(`Files/ProjectNotes/${p.id}.rtf`));
  const converted = new Map<string, { body: string; media: { name: string; bytes: Uint8Array }[] }>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const w = wanted[next++]!;
      const r = await convert(w.name, w.bytes);
      if (r.ok) converted.set(w.key, { body: headerOf(r.markdown).body.trim(), media: r.media });
      else failed++;
      o.progress?.(++done, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker));

  const notes: PlannedDocument[] = [];
  for (const p of projectNotes) {
    const c = converted.get(`Files/ProjectNotes/${p.id}.rtf`);
    if (c?.body) notes.push({ kind: 'document', title: p.title || 'Project notes', body: c.body, media: c.media });
  }
  const decode = (p: string | null) => (p ? new TextDecoder().decode(files.get(p)).trim() : '');
  /** A document's text, its comments and footnotes made Kuraa's. */
  const contentOf = (it: ScrivenerItem, f: ReturnType<typeof itemFiles>) => {
    const c = f.text ? converted.get(f.text) : undefined;
    const list = notesOf.get(it.id) ?? [];
    const byId = new Map(list.map((n) => [n.id, { footnote: n.footnote, author: n.author, date: n.date, body: converted.get(`${f.comments}#${n.id}`)?.body ?? '' }]));
    if (!c && !byId.size) return undefined;
    const anchored = anchorNotes(c?.body ?? '', byId);
    return { body: anchored.text, media: c?.media ?? [], comments: anchored.comments };
  };
  const plan = (it: ScrivenerItem): Planned | null => {
    const f = itemFiles(it.id, has, all);
    const content = contentOf(it, f);
    const title = it.title || 'Untitled';
    const details = { synopsis: decode(f.synopsis), label: it.label ?? undefined, status: it.status ?? undefined, keywords: it.keywords };
    if (f.notes && converted.get(f.notes)?.body) notes.push({ kind: 'document', title, body: converted.get(f.notes)!.body, media: converted.get(f.notes)!.media });
    if (FOLDERS.has(it.type) || it.children.length) {
      const folder: PlannedFolder = { kind: 'folder', title, items: [], ...(it.include ? {} : { leftOut: true }) };
      // Its own text first, without a title of its own: the folder's name is its heading.
      if (content?.body || content?.comments.length) folder.items.push({ kind: 'document', title: null, name: title, details, body: content.body, media: content.media, comments: content.comments });
      for (const c of it.children) {
        const p = plan(c);
        if (p) folder.items.push(p);
      }
      return folder;
    }
    if (it.type === 'Text') return { kind: 'document', title, details, body: content?.body ?? '', media: content?.media ?? [], comments: content?.comments ?? [], ...(it.include ? {} : { leftOut: true }) };
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
  for (const [kind, n] of skippedKinds) left.push(`${n} ${kind === 'WebArchive' ? (n === 1 ? 'web page' : 'web pages') : `${kind} ${n === 1 ? 'item' : 'items'}`} kept in the project in a way that cannot be brought`);
  if (failed) left.push(`${failed} ${failed === 1 ? 'text' : 'texts'} that could not be read`);
  if (o.snapshots) left.push('snapshots (earlier versions Scrivener kept)');
  return { folder: root, left };
}
