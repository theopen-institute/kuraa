// Client side of the session layer: connect to a room on a host's relay and
// bind it to a ProseMirror editor. The client never seeds a room; it waits for
// the host's content before the editor is created.
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { redo, undo, yCursorPlugin, ySyncPlugin, ySyncPluginKey, yUndoPlugin, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import type { Command, Plugin, Transaction } from 'prosemirror-state';
import { FRAGMENT, type FeatureJson, type PresenceUser, type RoomMessage } from './model.js';
import { applyDocument, trackAcknowledged } from './acked.js';
import { anchorIn, entriesIn, observeFeature, onSeeded, peopleIn, positionIn, seededIn, updateIn } from './features.js';


/**
 * Another person's cursor, as y-prosemirror draws it but with no text of its own
 * and not editable. y-prosemirror's has invisible characters, and a click past
 * the end of a line put the caret among them, inside the cursor, where what was
 * typed never reached the document.
 */
function cursorBuilder(user: { name?: string; color?: string }): HTMLElement {
  const cursor = document.createElement('span');
  cursor.className = 'ProseMirror-yjs-cursor';
  cursor.contentEditable = 'false';
  cursor.style.borderColor = user.color ?? '#888';
  const label = document.createElement('div');
  label.style.backgroundColor = user.color ?? '#888';
  label.textContent = user.name ?? '';
  cursor.append(label);
  return cursor;
}

export type { PresenceUser, RoomMessage, ChunkOutput, ChunkRef, RunRecord, RunState, RunStep, RunBasis, MadeFrom, RunSessionInfo, RunSessionState, FeatureJson } from './model.js';

/**
 * A feature's state in a room (0082), as one person has it: their own entries,
 * which they change, everyone else's in the room, which they see; anchors that
 * move with everyone's typing.
 */
export interface RoomFeature {
  /** Whose: the person this host is. */
  readonly me: string;
  /** Whether this person's map was seeded from their file: only then is what is changed here written back. */
  seeded(): boolean;
  /** This person's entries. */
  entries(): { [key: string]: FeatureJson };
  /** Everyone else's in the room, by person. */
  others(): { [person: string]: { [key: string]: FeatureJson } };
  update(changes: { set?: { [key: string]: FeatureJson }; remove?: string[] }): void;
  observe(fn: () => void): () => void;
  anchorAt(pos: number, assoc?: -1 | 1): FeatureJson;
  positionOf(anchor: FeatureJson): number | null;
}

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
  /**
   * Whether a transaction came from the room (another client, the host) or from
   * undo/redo, rather than from this user's own editing. Plugins that tidy the
   * document after an edit should act only on this user's edits, so that two
   * clients never make the same structural change at once.
   */
  isRemote(tr: Transaction): boolean;
  /** Try to connect again now, rather than after the wait between attempts (Try again, while offline). */
  reconnect(): void;
  /**
   * Edits made here that the host has not acknowledged: the room as the host last
   * had all of this client's edits, and as it is here. Null when the host has them all.
   */
  unsent(schema: Schema): { base: PMNode; ours: PMNode } | null;
  /** Wait until the host has every edit made here (true), or `ms` pass (false). */
  settled(ms: number): Promise<boolean>;
  /** Make a document the room's, as a minimal difference: an edit of this client's (before the editor is made). */
  apply(doc: PMNode): void;
  /** A feature's state in the room (0082) for a person (this host's), for a document of this schema. */
  feature(id: string, schema: Schema, person: string): RoomFeature;
  /** Be told when the room is seeded for a feature after it opened (one turned on meanwhile). Returns how to stop. */
  onSeeded(fn: () => void): () => void;
  /** Close, and forget this room's cache here (the room was replaced: nothing will open it again). */
  forget(): void;
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

  let unsynced = 0;
  const waiting = new Set<(arrived: boolean) => void>();
  const acked = trackAcknowledged(ydoc, () => unsynced);

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
    onUnsyncedChanges: ({ number }) => {
      unsynced = number;
      if (!number) for (const fn of [...waiting]) fn(true);
      options.onUnsynced?.(number);
    },
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

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    awareness.off('change', emitPeers);
    acked.stop();
    for (const fn of [...waiting]) fn(false);
    provider.destroy();
    void cache?.destroy();
    ydoc.destroy();
  };

  return {
    ready,
    plugins: () => [ySyncPlugin(fragment), yCursorPlugin(awareness, { cursorBuilder }), yUndoPlugin()],
    undo: (state, dispatch) => (dispatch ? undo(state) : true),
    isRemote: (tr) => (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin === true,
    redo: (state, dispatch) => (dispatch ? redo(state) : true),
    setUser,
    reconnect: () => void provider.configuration.websocketProvider.connect(),
    snapshot: (schema) => yXmlFragmentToProseMirrorRootNode(fragment, schema),
    unsent: (schema) => acked.unsent(schema),
    settled: (ms) => new Promise<boolean>((resolve) => {
      if (!unsynced) return resolve(true);
      const done = (arrived: boolean) => {
        clearTimeout(timer);
        waiting.delete(done);
        resolve(arrived);
      };
      const timer = setTimeout(() => done(false), ms);
      waiting.add(done);
    }),
    apply: (doc) => applyDocument(ydoc, doc),
    feature: (id, schema, person) => ({
      me: person,
      seeded: () => seededIn(ydoc, id, person),
      entries: () => entriesIn(ydoc, id, person),
      others: () => Object.fromEntries(peopleIn(ydoc, id).filter((p) => p !== person).map((p) => [p, entriesIn(ydoc, id, p)])),
      update: (changes) => updateIn(ydoc, id, person, changes),
      observe: (fn) => observeFeature(ydoc, id, fn),
      anchorAt: (pos, assoc) => anchorIn(ydoc, schema, pos, assoc),
      positionOf: (anchor) => positionIn(ydoc, schema, anchor),
    }),
    onSeeded: (fn) => onSeeded(ydoc, fn),
    forget: () => {
      destroy();
      try {
        indexedDB.deleteDatabase(options.room);
      } catch {
        // Storage may be unavailable; nothing was kept then.
      }
    },
    destroy,
  };
}
