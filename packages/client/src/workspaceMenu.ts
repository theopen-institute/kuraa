// The menu of the host's workspaces (0087): the core's, opened by a layout (from
// the workspace's name) or by the core's own menu at the upper left. The
// workspaces to switch between, each with its icons at the right: sync, where
// it syncs with other devices or an online copy (with how many saves the online
// copy lacks, and how it stands when pointed at), for any of them, open or not
// (0101); and on the open one's, ⚙, Workspace settings. Apart below them, where the
// host allows it, Add a workspace… (a new one, one joined from an invite link,
// or a folder opened); with none open, Settings…. A host of one folder shows
// just that one. A workspace still opening says so, and one whose folder a
// cloud storage service keeps says which (0103).
import type { HubWorkspace } from './api.js';
import type { ContextIcon, ContextItem } from './ContextMenu.vue';
import { S } from './strings.js';

export interface WorkspaceMenuState {
  workspaces: HubWorkspace[];
  current: string | null;
  /** What the open workspace is called (from the host), else the hub's name for it. */
  name: string;
  /** The host lets people add workspaces. */
  canAdd: boolean;
  /**
   * How each workspace syncs, by id, where it syncs with something (devices, an
   * online copy) and that is known: the saves its online copy lacks, whether a
   * sync is going on now or the last one failed, and how it stands in words.
   */
  syncs: Record<string, WorkspaceSync>;
}

export interface WorkspaceSync {
  pending: number;
  busy: boolean;
  failed: boolean;
  /** How it syncs, a line each (its devices, its online copy). */
  lines: string[];
}

export interface WorkspaceMenuActions {
  switch(id: string): void;
  add(): void;
  /** Settings: the workspace's, or (none open) where you left them. */
  settings(): void;
  /** Sync a workspace now, the open one or another. */
  sync(id: string): void;
}

export function workspaceMenuItems(s: WorkspaceMenuState, act: WorkspaceMenuActions): ContextItem[] {
  const label = (w: HubWorkspace) => (w.id === s.current ? s.name : w.name);
  // Sync, on the row of any workspace that syncs: how it stands when pointed at.
  const syncIcon = (w: HubWorkspace): ContextIcon[] => {
    const sync = s.syncs[w.id];
    if (!sync) return [];
    const action = sync.busy ? S.workspaceSwitcher.syncing : sync.pending ? S.workspaceSwitcher.syncPending(sync.pending) : S.workspaceSwitcher.syncNow;
    return [{
      icon: 'sync',
      label: [action, ...sync.lines].join('\n'),
      run: () => act.sync(w.id),
      testid: w.id === s.current ? 'workspace-sync' : `workspace-sync:${w.id}`,
      busy: sync.busy,
      count: sync.pending,
      warn: sync.failed,
    }];
  };
  const gear: ContextIcon = { icon: 'gear', label: S.workspaceSwitcher.settings, run: () => act.settings(), testid: 'workspace-settings' };
  return [
    // The names, and only what stops one opening (it is otherwise found only by choosing it).
    ...s.workspaces.map((w) => {
      const icons = [...(w.error ? [] : syncIcon(w)), ...(w.id === s.current ? [gear] : [])];
      return {
        label: `${w.id === s.current ? '✓ ' : ''}${label(w)}${w.error ? S.workspaceSwitcher.cannotOpen : w.opening ? S.workspaceSwitcher.opening : ''}${w.cloud ? S.workspaceSwitcher.inCloud(w.cloud) : ''}`,
        run: () => act.switch(w.id),
        testid: `workspace:${w.id}`,
        ...(icons.length ? { icons } : {}),
      };
    }),
    ...(s.canAdd ? [{ label: S.workspaceSwitcher.add, run: () => act.add(), testid: 'workspace-add', divided: s.workspaces.length > 0 }] : []),
    // With none open, Settings (at You) has no row of its own to sit on.
    ...(s.current === null ? [{ label: S.workspaceSwitcher.allSettings, run: () => act.settings(), testid: 'workspace-settings', divided: s.workspaces.length > 0 && !s.canAdd }] : []),
  ];
}
