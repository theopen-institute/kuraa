// The six required format tests, shared by every markdown-family type, and the
// same through a room (as collaborators and the host see a document: Yjs).
import { describe, expect, it } from 'vitest';
import { Transform } from 'prosemirror-transform';
import type { DocumentType } from '../packages/kernel/src/index.js';
import { decodeDoc, encodeDoc, patchState } from '../packages/session/src/server.js';
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

    // A document goes through a room (Yjs, through y-prosemirror) on its way to everyone: the
    // host's copy, and each collaborator's editor. It must come out as it went in, marks on
    // images, maths, citations and the like too, or the first save rewrites what it lost.
    describe('identity through the room', () => {
      for (const f of files) {
        it(f.name, () => {
          const parsed = type.parse(f.text);
          const viaRoom = decodeDoc(encodeDoc(parsed.doc), type.schema);
          expect(viaRoom.eq(parsed.doc)).toBe(true);
          expect(type.serialize(viaRoom, parsed)).toBe(f.text);
        });
      }
    });

    describe('locality through the room', () => {
      for (const f of files) {
        it(f.name, () => {
          const parsed = type.parse(f.text);
          const state = encodeDoc(parsed.doc);
          const r = rng(f.text.length + 1);
          const candidates = editableTopBlocks(parsed.doc);
          const picks = Array.from({ length: Math.min(8, candidates.length) }, () => r.pick(candidates));
          for (const top of new Set(picks)) {
            // The edit made as an editor makes it into the room (a minimal difference), and read back.
            const tb = textblocks(parsed.doc).find((t) => t.top === top)!;
            const edited = new Transform(parsed.doc).insert(tb.pos + 1, parsed.doc.type.schema.text('EDITED ')).doc;
            const back = decodeDoc(patchState(state, edited), type.schema);
            expect(back.eq(edited), `block ${top} through the room`).toBe(true);
            const out = type.serialize(back, parsed);
            const range = parsed.blocks[top]!;
            expect(out.slice(0, range.from), `prefix before block ${top}`).toBe(f.text.slice(0, range.from));
            const tail = f.text.slice(range.to);
            expect(out.slice(out.length - tail.length), `suffix after block ${top}`).toBe(tail);
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
