// The menu of the host's workspaces (0087): the core's, opened by a layout (from
// the workspace's name) or by the core's own menu at the upper left. The
// workspaces to switch between, the open one's row with its icons at the right:
// sync, where it syncs with other devices or an online copy (with how many saves
// the online copy lacks), and ⚙, Workspace settings. Apart below them, where the
// host allows it, Add a workspace… (a new one, one joined from an invite link,
// or a folder opened); with none open, Settings…. A host of one folder shows
// just that one.
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
  /** It syncs with something (devices, an online copy): the saves its online copy lacks, and whether a sync is going on now. */
  sync: { pending: number; busy: boolean } | null;
}

export interface WorkspaceMenuActions {
  switch(id: string): void;
  add(): void;
  /** Settings: the workspace's, or (none open) where you left them. */
  settings(): void;
  sync(): void;
}

export function workspaceMenuItems(s: WorkspaceMenuState, act: WorkspaceMenuActions): ContextItem[] {
  const label = (w: HubWorkspace) => (w.id === s.current ? s.name : w.name);
  const sync = s.sync;
  // What acts on the open workspace, on its row.
  const icons: ContextIcon[] = [
    ...(sync ? [{
      icon: 'sync' as const,
      label: sync.busy ? S.workspaceSwitcher.syncing : sync.pending ? S.workspaceSwitcher.syncPending(sync.pending) : S.workspaceSwitcher.syncNow,
      run: () => act.sync(),
      testid: 'workspace-sync',
      busy: sync.busy,
      count: sync.pending,
    }] : []),
    { icon: 'gear', label: S.workspaceSwitcher.settings, run: () => act.settings(), testid: 'workspace-settings' },
  ];
  return [
    // The names, and only what stops one opening (it is otherwise found only by choosing it).
    ...s.workspaces.map((w) => ({
      label: `${w.id === s.current ? '✓ ' : ''}${label(w)}${w.error ? S.workspaceSwitcher.cannotOpen : ''}`,
      run: () => act.switch(w.id),
      testid: `workspace:${w.id}`,
      ...(w.id === s.current ? { icons } : {}),
    })),
    ...(s.canAdd ? [{ label: S.workspaceSwitcher.add, run: () => act.add(), testid: 'workspace-add', divided: s.workspaces.length > 0 }] : []),
    // With none open, Settings (at You) has no row of its own to sit on.
    ...(s.current === null ? [{ label: S.workspaceSwitcher.allSettings, run: () => act.settings(), testid: 'workspace-settings', divided: s.workspaces.length > 0 && !s.canAdd }] : []),
  ];
}
