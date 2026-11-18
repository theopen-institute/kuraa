// Filenames made from titles. A document is known by its title; its filename
// is made from it once, to be safe everywhere the file goes: every common file
// system (case-insensitive macOS and Windows, case-sensitive Linux and git),
// URLs, shells, LaTeX and R, and git history.
//
// - Lowercase, so two names never differ only in case (which case-insensitive
//   file systems cannot hold, and git then sees as two files).
// - ASCII letters and digits, words joined by hyphens: accents are dropped
//   (é → e, ß → ss), since macOS and Linux store accented names differently
//   (NFD and NFC) and git treats the two as different files; spaces and
//   punctuation would need quoting in shells and URLs; underscores are special
//   in LaTeX.
// - At most 60 characters, cut at a word, well inside every system's limits
//   (eCryptfs' 143 bytes; Windows' 260-character paths).
// - Never a name Windows reserves (con, nul, com1, …), never starting with a
//   dot (hidden) or a hyphen (read as an option).
// - Unique in its folder whatever the extension (notes.md and notes.Rmd would
//   both render to notes.html): a number is added, notes-2.
// - A title with no Latin letters or digits at all gets "untitled".
const MAX = 60;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const SPECIAL: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i', ŋ: 'n', '&': ' and ' };

/** The filename stem for a title: 'Tidal energy: a study' → 'tidal-energy-a-study'. */
export function slugify(title: string): string {
  let s = title.toLowerCase().replace(/[ßæœøđðþłıŋ&]/g, (c) => SPECIAL[c] ?? c);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Apostrophes join a word (don't → dont); anything else that is not a letter or digit separates.
  s = s.replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > MAX) {
    const cut = s.slice(0, MAX + 1);
    s = cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : s.slice(0, MAX);
  }
  if (!s) s = 'untitled';
  if (RESERVED.test(s)) s += '-doc';
  return s;
}

const stemOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
};
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/**
 * A path for a document with this title, in `folder` ('' or 'notes/'): its
 * slug and extension, with a number added if the folder has one by that name
 * (`except`: the document's own path, when renaming it).
 */
export function pathForTitle(title: string, extension: string, folder: string, taken: string[], except?: string): string {
  const used = new Set(taken.filter((p) => p !== except && folderOf(p).toLowerCase() === folder.toLowerCase()).map(stemOf));
  const base = slugify(title);
  let stem = base;
  for (let n = 2; used.has(stem); n++) stem = `${base}-${n}`;
  return `${folder}${stem}${extension}`;
}
