// Client side of the session layer: connect to a room on a host's relay and
// bind it to a ProseMirror editor. The client never seeds a room; it waits for
// the host's content before the editor is created.
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { redo, undo, yCursorPlugin, ySyncPlugin, yUndoPlugin, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import type { Command, Plugin } from 'prosemirror-state';
import { FRAGMENT, type PresenceUser, type RoomMessage } from './model.js';

export type { PresenceUser, RoomMessage, ChunkOutput, ChunkRef, RunRecord, RunState, RSessionInfo, RSessionState } from './model.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unauthorized';

export interface Peer extends PresenceUser {
  clientId: number;
  self: boolean;
}

export interface RoomOptions {
  /** WebSocket URL of the host's relay, e.g. ws://localhost:4321/collab */
  url: string;
  room: string;
  /** Rooms are keyed by file; older generations of the same key are discarded from the cache. */
  cacheKey: string;
  token: string;
  user: PresenceUser;
  onStatus?(status: ConnectionStatus): void;
  onPeers?(peers: Peer[]): void;
  onMessage?(message: RoomMessage): void;
  onUnsynced?(count: number): void;
}

export interface RoomConnection {
  /** Resolves once the host's content has arrived. */
  ready: Promise<void>;
  plugins(): Plugin[];
  undo: Command;
  redo: Command;
  setUser(user: PresenceUser): void;
  /** The room content as ProseMirror, e.g. for a source view. */
  snapshot(schema: Schema): PMNode;
  destroy(): void;
}

const CACHE_INDEX = 'kuraa:room-cache';

/** Remove cached rooms for older generations of the same file. */
function pruneCache(cacheKey: string, room: string): void {
  try {
    const index = JSON.parse(localStorage.getItem(CACHE_INDEX) ?? '{}') as Record<string, string>;
    const previous = index[cacheKey];
    if (previous && previous !== room) indexedDB.deleteDatabase(previous);
    index[cacheKey] = room;
    localStorage.setItem(CACHE_INDEX, JSON.stringify(index));
  } catch {
    // Storage may be unavailable (private windows); the cache is only a convenience.
  }
}

export function connectRoom(options: RoomOptions): RoomConnection {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment(FRAGMENT);
  pruneCache(options.cacheKey, options.room);
  let cache: IndexeddbPersistence | null = null;
  try {
    cache = new IndexeddbPersistence(options.room, ydoc);
  } catch {
    cache = null;
  }

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  // Uncommitted edits cached from an earlier visit let the editor open before the host answers.
  cache?.once('synced', () => {
    if (fragment.length > 0) resolveReady();
  });

  // The host records name and email for co-author credit; they travel with the connection.
  const params = new URLSearchParams({ name: options.user.name, email: options.user.email, color: options.user.color });
  const provider = new HocuspocusProvider({
    url: `${options.url}${options.url.includes('?') ? '&' : '?'}${params}`,
    name: options.room,
    document: ydoc,
    token: options.token,
    onStatus: ({ status }) => {
      options.onStatus?.(status === WebSocketStatus.Connected ? 'connected' : status === WebSocketStatus.Connecting ? 'connecting' : 'disconnected');
    },
    onAuthenticationFailed: () => options.onStatus?.('unauthorized'),
    onSynced: ({ state }) => {
      if (state) resolveReady();
    },
    onStateless: ({ payload }) => {
      try {
        options.onMessage?.(JSON.parse(payload) as RoomMessage);
      } catch {
        // Ignore malformed messages.
      }
    },
    onUnsyncedChanges: ({ number }) => options.onUnsynced?.(number),
  });

  const awareness = provider.awareness!;
  const setUser = (user: PresenceUser) => awareness.setLocalStateField('user', user);
  setUser(options.user);

  const emitPeers = () => {
    const peers: Peer[] = [];
    awareness.getStates().forEach((state, clientId) => {
      const u = (state as { user?: PresenceUser }).user;
      if (u) peers.push({ ...u, clientId, self: clientId === ydoc.clientID });
    });
    options.onPeers?.(peers);
  };
  awareness.on('change', emitPeers);
  emitPeers();

  return {
    ready,
    plugins: () => [ySyncPlugin(fragment), yCursorPlugin(awareness), yUndoPlugin()],
    undo: (state, dispatch) => (dispatch ? undo(state) : true),
    redo: (state, dispatch) => (dispatch ? redo(state) : true),
    setUser,
    snapshot: (schema) => yXmlFragmentToProseMirrorRootNode(fragment, schema),
    destroy: () => {
      awareness.off('change', emitPeers);
      provider.destroy();
      void cache?.destroy();
      ydoc.destroy();
    },
  };
}
