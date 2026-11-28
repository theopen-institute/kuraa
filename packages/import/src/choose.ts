// What was chosen to import (0114), made into files with their places: a Word
// file, as it is; a Scrivener project (a folder, dropped or picked, or a .zip
// of one) as only what the import reads of it: its project file, its texts,
// synopses, notes and research files. Not its snapshots, search indexes,
// backups, settings or Dropbox's conflicted copies.
import { unzipSync } from 'fflate';

export interface Chosen {
  kind: 'word' | 'scrivener';
  /** The file's or project's name, without its extension. */
  name: string;
  files: { path: string; bytes: () => Promise<Uint8Array> }[];
  /** A Scrivener project with snapshots (left out, and said so). */
  snapshots: boolean;
  /** Its size, to send. */
  size: number;
}

export const WORD = /\.(docx|odt|rtf|epub|html?)$/i;

/** Whether a path within a Scrivener project is one the import reads. */
export function scrivenerWants(path: string): boolean {
  if (/conflicted copy/i.test(path)) return false;
  if (!path.includes('/')) return /\.scrivx$/i.test(path);
  if (/^Files\/Docs\/[^/]+$/.test(path)) return !/\.(links|checksum|styles)$/i.test(path);
  return /^Files\/Data\/[^/]+\/(content\.(?!styles$|comments$)[^/]+|synopsis\.txt|notes\.rtf)$/i.test(path);
}

const stem = (name: string) => name.replace(/\.[^.]*$/, '');

/** A project's files (paths from inside the .scriv folder), as Chosen. */
export function scrivenerChosen(name: string, entries: { path: string; size: number; bytes: () => Promise<Uint8Array> }[]): Chosen {
  const files = entries.filter((e) => scrivenerWants(e.path));
  return {
    kind: 'scrivener', name, files: files.map((e) => ({ path: e.path, bytes: e.bytes })),
    snapshots: entries.some((e) => e.path.startsWith('Snapshots/')),
    size: files.reduce((n, e) => n + e.size, 0),
  };
}

/** Files picked from a folder (their webkitRelativePath: Project.scriv/Files/…): a Scrivener project, or null. */
export function fromFolder(files: File[]): Chosen | null {
  const first = (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath ?? '';
  const top = first.split('/')[0] ?? '';
  const entries = files.map((f) => ({ path: ((f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name).split('/').slice(1).join('/'), size: f.size, bytes: async () => new Uint8Array(await f.arrayBuffer()) }));
  if (!entries.some((e) => !e.path.includes('/') && /\.scrivx$/i.test(e.path))) return null;
  return scrivenerChosen(stem(top), entries);
}

/** A .zip with a Scrivener project in it (its .scriv folder anywhere, or the project's files at its top), or null. */
export function fromZip(name: string, bytes: Uint8Array): Chosen | null {
  const all = unzipSync(bytes, { filter: (f) => !f.name.endsWith('/') && !f.name.startsWith('__MACOSX/') });
  const paths = Object.keys(all);
  const scrivx = paths.find((p) => /\.scrivx$/i.test(p) && !/conflicted copy/i.test(p)) ?? paths.find((p) => /\.scrivx$/i.test(p));
  if (!scrivx) return null;
  const base = scrivx.includes('/') ? scrivx.slice(0, scrivx.lastIndexOf('/') + 1) : '';
  const project = base ? stem(base.replace(/\/$/, '').split('/').pop()!) : stem(name);
  const entries = paths.filter((p) => p.startsWith(base)).map((p) => ({ path: p.slice(base.length), size: all[p]!.length, bytes: async () => all[p]! }));
  return scrivenerChosen(project, entries);
}

/** One file: a Word document (or the like), or a .zip of a Scrivener project; null if it is neither. */
export async function fromFile(file: File): Promise<Chosen | null> {
  if (/\.zip$/i.test(file.name)) return fromZip(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!WORD.test(file.name)) return null;
  return { kind: 'word', name: stem(file.name), files: [{ path: file.name, bytes: async () => new Uint8Array(await file.arrayBuffer()) }], snapshots: false, size: file.size };
}

type Entry = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void; createReader?: () => { readEntries(ok: (es: Entry[]) => void, fail: (e: unknown) => void): void } };

/** Every file under a dropped folder, with its path inside it. */
async function filesUnder(dir: Entry, prefix = ''): Promise<{ path: string; file: File }[]> {
  const reader = dir.createReader!();
  const out: { path: string; file: File }[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    for (const e of batch) {
      if (e.isDirectory) out.push(...await filesUnder(e, `${prefix}${e.name}/`));
      else if (e.isFile) out.push({ path: `${prefix}${e.name}`, file: await new Promise<File>((ok, fail) => e.file!(ok, fail)) });
    }
  }
  return out;
}

/** What was dropped: a Scrivener project's folder, or a file; null if it is neither. */
export async function fromDrop(data: DataTransfer): Promise<Chosen | null> {
  const item = [...data.items].find((i) => i.kind === 'file');
  const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null } | undefined)?.webkitGetAsEntry?.();
  if (entry?.isDirectory) {
    const files = await filesUnder(entry);
    if (!files.some((f) => !f.path.includes('/') && /\.scrivx$/i.test(f.path))) return null;
    return scrivenerChosen(stem(entry.name), files.map((f) => ({ path: f.path, size: f.file.size, bytes: async () => new Uint8Array(await f.file.arrayBuffer()) })));
  }
  const file = data.files[0];
  return file ? fromFile(file) : null;
}

/** Bytes as base64, in pieces small enough for the browser. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
