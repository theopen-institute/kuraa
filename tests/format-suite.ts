// The six required format tests, shared by every markdown-family type.
import { describe, expect, it } from 'vitest';
import { Transform } from 'prosemirror-transform';
import type { DocumentType } from '../packages/kernel/src/index.js';
import { hasPandoc, normalise, pandocAst, randomEdit, rng, textblocks } from './format-helpers.js';

export { corpusFiles } from './format-helpers.js';

/** Indices of top-level blocks that contain an editable textblock. */
function editableTopBlocks(doc: Parameters<typeof textblocks>[0]): number[] {
  return [...new Set(textblocks(doc).map((t) => t.top))];
}

export function runFormatSuite(type: DocumentType, files: { name: string; text: string }[], opts: { oracleKnownDiffs?: Record<string, string> } = {}): void {
  describe(`${type.id}: format tests`, () => {
    it('has a corpus', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    describe('identity', () => {
      for (const f of files) {
        it(f.name, () => {
          const parsed = type.parse(f.text);
          expect(type.serialize(parsed.doc, parsed)).toBe(f.text);
        });
      }
    });

    describe('locality', () => {
      for (const f of files) {
        it(f.name, () => {
          const parsed = type.parse(f.text);
          const r = rng(f.text.length);
          const candidates = editableTopBlocks(parsed.doc);
          const picks = Array.from({ length: Math.min(8, candidates.length) }, () => r.pick(candidates));
          for (const top of new Set(picks)) {
            // Edit inside the chosen top-level block only.
            const tb = textblocks(parsed.doc).find((t) => t.top === top)!;
            const tr = new Transform(parsed.doc).insert(tb.pos + 1, parsed.doc.type.schema.text('EDITED '));
            const out = type.serialize(tr.doc, parsed);
            const range = parsed.blocks[top]!;
            expect(out.slice(0, range.from), `prefix before block ${top}`).toBe(f.text.slice(0, range.from));
            const tail = f.text.slice(range.to);
            expect(out.slice(out.length - tail.length), `suffix after block ${top}`).toBe(tail);
            expect(out).toContain('EDITED');
          }
        });
      }
    });

    describe('oracle (pandoc)', () => {
      if (!hasPandoc) {
        it.skip('pandoc is not installed: oracle tests skipped', () => {});
        console.warn(`\n⚠  ${type.id}: pandoc not found on PATH; oracle tests skipped.\n`);
        return;
      }
      for (const f of files) {
        const known = opts.oracleKnownDiffs?.[f.name];
        const test = known ? it.fails : it;
        test(known ? `${f.name} (known difference: ${known})` : f.name, () => {
          const canonical = type.serialize(type.parse(f.text).doc);
          expect(pandocAst(canonical)).toEqual(pandocAst(f.text));
        });
      }
    });

    describe('fixed point', () => {
      for (const f of files) {
        it(f.name, () => {
          const canonical = type.serialize(type.parse(f.text).doc);
          expect(type.serialize(type.parse(canonical).doc)).toBe(canonical);
        });
      }
    });

    describe('fuzz', () => {
      for (const f of files) {
        it(f.name, () => {
          const r = rng(f.name.length * 7919 + f.text.length);
          let parsed = type.parse(f.text);
          for (let round = 0; round < 40; round++) {
            const edited = randomEdit(parsed.doc, r);
            if (!edited) continue;
            const text = type.serialize(edited, parsed);
            const reparsed = type.parse(text);
            expect(normalise(reparsed.doc), `round ${round}\n${text}`).toEqual(normalise(edited));
            parsed = reparsed;
          }
        });
      }
    });

    describe('totality', () => {
      it('never throws on truncated, spliced or malformed input', () => {
        const r = rng(4242);
        const samples: string[] = ['', '\n', '```', '::: {.x}\n', '---\n', '[^', '$$', '| a |\n|-', '<div>', '\u0000�', '\\'];
        for (const f of files) {
          for (let i = 0; i < 25; i++) {
            const a = r.int(f.text.length + 1);
            samples.push(f.text.slice(0, a));
            const b = r.int(f.text.length + 1);
            samples.push(f.text.slice(Math.min(a, b), Math.max(a, b)) + f.text.slice(0, r.int(200)));
          }
        }
        for (const s of samples) {
          let parsed: ReturnType<typeof type.parse> | undefined;
          expect(() => { parsed = type.parse(s); }).not.toThrow();
          expect(type.serialize(parsed!.doc, parsed)).toBe(s);
        }
      });
    });
  });
}
