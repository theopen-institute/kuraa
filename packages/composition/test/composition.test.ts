// Composition mode (0120): its settings, kept in this browser; the block being
// written marked (the rest fade); the count at the page's foot.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { currentBlock } from '../src/plugins.js';
import { S } from '../src/strings.js';

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} } });
const doc = schema.node('doc', null, ['One.', 'Two.', 'Three.'].map((t) => schema.node('paragraph', null, [schema.text(t)])));

describe('composition mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('marks only the block the cursor is in', () => {
    // In "Two." (the second paragraph starts at 6).
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 8) });
    const found = currentBlock(state).find();
    expect(found).toHaveLength(1);
    expect([found[0]!.from, found[0]!.to]).toEqual([6, 12]);
  });

  it('keeps each person’s settings in this browser, the defaults where there is nowhere to keep them', async () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
    const { prefs, setPref, onPrefs } = await import('../src/prefs.js');
    expect(prefs()).toEqual({ typewriter: true, count: true, fade: false });
    const told: boolean[] = [];
    const stop = onPrefs((p) => told.push(p.fade));
    setPref('fade', true);
    stop();
    expect(told).toEqual([true]);
    expect(JSON.parse(kept.get('kuraa.composition')!)).toEqual({ typewriter: true, count: true, fade: true });
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('private'); }, setItem: () => { throw new Error('private'); } });
    const again = await import('../src/prefs.js');
    expect(again.prefs()).toEqual({ typewriter: true, count: true, fade: false });
    again.setPref('typewriter', false);
    expect(again.prefs().typewriter).toBe(false);
  });

  it('says the words, and of a target how far', () => {
    expect(S.count(1, null)).toBe('1 word');
    expect(S.count(2406, 3000)).toBe('2,406 of 3,000 words · 80%');
    expect(S.count(5000, 1000)).toBe('5,000 of 1,000 words · 500%');
  });
});
