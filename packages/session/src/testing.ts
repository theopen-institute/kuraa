// Headless room clients for integration tests (Node 22+ has a global WebSocket).
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { FRAGMENT, type PresenceUser, type RoomMessage } from './model.js';

export interface HeadlessClient {
  ready: Promise<void>;
  messages: RoomMessage[];
  read(): PMNode;
  /** Replace the document with `next`, as a minimal difference (like an editor would). */
  write(next: PMNode): void;
  peers(): PresenceUser[];
  destroy(): void;
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
    destroy: () => { provider.destroy(); ydoc.destroy(); },
  };
}
