// Headless room clients for integration tests (Node 22+ has a global WebSocket).
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { FRAGMENT, type FeatureJson, type PresenceUser, type RoomMessage } from './model.js';
import { anchorIn, entriesIn, peopleIn, positionIn, updateIn } from './features.js';

export interface HeadlessClient {
  ready: Promise<void>;
  messages: RoomMessage[];
  read(): PMNode;
  /** Replace the document with `next`, as a minimal difference (like an editor would). */
  write(next: PMNode): void;
  peers(): PresenceUser[];
  /** A feature's state in the room (0082), as a client's editor has it. */
  feature(id: string, person: string): {
    entries(): { [key: string]: FeatureJson };
    people(): string[];
    update(changes: { set?: { [key: string]: FeatureJson }; remove?: string[] }): void;
    anchorAt(pos: number, assoc?: -1 | 1): FeatureJson;
    positionOf(anchor: FeatureJson): number | null;
  };
  destroy(): void;
}

/** A change setting entries in someone's feature map, made on a copy of a room's state (another device's, say): for tests to pass on. */
export function featureUpdate(state: Uint8Array, id: string, person: string, set: { [key: string]: FeatureJson }): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, state);
  const sv = Y.encodeStateVector(copy);
  updateIn(copy, id, person, { set });
  return Y.encodeStateAsUpdate(copy, sv);
}

export function connectHeadless(opts: { url: string; room: string; token: string; user: PresenceUser; schema: Schema }): HeadlessClient {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment(FRAGMENT);
  const messages: RoomMessage[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  const params = new URLSearchParams({ name: opts.user.name, email: opts.user.email, color: opts.user.color });
  const provider = new HocuspocusProvider({
    url: `${opts.url}?${params}`,
    name: opts.room,
    document: ydoc,
    token: opts.token,
    onSynced: ({ state }) => { if (state) resolveReady(); },
    onAuthenticationFailed: ({ reason }) => rejectReady(new Error(`auth failed: ${reason}`)),
    onStateless: ({ payload }) => messages.push(JSON.parse(payload) as RoomMessage),
  });
  provider.awareness?.setLocalStateField('user', opts.user);
  return {
    ready,
    messages,
    read: () => yXmlFragmentToProseMirrorRootNode(fragment, opts.schema),
    write: (next) => ydoc.transact(() => updateYFragment(ydoc, fragment, next, { mapping: new Map(), isOMark: new Map() })),
    peers: () => [...(provider.awareness?.getStates().values() ?? [])].map((s) => (s as { user?: PresenceUser }).user).filter((u): u is PresenceUser => !!u),
    feature: (id, person) => ({
      entries: () => entriesIn(ydoc, id, person),
      people: () => peopleIn(ydoc, id),
      update: (changes) => updateIn(ydoc, id, person, changes),
      anchorAt: (pos, assoc) => anchorIn(ydoc, opts.schema, pos, assoc),
      positionOf: (anchor) => positionIn(ydoc, opts.schema, anchor),
    }),
    destroy: () => { provider.destroy(); ydoc.destroy(); },
  };
}
