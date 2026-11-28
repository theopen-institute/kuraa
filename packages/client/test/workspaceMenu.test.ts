// The workspaces' menu (0087, 0101): every workspace that syncs has its own
// sync icon, saying how it stands, the open one's with ⚙ beside it.
import { describe, expect, it } from 'vitest';
import { workspaceMenuItems, type WorkspaceMenuActions } from '../src/workspaceMenu.js';
import { syncLines } from '../src/navigation.js';

const workspaces = [
  { id: 'a', name: 'Thesis', path: '/a', peers: true },
  { id: 'b', name: 'Fieldwork', path: '/b', peers: true },
  { id: 'c', name: 'Notes', path: '/c', peers: false },
  { id: 'd', name: 'Broken', path: '/d', peers: true, error: 'its folder is gone' },
];

function menu(synced: string[] = []) {
  const act: WorkspaceMenuActions = { switch: () => undefined, add: () => undefined, settings: () => undefined, sync: (id) => synced.push(id) };
  return workspaceMenuItems({
    workspaces,
    current: 'a',
    name: 'Thesis',
    canAdd: true,
    syncs: {
      a: { pending: 0, busy: false, failed: false, lines: ['Syncing with your other device'] },
      b: { pending: 3, busy: false, failed: true, lines: ['Not shared with other devices', 'Personal backup: the last sync did not go through'] },
      d: { pending: 0, busy: false, failed: false, lines: [] },
    },
  }, act);
}

describe('the workspaces menu', () => {
  it('gives each workspace that syncs a sync icon of its own, the open one ⚙ too', () => {
    const items = menu();
    expect(items[0]!.icons?.map((i) => i.testid)).toEqual(['workspace-sync', 'workspace-settings']);
    expect(items[1]!.icons?.map((i) => i.testid)).toEqual(['workspace-sync:b']);
    // Syncing with nothing: no icon; one that cannot open: none either.
    expect(items[2]!.icons).toBeUndefined();
    expect(items[3]!.icons).toBeUndefined();
  });

  it('says how one stands when pointed at, counts the saves its online copy lacks, and marks a failed sync', () => {
    const sync = menu()[1]!.icons![0]!;
    expect(sync.label).toBe('Sync now (3 saves not in your backup yet)\nNot shared with other devices\nPersonal backup: the last sync did not go through');
    expect(sync.count).toBe(3);
    expect(sync.warn).toBe(true);
  });

  it('syncs the workspace whose icon it is, open or not', () => {
    const synced: string[] = [];
    const items = menu(synced);
    items[1]!.icons![0]!.run();
    items[0]!.icons![0]!.run();
    expect(synced).toEqual(['b', 'a']);
  });
});

describe('how a workspace syncs, in words', () => {
  it('is its devices, then its online copy', () => {
    expect(syncLines({ reachable: true, devices: { online: 1, total: 2 }, online: { pending: 2, busy: false, failed: false } }))
      .toEqual(['Syncing with 1 of 2 devices', 'Personal backup: 2 saves not there yet']);
    expect(syncLines({ reachable: true, devices: null, online: null })).toEqual(['Not shared with other devices']);
    expect(syncLines({ reachable: false, devices: null, online: null })).toEqual([]);
  });
});
