// What automatic commits say: which document, which parts of it, and who
// edited it: "Edit Field notes: Methods, Results (Ada, Bo)". The parts are the
// headings over the blocks that changed, so a history reads as a list of what
// was worked on rather than of saves.
import { matches, type DocumentType } from '@kuraa/kernel';

/** The trailer that marks a commit the host made on its own (not a named version). */
export const AUTOSAVE_TRAILER = 'Kuraa-Kind: autosave';

const MAX_PARTS = 3;

/** The headings over the blocks that differ between two versions, in order, each once. */
export function changedParts(type: DocumentType, before: string, after: string): string[] {
  const read = (text: string) => {
    const p = type.parse(text);
    let heading: string | null = null;
    return p.blocks.map((r, i) => {
      const node = i < p.doc.childCount ? p.doc.child(i) : null;
      if (node?.type.name === 'heading') heading = node.textContent.trim();
      const part = node?.type.name === 'front_matter' ? 'header' : heading;
      return { key: text.slice(r.from, r.to).trimEnd(), part };
    });
  };
  const old = read(before);
  const now = read(after);
  const seen = matches(old, now, (x, y) => x.key === y.key);
  const matched = new Set(seen.filter((j) => j >= 0));
  const parts: string[] = [];
  const add = (p: string | null) => {
    if (p && !parts.includes(p)) parts.push(p);
  };
  now.forEach((b, j) => {
    if (!matched.has(j)) add(b.part);
  });
  old.forEach((b, i) => {
    if (seen[i] === -1) add(b.part);
  });
  return parts;
}

/** A commit message for an edit to one file. */
export function describeEdit(type: DocumentType | undefined, path: string, before: string | null, after: string, people: string[], beside: string[] = []): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const name = type?.title?.read(after)?.trim() || file;
  const who = [...new Set(people.filter(Boolean))];
  const by = who.length ? ` (${who.join(', ')})` : '';
  // Only what features keep beside it changed (0082): what they say of it, for the document.
  if (beside.length && before === after) return `${name}: ${beside.join(', ')}${by}`;
  const verb = before === null ? 'Create' : 'Edit';
  // Parts are headings: types without them (source files) have none.
  const parts = type?.schema.nodes.heading && before !== null ? changedParts(type, before, after) : [];
  const shown = parts.length > MAX_PARTS ? `${parts.slice(0, MAX_PARTS).join(', ')} and ${parts.length - MAX_PARTS} more` : parts.join(', ');
  return `${verb} ${name}${shown ? `: ${shown}` : ''}${beside.length ? `; ${beside.join(', ')}` : ''}${by}`;
}
