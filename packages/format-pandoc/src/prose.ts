// What a reader reads of a Markdown document (0094, 0123): the type's `prose`,
// whose words the app counts everywhere (the kernel's countWords and
// wordChange), however a document is reached (open, on the host, in a book).
import { countWords } from '@kuraa/kernel';

const HEADER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * A Markdown document's prose, as a reader sees it: not its header, code
 * (fenced, indented by a fence's info, or inline), HTML comments and tags, the
 * addresses of links and images, footnote and citation keys, or the marks
 * Markdown is written with. A link's or an image's words are kept.
 */
export function markdownProse(text: string): string {
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

/** The words in a Markdown document's text, as a reader sees it (markdownProse). */
export function markdownWords(text: string): number {
  return countWords(markdownProse(text));
}
