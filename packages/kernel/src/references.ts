// What a document refers to (0109): the workspace files its images, links and
// definitions name, as paths relative to the document; and those paths written
// again when files move, so a rename or move breaks no reference.
//
// A format finds its references (DocumentType.references: where each target is
// in the text); everything else here is the same for every format, and runs on
// the host (rewriting) and in the page (resolving), without a DOM or Node.

/** A reference in a document's text: where its target is written (`from`–`to`, the characters to replace), and what it says. */
export interface Reference {
  kind: 'image' | 'link' | 'definition';
  /** The target's text in the source, from its first character to after its last (angle brackets included, if written). */
  from: number;
  to: number;
  /** The target as written, without angle brackets. */
  target: string;
}

/** The folder of a document's own files (0109): `report.md` → `report.md.files`, beside it. */
export const FILES_SUFFIX = '.files';

export function filesFolderOf(doc: string): string {
  return `${doc}${FILES_SUFFIX}`;
}

/**
 * The document whose own files a path is among (`a/report.md.files/x.png` →
 * `a/report.md`), or null. Known by name alone: a folder named as a file with
 * an extension, then `.files`. The outermost such folder counts.
 */
export function documentOfFiles(path: string): string | null {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const m = /^(.+\.[A-Za-z0-9]{1,12})\.files$/.exec(parts[i]!);
    if (m) return [...parts.slice(0, i), m[1]!].join('/');
  }
  return null;
}

/**
 * A path written in the document at `docPath`, as a workspace path; null if it
 * is an address (https:, data:), absolute, only a place in the document
 * (`#intro`), or leads outside the workspace.
 */
export function workspacePath(docPath: string, written: string): string | null {
  let p = written.trim();
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('\\') || p.startsWith('~') || p.startsWith('#') || p.startsWith('?')) return null;
  try {
    p = decodeURI(p);
  } catch { /* as written */ }
  p = p.split(/[?#]/)[0]!;
  const parts = docPath.split('/').slice(0, -1);
  for (const part of p.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** How the document at `docPath` writes the workspace path `path`: relative to the document's folder, with `/`. */
export function relativeTarget(docPath: string, path: string): string {
  const from = docPath.split('/').slice(0, -1);
  const to = path.split('/');
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return [...from.slice(same).map(() => '..'), ...to.slice(same)].join('/');
}

/** A target written again for a new path: its place in the file (`#…`, `?…`) kept, spaces and the like made safe as Markdown writes them. */
function writeTarget(old: Reference, text: string, path: string): string {
  const tail = /[?#].*$/.exec(old.target)?.[0] ?? '';
  const angled = text[old.from] === '<';
  const encoded = /%[0-9A-Fa-f]{2}/.test(old.target);
  let p = path;
  if (encoded) p = encodeURI(p);
  else if (!angled && /[\s()<>]/.test(p)) return `<${p}${tail}>`;
  return angled ? `<${p}${tail}>` : `${p}${tail}`;
}

/**
 * The text of a document with its references written for files that moved:
 * the document itself (from `oldDoc` to `newDoc`: its relative references are
 * written from its new place), and any file or folder it names (`moved` gives
 * a workspace path's new path, or null if it stayed). Null if nothing changes.
 */
export function rewriteReferences(text: string, refs: Reference[], oldDoc: string, newDoc: string, moved: (path: string) => string | null): string | null {
  const edits: { from: number; to: number; text: string }[] = [];
  for (const r of refs) {
    const was = workspacePath(oldDoc, r.target);
    if (!was) continue;
    const now = moved(was) ?? was;
    // Unchanged where it still names the same file from where the document now is.
    if (workspacePath(newDoc, r.target) === now) continue;
    edits.push({ from: r.from, to: r.to, text: writeTarget(r, text, relativeTarget(newDoc, now)) });
  }
  if (!edits.length) return null;
  edits.sort((a, b) => b.from - a.from);
  let out = text;
  for (const e of edits) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

/** What moved, as a function of a workspace path: a file's new path, or a path in a moved folder at its new place; null if it stayed. */
export function movedBy(moves: readonly (readonly [from: string, to: string])[]): (path: string) => string | null {
  return (path) => {
    for (const [from, to] of moves) {
      if (path === from) return to;
      if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
    }
    return null;
  };
}
