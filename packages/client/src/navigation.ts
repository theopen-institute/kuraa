// Navigation as the core gives it (docs/decisions/0087-navigation-is-made-of-components.md):
// what layouts and navigation views are given, made from what the app knows and
// does. The core draws none of it: a layout places the workspace, its
// connection, the core's menus and the views; a view shows the files; what is
// done to files is the core's (FileActions.vue). With no layout that gives
// navigation, the core's own menu at the upper left (FallbackMenu.vue).
import type { ConnectionInfo, FeatureClientContext, FeatureMenuItem, LayoutContext, NavigationContext, NavigationFile } from '@kuraa/feature-kit/client';
import type { FileIcon } from '@kuraa/kernel';
import type { HostApi } from './api.js';
import type { EditorStatus, WorkspaceLink } from './types.js';
import { connectionLabel, S } from './strings.js';

/** What the app gives navigation: its state, as it is now, and what it does. */
export interface NavigationApp {
  workspace(): ReturnType<LayoutContext['workspace']>;
  connection(): ConnectionInfo;
  workspaceMenu(at: HTMLElement): void;
  newMenu(at: HTMLElement): void;
  newMenuOpen(): boolean;
  panelButtons(): ReturnType<LayoutContext['panelButtons']>;
  askPanel(feature: string, id: string): void;
  views(): ReturnType<LayoutContext['views']>;
  workspaceName(): string;
  files(): NavigationFile[];
  folders(): ReturnType<NavigationContext['folders']>;
  selected(): string | null;
  open(path: string): void;
  openConflicts(path: string): void;
  prefetch(path: string | null, now?: boolean): void;
  newFile(folder?: string): void;
  newFolder(parent?: string): void;
  rename(path: string): void;
  remove(path: string): void;
  move(path: string, folder: string): void;
  fileMenu(path: string, at: { x: number; y: number }): void;
  icon(file: NavigationFile): FileIcon | undefined;
}

/** Listeners, told in turn; one that throws is said in the console and the rest still told. */
export class Listeners<A extends unknown[] = []> {
  private readonly set = new Set<(...args: A) => void>();
  add(fn: (...args: A) => void): () => void {
    this.set.add(fn);
    return () => this.set.delete(fn);
  }
  tell(...args: A): void {
    for (const fn of [...this.set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[kuraa] navigation failed on a change', e);
      }
    }
  }
}

/** What navigation is told: layouts of the workspace and what they place changing; views of the files changing, and places to show. */
export interface NavigationEvents {
  layout: Listeners;
  files: Listeners;
  reveal: Listeners<[path: string, from?: string]>;
}

export const navigationEvents = (): NavigationEvents => ({ layout: new Listeners(), files: new Listeners(), reveal: new Listeners() });

/** What a layout is given. */
export function layoutContext(base: FeatureClientContext, app: NavigationApp, events: NavigationEvents): LayoutContext {
  return {
    ...base,
    workspace: () => app.workspace(),
    connection: () => app.connection(),
    onChange: (fn) => events.layout.add(fn),
    workspaceMenu: (at) => app.workspaceMenu(at),
    newMenu: (at) => app.newMenu(at),
    newMenuOpen: () => app.newMenuOpen(),
    panelButtons: () => app.panelButtons(),
    askPanel: (feature, id) => app.askPanel(feature, id),
    views: () => app.views(),
    move: (path, folder) => app.move(path, folder),
  };
}

/** What a navigation view is given. */
export function navigationContext(base: FeatureClientContext, app: NavigationApp, events: NavigationEvents): NavigationContext {
  return {
    ...base,
    workspaceName: () => app.workspaceName(),
    files: () => app.files(),
    folders: () => app.folders(),
    selected: () => app.selected(),
    onChange: (fn) => events.files.add(fn),
    onReveal: (fn) => events.reveal.add(fn),
    open: (path) => app.open(path),
    openConflicts: (path) => app.openConflicts(path),
    prefetch: (path, now) => app.prefetch(path, now),
    newFile: (folder) => app.newFile(folder),
    newFolder: (parent) => app.newFolder(parent),
    rename: (path) => app.rename(path),
    remove: (path) => app.remove(path),
    move: (path, folder) => app.move(path, folder),
    fileMenu: (path, at) => app.fileMenu(path, at),
    icon: (file) => app.icon(file),
  };
}

/** The views' items for ＋, each view's in turn. */
export function viewNewItems(items: (() => FeatureMenuItem[])[]): FeatureMenuItem[] {
  return items.flatMap((fn) => {
    try {
      return fn();
    } catch (e) {
      console.error('[kuraa] a navigation view could not add to ＋', e);
      return [];
    }
  });
}

/**
 * How the open document is connected, or with none open the host (green while
 * it answers: it goes on syncing then too), in words, with who else is here and
 * how the workspace syncs.
 */
export function connectionInfo(status: EditorStatus | null, hasDocument: boolean, link: WorkspaceLink | null): ConnectionInfo {
  const state: ConnectionInfo['state'] = hasDocument ? status?.connection ?? 'connecting' : !link ? 'connecting' : link.reachable ? 'connected' : 'disconnected';
  const peers = hasDocument ? status?.peers ?? [] : [];
  const others = peers.filter((p) => !p.self);
  const label = hasDocument ? connectionLabel(state) : !link ? connectionLabel('connecting') : link.reachable ? S.connection.host : S.connection.noHost;
  const syncing: string[] = [];
  if (link?.reachable) {
    syncing.push(link.devices ? S.connection.devices(link.devices.online, link.devices.total) : S.connection.alone);
    const o = link.online;
    if (o) syncing.push(o.busy ? S.connection.onlineSyncing : o.failed ? S.connection.onlineFailed : o.pending ? S.connection.onlinePending(o.pending) : S.connection.onlineUpToDate);
  }
  const first = others.length ? `${label} · ${S.connection.here(others.length)}: ${others.map((p) => p.name || S.common.anonymous).join(', ')}` : label;
  return {
    state,
    label,
    title: [first, ...syncing].join('\n'),
    syncing,
    peers: peers.map((p) => `${p.name || S.common.anonymous}${p.self ? S.common.you : ''}`),
  };
}

const PREFETCH_HOVER_MS = 150;
const PREFETCH_AGAIN_MS = 60_000;

/**
 * Asking for a file's room ahead (the pointer rests on it, or is pressed on
 * it): the host gets it ready, and keeps it a while, so opening it needs no
 * waiting for that. Once a minute at most per file.
 */
export class Prefetcher {
  private readonly done = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private api: HostApi | null = null;

  prefetch(api: HostApi, path: string | null, selected: string | null, now = false): void {
    clearTimeout(this.timer);
    // Another workspace: its files are other files.
    if (api !== this.api) {
      this.done.clear();
      this.api = api;
    }
    if (!path || path === selected) return;
    const go = () => {
      const at = this.done.get(path);
      if (at !== undefined && Date.now() - at < PREFETCH_AGAIN_MS) return;
      this.done.set(path, Date.now());
      api.room(path).catch(() => this.done.delete(path));
    };
    if (now) go();
    else this.timer = setTimeout(go, PREFETCH_HOVER_MS);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
