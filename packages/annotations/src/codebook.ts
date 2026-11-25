// The codebook (docs/decisions/0082-annotations.md): one per workspace, a SKOS
// concept scheme, everyone's, changed by whoever may change its file (a plain
// workspace file, not anyone's own). Codings name codes by id, so a code
// renamed changes one line. A code merged into another is not taken away: it
// says what replaces it (`isReplacedBy`), and codings of it count as the other's;
// a code deleted while codings name it is kept, marked deleted. Nobody's codings
// are rewritten: they are their makers' own (Who owns an annotation).
//
//   {
//     "@context": { …SKOS, Dublin Core, schema.org's colour, OWL's deprecated… },
//     "@graph": [
//       {"id": "urn:uuid:…", "type": "ConceptScheme", "prefLabel": "Codebook"},
//       {"id": "urn:uuid:…", "type": "Concept", "inScheme": "urn:uuid:…", "prefLabel": "Distrust", "definition": "…", "broader": "urn:uuid:…", "color": "#c2410c", "modified": "…"}
//     ]
//   }
import type { Json } from '@kuraa/feature-kit';

export const CODEBOOK = 'codebook.jsonld';

const CONTEXT = {
  skos: 'http://www.w3.org/2004/02/skos/core#',
  id: '@id',
  type: '@type',
  Concept: 'skos:Concept',
  ConceptScheme: 'skos:ConceptScheme',
  prefLabel: 'skos:prefLabel',
  definition: 'skos:definition',
  scopeNote: 'skos:scopeNote',
  broader: { '@id': 'skos:broader', '@type': '@id' },
  inScheme: { '@id': 'skos:inScheme', '@type': '@id' },
  color: 'https://schema.org/color',
  modified: 'http://purl.org/dc/terms/modified',
  isReplacedBy: { '@id': 'http://purl.org/dc/terms/isReplacedBy', '@type': '@id' },
  deprecated: 'http://www.w3.org/2002/07/owl#deprecated',
};

export interface Code {
  id: string;
  label: string;
  definition?: string;
  /** Its parent, if it is under another. */
  broader?: string;
  color?: string;
  modified?: string;
  /** Merged into another: codings of it count as that one's. */
  replacedBy?: string;
  /** Deleted while codings named it: kept, so they still say what they were. */
  deleted?: boolean;
}

export interface Codebook {
  scheme: string;
  label: string;
  codes: Code[];
}

const isObject = (v: unknown): v is { [key: string]: unknown } => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** A codebook from its file's text; an empty one (with no scheme yet) if there is none or it is not one. */
export function readCodebook(text: string | null): Codebook {
  const empty: Codebook = { scheme: '', label: 'Codebook', codes: [] };
  if (!text) return empty;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return empty;
  }
  const graph = isObject(v) && Array.isArray(v['@graph']) ? v['@graph'] : [];
  const out: Codebook = { ...empty };
  for (const n of graph) {
    if (!isObject(n) || typeof n.id !== 'string') continue;
    if (n.type === 'ConceptScheme') {
      out.scheme = n.id;
      out.label = str(n.prefLabel) ?? 'Codebook';
    } else if (n.type === 'Concept' && typeof n.prefLabel === 'string') {
      out.codes.push({
        id: n.id, label: n.prefLabel,
        ...(str(n.definition) ? { definition: str(n.definition) } : {}),
        ...(str(n.broader) ? { broader: str(n.broader) } : {}),
        ...(str(n.color) ? { color: str(n.color) } : {}),
        ...(str(n.modified) ? { modified: str(n.modified) } : {}),
        ...(str(n.isReplacedBy) ? { replacedBy: str(n.isReplacedBy) } : {}),
        ...(n.deprecated === true ? { deleted: true } : {}),
      });
    }
  }
  return out;
}

/** A code as the file writes it: its keys in one order. */
function node(c: Code, scheme: string): Json {
  return {
    id: c.id, type: 'Concept', inScheme: scheme, prefLabel: c.label,
    ...(c.definition ? { definition: c.definition } : {}),
    ...(c.broader ? { broader: c.broader } : {}),
    ...(c.color ? { color: c.color } : {}),
    ...(c.modified ? { modified: c.modified } : {}),
    ...(c.replacedBy ? { isReplacedBy: c.replacedBy } : {}),
    ...(c.deleted ? { deprecated: true } : {}),
  };
}

