import { describe, expect, it } from 'vitest';
import { HookBus, TypeRegistry, hashText } from '../src/index.js';
import { pandocMarkdown } from '../../format-pandoc/src/index.js';
import { rmarkdown } from '../../format-rmarkdown/src/index.js';

describe('TypeRegistry', () => {
  it('resolves the highest-priority matching type', () => {
    const reg = new TypeRegistry();
    reg.register(pandocMarkdown);
    reg.register(rmarkdown);
    expect(reg.resolve('notes/a.md')?.id).toBe('pandoc-markdown');
    expect(reg.resolve('analysis/report.Rmd')?.id).toBe('rmarkdown');
    expect(reg.resolve('data.csv')).toBeUndefined();
    expect(() => reg.register(rmarkdown)).toThrow();
  });
});

describe('HookBus', () => {
  it('runs before-hooks in order, lets them modify or veto, then after-hooks', async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    bus.on<{ n: number }>('save', { order: 2, before: (p) => ({ n: p.n * 10 }) });
    bus.on<{ n: number }>('save', { order: 1, before: (p) => ({ n: p.n + 1 }), after: () => { seen.push('after'); } });
    expect(await bus.before('save', { n: 1 })).toEqual({ n: 20 });
    bus.on<{ n: number }>('save', { order: 3, before: () => false });
    expect(await bus.before('save', { n: 1 })).toBeNull();
    await bus.after('save', {});
    expect(seen).toEqual(['after']);
  });
});

describe('hashText', () => {
  it('is stable and length-aware', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});
