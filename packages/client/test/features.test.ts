import { describe, expect, it } from 'vitest';
import { defineClientFeature, type FeatureStatus } from '@kuraa/feature-kit/client';
import { activeFeatures, FeatureContexts, FeatureMessages, marginLayout, servicesFor, type FeatureApp } from '../src/features.js';
import type { CoreHost } from '@kuraa/feature-kit/client';

const status = (id: string, on: boolean): FeatureStatus => ({ id, label: id, description: '', on, host: true, workspace: on, settings: {}, mayChange: true, companions: [], me: null });
const app = { api: () => { throw new Error('no host'); }, person: () => ({ name: 'Ada', email: '', color: '#000' }), notify: () => undefined, ui: {} as FeatureApp['ui'], openPanel: () => undefined, openFile: () => undefined, openMatch: () => undefined, host: {} as FeatureApp['host'], explain: () => ({ text: '', details: null }), keyLabel: (k: string) => k, moveFile: async () => undefined, marksChanged: () => undefined, changed: () => undefined, typeOf: () => undefined } as FeatureApp;

describe('features in the client', () => {
  it('are used where the host has them on, the workspace too, and the person has not hidden them', () => {
    const a = defineClientFeature({ id: 'a' });
    const b = defineClientFeature({ id: 'b' });
    const old = { ...defineClientFeature({ id: 'c' }), apiVersion: 0 };
    const all = [status('a', true), status('b', true), status('c', true), status('d', true), status('e', false)];
    const list = activeFeatures({ a, b, c: old }, all, ['b'], new FeatureContexts(app, new FeatureMessages(), () => all));
    expect(list.map((f) => f.feature.id)).toEqual(['a']);
    // What they are told of how they stand is as it is now.
    let now = [status('a', true)];
    const [f] = activeFeatures({ a }, now, [], new FeatureContexts(app, new FeatureMessages(), () => now));
    now = [{ ...status('a', true), settings: { label: 'x' } }];
    expect(f!.ctx.status().settings).toEqual({ label: 'x' });
    expect(f!.status.settings).toEqual({ label: 'x' });
  });

  it('keep one context each while how they stand changes (0091)', () => {
    const a = defineClientFeature({ id: 'a' });
    let now = [status('a', true)];
    const contexts = new FeatureContexts(app, new FeatureMessages(), () => now);
    const [first] = activeFeatures({ a }, now, [], contexts);
    now = [{ ...status('a', true), settings: { more: true } }, status('b', true)];
    const [again] = activeFeatures({ a }, now, [], contexts);
    expect(again).toBe(first);
    expect(again!.ctx).toBe(first!.ctx);
    // Assumed (the host has not said yet): what it was assumed to be, until the host says.
    const assumed = new FeatureContexts(app, new FeatureMessages(), () => []);
    const [x] = activeFeatures({ a }, [{ ...status('a', true), label: 'assumed' }], [], assumed);
    expect(x!.status.label).toBe('assumed');
  });

  it('are given only the host services they say they use (0091)', async () => {
    const host = { search: { run: async () => ({ files: [], truncated: false }) }, renders: {}, tools: {} } as unknown as CoreHost;
    const given = servicesFor(defineClientFeature({ id: 'finder', uses: ['search'] }), host);
    expect(await given.search.run('x', false)).toEqual({ files: [], truncated: false });
    expect(() => given.renders).toThrow(/finder uses the host's renders without saying so/);
  });

  it('hear what their host halves tell them, each its own', () => {
    const bus = new FeatureMessages();
    const heard: unknown[] = [];
    const off = bus.on('a', (m, p) => heard.push([m, p]));
    bus.emit('a', { n: 1 }, 'x.md');
    bus.emit('b', { n: 2 }, null);
    off();
    bus.emit('a', { n: 3 }, null);
    expect(heard).toEqual([[{ n: 1 }, 'x.md']]);
  });

  it('keep margin marks clear of each other, in order down the page', () => {
    const laid = marginLayout([{ top: 100 }, { top: 10 }, { top: 15 }, { top: 300 }], 22);
    expect(laid.map((m) => m.at)).toEqual([10, 32, 100, 300]);
  });
});
