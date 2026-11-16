// Usage: tsx scripts/oracle-diff.ts <file> [rmarkdown]
// Shows where Pandoc's syntax tree for the input differs from our canonical output.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pandocMarkdown } from '../packages/format-pandoc/src/index.js';
import { rmarkdown } from '../packages/format-rmarkdown/src/index.js';

const [file, which] = process.argv.slice(2);
if (!file) throw new Error('usage: oracle-diff <file>');
const type = which === 'rmarkdown' || /\.rmd$/i.test(file) ? rmarkdown : pandocMarkdown;
const text = readFileSync(file, 'utf8');
const canonical = type.serialize(type.parse(text).doc);
const ast = (t: string) => JSON.parse(execFileSync('pandoc', ['-f', 'markdown', '-t', 'json'], { input: t, maxBuffer: 1 << 26 }).toString());
const a = ast(text).blocks as unknown[];
const b = ast(canonical).blocks as unknown[];
const native = (blocks: unknown[]) =>
  execFileSync('pandoc', ['-f', 'json', '-t', 'native'], { input: JSON.stringify({ ...ast(''), blocks }) }).toString();
let shown = 0;
const n = Math.max(a.length, b.length);
for (let i = 0; i < n && shown < 5; i++) {
  if (JSON.stringify(a[i]) === JSON.stringify(b[i])) continue;
  shown++;
  const x = native(a.slice(i, i + 1)).split('\n');
  const y = native(b.slice(i, i + 1)).split('\n');
  let k = 0;
  while (k < x.length && x[k] === y[k]) k++;
  console.log(`--- block ${i} differs at line ${k}\n[input]\n${x.slice(Math.max(0, k - 3), k + 6).join('\n')}\n[canonical]\n${y.slice(Math.max(0, k - 3), k + 6).join('\n')}`);
}
if (!shown) console.log('ASTs equal');
