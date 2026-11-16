// Usage: tsx scripts/fuzz-debug.ts [pandoc|rmarkdown] — replays the fuzz test and shows the first divergence per file.
import { pandocMarkdown } from '../packages/format-pandoc/src/index.js';
import { rmarkdown } from '../packages/format-rmarkdown/src/index.js';
import { corpusFiles, normalise, randomEdit, rng } from '../tests/format-helpers.js';

const which = process.argv[2] ?? 'pandoc';
const type = which === 'rmarkdown' ? rmarkdown : pandocMarkdown;
const files = corpusFiles(which === 'rmarkdown' ? /\.rmd$/i : /\.md$/i);

function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}\n  reparsed: ${JSON.stringify(a)?.slice(0, 400)}\n  edited:   ${JSON.stringify(b)?.slice(0, 400)}`;
}

for (const f of files) {
  const r = rng(f.name.length * 7919 + f.text.length);
  let parsed = type.parse(f.text);
  for (let round = 0; round < 40; round++) {
    const edited = randomEdit(parsed.doc, r);
    if (!edited) continue;
    const text = type.serialize(edited, parsed);
    const reparsed = type.parse(text);
    const d = firstDiff(normalise(reparsed.doc), normalise(edited));
    if (d) {
      console.log(`== ${f.name} round ${round}: ${d}`);
      const words = (JSON.stringify(normalise(edited)).match(/"text":"([^"]{12})/g) ?? []);
      void words;
      if (process.argv[3]) { const i = text.indexOf(process.argv[3]); console.log(JSON.stringify(text.slice(Math.max(0, i - 300), i + 200))); }
      break;
    }
    parsed = reparsed;
  }
}
