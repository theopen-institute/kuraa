// Counting words (0094), the same everywhere: in the open document as it is
// typed, in a file on the host, in a folder's book. A word is a run of letters
// or digits (with the apostrophes and hyphens inside it); in scripts written
// without spaces (Chinese, Japanese), each character is one, as word
// processors count them.

/** Letters or digits, with apostrophes and hyphens inside; or one character of a script written without spaces. */
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+(?:['’‐-][\p{L}\p{N}\p{M}]+)*/gu;

/** The words in plain text. */
export function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD)) n++;
  return n;
}

const HEADER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * The words in a Markdown document's text, as a reader sees it: not its
 * header, code (fenced, indented by a fence's info, or inline), HTML comments
 * and tags, the addresses of links and images, footnote and citation keys, or
 * the marks Markdown is written with. A link's or an image's words count.
 */
export function markdownWords(text: string): number {
  return countWords(markdownProse(text));
}

/** A Markdown document's prose, as markdownWords counts it. */
function markdownProse(text: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.replace(HEADER, '').split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) {
      fence = fence ? null : f;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines.join('\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    // ![words](address) and [words](address): the words.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    // [^note] and [@key; @other]: keys, not words.
    .replace(/\[\^[^\]]*\]/g, ' ')
    .replace(/\[(?:[^\]]*;)?\s*-?@[^\]]*\]/g, ' ')
    .replace(/(^|\s)-?@[\p{L}\p{N}_:.#$%&+?<>~/-]+/gu, '$1 ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/\{[^}\n]*\}/g, ' ');
}

/**
 * How a Markdown document's words changed from one text to another (0094):
 * `net`, how many more there are (fewer, below nought); `added`, the words
 * written, each word counted as many more times as it appears now than before
 * (in any case), so a sentence rewritten counts though the length stays,
 * and a paragraph moved counts nothing. A document that is new (before: null)
 * or gone (after: null) is counted from or to nothing.
 */
export function wordChange(before: string | null, after: string | null): { net: number; added: number } {
  const bag = (text: string | null) => {
    const m = new Map<string, number>();
    if (text) for (const [w] of markdownProse(text).matchAll(WORD)) m.set(w.toLowerCase(), (m.get(w.toLowerCase()) ?? 0) + 1);
    return m;
  };
  const was = bag(before);
  const now = bag(after);
  let net = 0;
  let added = 0;
  for (const [w, n] of now) {
    const old = was.get(w) ?? 0;
    if (n > old) added += n - old;
    net += n;
  }
  for (const n of was.values()) net -= n;
  return { net, added };
}