/** A codebook's file: the scheme, then its codes one to a line, sorted by id. */
export function writeCodebook(book: Codebook): string {
  const scheme = book.scheme || `urn:uuid:${randomId()}`;
  const lines = [
    JSON.stringify({ id: scheme, type: 'ConceptScheme', prefLabel: book.label || 'Codebook' }),
    ...[...book.codes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => JSON.stringify(node(c, scheme))),
  ];
  return `{\n  "@context": ${JSON.stringify(CONTEXT)},\n  "@graph": [\n${lines.map((l) => `    ${l}`).join(',\n')}\n  ]\n}\n`;
}

/**
 * Merge two versions of the codebook made from the same base, by code: added on
 * either side, kept; removed on one and unchanged on the other, removed; changed
 * on both, the later `modified` (equal: the one whose line sorts later); changed
 * on one and removed on the other, kept as changed. The scheme: the base's, else
 * the lower id. Never conflicts, and depends only on its arguments.
 */
export function mergeCodebooks(base: string, a: string, b: string): string {
  const o = readCodebook(base);
  const x = readCodebook(a);
  const y = readCodebook(b);
  const key = (c: Code) => JSON.stringify(node(c, ''));
  const byId = (book: Codebook) => new Map(book.codes.map((c) => [c.id, c]));
  const [mo, mx, my] = [byId(o), byId(x), byId(y)];
  const codes: Code[] = [];
  for (const id of new Set([...mx.keys(), ...my.keys(), ...mo.keys()])) {
    const was = mo.get(id);
    const cx = mx.get(id);
    const cy = my.get(id);
    if (!cx && !cy) continue;
    if (!cx || !cy) {
      const kept = (cx ?? cy)!;
      if (was && key(was) === key(kept)) continue;
      codes.push(kept);
      continue;
    }
    if (key(cx) === key(cy)) codes.push(cx);
    else if (was && key(was) === key(cx)) codes.push(cy);
    else if (was && key(was) === key(cy)) codes.push(cx);
    else {
      const tx = cx.modified ?? '';
      const ty = cy.modified ?? '';
      codes.push(tx !== ty ? (tx > ty ? cx : cy) : key(cx) > key(cy) ? cx : cy);
    }
  }
  const scheme = o.scheme || [x.scheme, y.scheme].filter(Boolean).sort()[0] || '';
  const label = o.label !== x.label ? x.label : y.label;
  return writeCodebook({ scheme, label, codes });
}

/** The code a code id stands for now: itself, or (merged) what replaces it, followed to the end. */
export function resolveCode(book: Codebook, id: string): Code | null {
  const byId = new Map(book.codes.map((c) => [c.id, c]));
  let c = byId.get(id) ?? null;
  const seen = new Set<string>();
  while (c?.replacedBy && !seen.has(c.id)) {
    seen.add(c.id);
    c = byId.get(c.replacedBy) ?? c;
    if (seen.has(c.id)) break;
  }
  return c;
}

/** A code and every code under it (its children, theirs…), and those merged into any of them. */
export function codeAndBelow(book: Codebook, id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of book.codes) {
      if (out.has(c.id)) continue;
      if ((c.broader && out.has(c.broader)) || (c.replacedBy && out.has(c.replacedBy))) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** The codes shown: neither merged away nor deleted, as a tree in order of their labels. */
export function codeTree(book: Codebook): { code: Code; depth: number }[] {
  const shown = book.codes.filter((c) => !c.replacedBy && !c.deleted);
  const ids = new Set(shown.map((c) => c.id));
  const children = new Map<string, Code[]>();
  for (const c of shown) {
    const parent = c.broader && ids.has(c.broader) ? c.broader : '';
    children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const out: { code: Code; depth: number }[] = [];
  const walk = (parent: string, depth: number, seen: Set<string>) => {
    for (const c of (children.get(parent) ?? []).sort((a, b) => a.label.localeCompare(b.label))) {
      if (seen.has(c.id)) continue;
      out.push({ code: c, depth });
      walk(c.id, depth + 1, new Set([...seen, c.id]));
    }
  };
  walk('', 0, new Set());
  return out;
}

/** A new code's or scheme's id. */
export function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/** Colours for codes, in turn, readable on light and dark. */
export const COLOURS = ['#c2410c', '#0f766e', '#7c3aed', '#b45309', '#be185d', '#1d4ed8', '#4d7c0f', '#9f1239'];
