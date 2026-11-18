// Server side of the session layer: a relay of rooms. The host never touches
// Yjs or Hocuspocus directly; it talks to this narrow interface, so the CRDT
// can be replaced later.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Document } from '@hocuspocus/server';
import * as Y from 'yjs';
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { FRAGMENT, type PresenceUser, type RoomMessage } from './model.js';

export type { PresenceUser, RoomMessage, ChunkOutput, ChunkRef, RunRecord, RunState, RunStep, RunBasis, RunSessionInfo, RunSessionState } from './model.js';

/** Either a ProseMirror document to seed a new generation, or a saved state to resume one. */
export type RoomSeed = { doc: PMNode } | { state: Uint8Array };

export interface RelayHooks {
  /** Throw to reject. Returns the user recorded for the connection. */
  authenticate(token: string, params: URLSearchParams, room: string): PresenceUser | Promise<PresenceUser>;
  /** Only the host creates room content. Return null to refuse an unknown or stale room. */
  load(room: string): RoomSeed | null | Promise<RoomSeed | null>;
  /** A client, or another device, changed the room. Not called for changes the host applies. */
  changed(room: string, user: PresenceUser | null): void;
  /** A client opened the room: it is loaded. */
  loaded?(room: string): void;
  /** Encoded room state, for the host's cache. */
  store(room: string, state: Uint8Array): void | Promise<void>;
  /** The last client left the room. */
  empty(room: string): void;
  /** HTTP requests that are not WebSocket upgrades. Return true when handled. */
  request(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>;
}

export interface RelayOptions {
  path?: string;
  host?: string;
  port?: number;
}

const HOST_ORIGIN = { kuraa: 'host' };

/** Where a change to a room came from: one of this host's clients, the host, or another device. */
export type UpdateSource = { from: 'client'; user: PresenceUser | null } | { from: 'host' } | { from: 'peer'; peer: string; user: PresenceUser | null };

interface PeerOrigin { kuraa: 'peer'; peer: string; user: PresenceUser | null }
const isPeerOrigin = (o: unknown): o is PeerOrigin => typeof o === 'object' && o !== null && (o as PeerOrigin).kuraa === 'peer';

export class Relay {
  private readonly server: Server;
  private readonly path: string;
  private readonly updateListeners = new Set<(room: string, update: Uint8Array, source: UpdateSource) => void>();
  private readonly awarenessListeners = new Set<(room: string, update: Uint8Array, peer: string | null) => void>();
  /** Awareness clients each other device brought into each room: `room\0peer` → client ids. */
  private readonly peerClients = new Map<string, Set<number>>();

