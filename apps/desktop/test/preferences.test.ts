import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, preferencesFrom } from '../src/preferences.js';

describe('preferences', () => {
  it('fill in what an older file lacks with the defaults', () => {
    expect(preferencesFrom({ syncDevices: true, runCode: false, rImages: ['a'], workspaces: '/w' })).toEqual({
      ...DEFAULT_PREFERENCES, syncDevices: true, runCode: false, rImages: ['a'], workspaces: '/w',
    });
    expect(preferencesFrom(null)).toEqual(DEFAULT_PREFERENCES);
    // Installs stay allowed unless turned off, as before there was a preference for them.
    expect(DEFAULT_PREFERENCES.allowInstalls).toBe(true);
  });

  it('keep what the window sets', () => {
    const p = preferencesFrom({
      ...DEFAULT_PREFERENCES,
      memory: '6g', cpus: '1.5', disk: '500m', allowWrite: true, allowNetwork: true, allowInstalls: false,
      podman: '/opt/podman/bin/podman', dataDir: '/data', environment: 'podman',
      formats: ['pandoc-markdown', 'text'], bootstrap: ['node.example.org:49737', 'node.example.org:49737'],
      saveSeconds: '0.5', versionSeconds: 60,
    }, true);
    expect(p).toMatchObject({
      memory: '6g', cpus: 1.5, disk: '500m', allowWrite: true, allowNetwork: true, allowInstalls: false,
      podman: '/opt/podman/bin/podman', dataDir: '/data', environment: 'podman',
      formats: ['pandoc-markdown', 'text'], bootstrap: ['node.example.org:49737'], saveSeconds: 0.5, versionSeconds: 60,
    });
  });

  it('read empty fields as the defaults', () => {
    expect(preferencesFrom({ memory: '', cpus: '', disk: ' ', saveSeconds: '', podman: '', dataDir: '' }, true)).toMatchObject({
      memory: null, cpus: null, disk: null, saveSeconds: null, podman: null, dataDir: null,
    });
  });

  it('refuse, when saved, what is wrong, saying what', () => {
    expect(() => preferencesFrom({ memory: 'lots' }, true)).toThrow(/memory limit should be a size/);
    expect(() => preferencesFrom({ disk: '0' }, true)).toThrow(/disk limit/);
    expect(() => preferencesFrom({ cpus: 0 }, true)).toThrow(/at least 0.1/);
    expect(() => preferencesFrom({ bootstrap: ['https://node.example.org'] }, true)).toThrow(/host:port/);
    expect(() => preferencesFrom({ formats: [] }, true)).toThrow(/at least one kind/);
    expect(() => preferencesFrom({ versionSeconds: 0 }, true)).toThrow(/Saving a version/);
  });

  it('pass over, when read from disk, what is wrong', () => {
    expect(preferencesFrom({ memory: 'lots', cpus: -1, bootstrap: ['nope', 'a.b:1'], formats: [] })).toMatchObject({
      memory: null, cpus: null, bootstrap: ['a.b:1'], formats: null,
    });
  });
});
