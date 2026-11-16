// Server side of the session layer: a relay of rooms. The host never touches
// Yjs or Hocuspocus directly; it talks to this narrow interface, so the CRDT
// can be replaced later.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Document } from '@hocuspocus/server';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { FRAGMENT, type PresenceUser, type RoomMessage } from './model.js';

export type { PresenceUser, RoomMessage, ChunkOutput, ChunkRef, RunRecord, RunState, RSessionInfo, RSessionState } from './model.js';

/** Either a ProseMirror document to seed a new generation, or a saved state to resume one. */
export type RoomSeed = { doc: PMNode } | { state: Uint8Array };

export interface RelayHooks {
  /** Throw to reject. Returns the user recorded for the connection. */
  authenticate(token: string, params: URLSearchParams, room: string): PresenceUser | Promise<PresenceUser>;
  /** Only the host creates room content. Return null to refuse an unknown or stale room. */
  load(room: string): RoomSeed | null | Promise<RoomSeed | null>;
  /** A client changed the room. Not called for changes the host applies. */
  changed(room: string, user: PresenceUser | null): void;
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

export class Relay {
  private readonly server: Server;
  private readonly path: string;

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
      onChange: async ({ documentName, context, transactionOrigin }) => {
        if (transactionOrigin === HOST_ORIGIN) return;
        this.hooks.changed(documentName, (context as { user?: PresenceUser } | undefined)?.user ?? null);
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

  /** Send a message to every client in the room. */
  broadcast(room: string, message: RoomMessage): void {
    this.doc(room)?.broadcastStateless(JSON.stringify(message));
  }

  /** Disconnect every client from a room, e.g. after a reseed. */
  closeRoom(room: string): void {
    this.server.hocuspocus.closeConnections(room);
  }
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

export function decodeDoc(state: Uint8Array, schema: Schema): PMNode {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT), schema);
}