  constructor(private readonly hooks: RelayHooks, private readonly options: RelayOptions = {}) {
    this.path = options.path ?? '/collab';
    this.server = new Server({
      name: 'kuraa',
      quiet: true,
      stopOnSignals: false,
      address: options.host ?? '127.0.0.1',
      port: options.port ?? 0,
      debounce: 2000,
      maxDebounce: 10000,
      unloadImmediately: true,
      onRequest: async ({ request, response }) => {
        let handled: boolean;
        try {
          handled = await this.hooks.request(request, response);
        } catch (err) {
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: String((err as Error).message ?? err) }));
          handled = true;
        }
        // Throwing null tells Hocuspocus the request was handled.
        if (handled) throw null;
      },
      onUpgrade: async ({ request, socket }) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== this.path) {
          (socket as { destroy(): void }).destroy();
          throw null;
        }
      },
      onAuthenticate: async ({ token, requestParameters, documentName }) => {
        const user = await this.hooks.authenticate(token, requestParameters, documentName);
        return { user };
      },
      onLoadDocument: async ({ documentName, document }) => {
        const seed = await this.hooks.load(documentName);
        if (!seed) throw new Error(`Unknown or stale room: ${documentName}`);
        if ('state' in seed) Y.applyUpdate(document, seed.state, HOST_ORIGIN);
        else document.transact(() => prosemirrorToYXmlFragment(seed.doc, document.getXmlFragment(FRAGMENT)), HOST_ORIGIN);
        return document;
      },
      onChange: async ({ documentName, context, transactionOrigin, update }) => {
        const source: UpdateSource = transactionOrigin === HOST_ORIGIN ? { from: 'host' }
          : isPeerOrigin(transactionOrigin) ? { from: 'peer', peer: transactionOrigin.peer, user: transactionOrigin.user }
          : { from: 'client', user: (context as { user?: PresenceUser } | undefined)?.user ?? null };
        for (const fn of this.updateListeners) fn(documentName, update, source);
        if (source.from === 'host') return;
        this.hooks.changed(documentName, source.user);
      },
      afterLoadDocument: async ({ documentName }) => {
        this.hooks.loaded?.(documentName);
      },
      onAwarenessUpdate: async ({ documentName, added, updated, removed, transactionOrigin, awareness }) => {
        const changed = [...added, ...updated, ...removed];
        if (isPeerOrigin(transactionOrigin)) {
          const mine = this.peerClients.get(`${documentName}\0${transactionOrigin.peer}`) ?? new Set<number>();
          for (const id of added) mine.add(id);
          for (const id of removed) mine.delete(id);
          this.peerClients.set(`${documentName}\0${transactionOrigin.peer}`, mine);
        }
        if (!changed.length) return;
        const update = encodeAwarenessUpdate(awareness, changed);
        const peer = isPeerOrigin(transactionOrigin) ? transactionOrigin.peer : null;
        for (const fn of this.awarenessListeners) fn(documentName, update, peer);
      },
      onStoreDocument: async ({ documentName, document }) => {
        await this.hooks.store(documentName, Y.encodeStateAsUpdate(document));
      },
      onDisconnect: async ({ documentName, clientsCount }) => {
        if (clientsCount === 0) this.hooks.empty(documentName);
      },
    });
  }

  async listen(): Promise<AddressInfo> {
    await this.server.listen(this.options.port ?? 0);
    return this.server.httpServer.address() as AddressInfo;
  }

  async close(): Promise<void> {
    await this.server.destroy();
  }

  private doc(room: string): Document | undefined {
    return this.server.hocuspocus.documents.get(room);
  }

  isOpen(room: string): boolean {
    return this.doc(room) !== undefined;
  }

  clients(room: string): number {
    return this.doc(room)?.getConnectionsCount() ?? 0;
  }

  /** The room's current content as a ProseMirror document, or null if not loaded. */
  read(room: string, schema: Schema): PMNode | null {
    const d = this.doc(room);
    return d ? yXmlFragmentToProseMirrorRootNode(d.getXmlFragment(FRAGMENT), schema) : null;
  }

  /** Apply a document to the room as a minimal difference, in one transaction. */
  apply(room: string, next: PMNode): boolean {
    const d = this.doc(room);
    if (!d) return false;
    const fragment = d.getXmlFragment(FRAGMENT);
    d.transact(() => updateYFragment(d, fragment, next, { mapping: new Map(), isOMark: new Map() }), HOST_ORIGIN);
    return true;
  }

  state(room: string): Uint8Array | null {
    const d = this.doc(room);
    return d ? Y.encodeStateAsUpdate(d) : null;
  }

  // Rooms across devices -------------------------------------------------

  /** Every change to any room, with where it came from. */
  onUpdate(fn: (room: string, update: Uint8Array, source: UpdateSource) => void): () => void {
    this.updateListeners.add(fn);
    return () => this.updateListeners.delete(fn);
  }

  /** Every change to who is in a room (cursors, names), encoded; `peer` if another device brought it. */
  onAwareness(fn: (room: string, update: Uint8Array, peer: string | null) => void): () => void {
    this.awarenessListeners.add(fn);
    return () => this.awarenessListeners.delete(fn);
  }

  /** What the room holds, as a state vector: for another device to send what it lacks. */
  stateVector(room: string): Uint8Array | null {
    const d = this.doc(room);
    return d ? Y.encodeStateVector(d) : null;
  }

  /** What the room holds that a state vector lacks (all of it, for an empty one). */
  diff(room: string, vector: Uint8Array): Uint8Array | null {
    const d = this.doc(room);
    return d ? (vector.length ? Y.encodeStateAsUpdate(d, vector) : Y.encodeStateAsUpdate(d)) : null;
  }

  /** Apply another device's change to the room; its clients see it as anyone's edit. */
  applyPeerUpdate(room: string, update: Uint8Array, peer: string, user: PresenceUser | null): boolean {
    const d = this.doc(room);
    if (!d || !update.length) return false;
    Y.applyUpdate(d, update, { kuraa: 'peer', peer, user } satisfies PeerOrigin);
    return true;
  }

  /** Who is in the room now, encoded, for a device that has just joined it. */
  awarenessState(room: string): Uint8Array | null {
    const d = this.doc(room);
    if (!d) return null;
    const ids = [...d.awareness.getStates().keys()];
    return ids.length ? encodeAwarenessUpdate(d.awareness, ids) : null;
  }

  applyPeerAwareness(room: string, update: Uint8Array, peer: string): void {
    const d = this.doc(room);
    if (d && update.length) applyAwarenessUpdate(d.awareness, update, { kuraa: 'peer', peer, user: null } satisfies PeerOrigin);
  }

  /** Take another device's people out of a room (it left the room, or went away). */
  removePeerAwareness(peer: string, room?: string): void {
    for (const [k, ids] of this.peerClients) {
      const [r, p] = k.split('\0');
      if (p !== peer || (room !== undefined && r !== room)) continue;
      const d = this.doc(r!);
      if (d && ids.size) removeAwarenessStates(d.awareness, [...ids], { kuraa: 'peer', peer, user: null } satisfies PeerOrigin);
      this.peerClients.delete(k);
    }
  }

  /** Send a message to every client in the room. */
  broadcast(room: string, message: RoomMessage): void {
    this.doc(room)?.broadcastStateless(JSON.stringify(message));
  }

  /** Disconnect every client from a room, e.g. after a reseed. */
  closeRoom(room: string): void {
    this.server.hocuspocus.closeConnections(room);
  }
}

/**
 * A room's starting state, the same wherever it is made: the document written
 * into the room by one fixed client id. Two devices seeding from the same file
 * (the same git blob) with the same id get identical states, which Yjs takes as
 * one; so their rooms combine without either's text appearing twice. Edits that
 * follow use each client's own random id.
 */
export function encodeSeed(doc: PMNode, clientID: number): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.clientID = clientID;
  ydoc.transact(() => prosemirrorToYXmlFragment(doc, ydoc.getXmlFragment(FRAGMENT)));
  return Y.encodeStateAsUpdate(ydoc);
}

/** Encode a ProseMirror document as a room state without a running relay (for caches and tests). */
export function encodeDoc(doc: PMNode): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.transact(() => prosemirrorToYXmlFragment(doc, ydoc.getXmlFragment(FRAGMENT)));
  return Y.encodeStateAsUpdate(ydoc);
}

/** Apply a document to a saved room state as a minimal difference; returns the new state. */
export function patchState(state: Uint8Array, next: PMNode): Uint8Array {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  const fragment = ydoc.getXmlFragment(FRAGMENT);
  ydoc.transact(() => updateYFragment(ydoc, fragment, next, { mapping: new Map(), isOMark: new Map() }), HOST_ORIGIN);
  return Y.encodeStateAsUpdate(ydoc);
}

/** Room states combined, as if every edit in each had been made in one room. */
export function combineStates(...states: Uint8Array[]): Uint8Array {
  return Y.mergeUpdates(states);
}

export function decodeDoc(state: Uint8Array, schema: Schema): PMNode {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT), schema);
}
