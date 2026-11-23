// What a client's room holds that the host has not yet acknowledged. A room can
// be replaced under a client (another device's room taken in its place): the
// edits on their way to the old one are then carried to the new one, as a
// difference from the room as the host last had all of this client's edits.
import * as Y from 'yjs';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { FRAGMENT } from './model.js';

export interface Acknowledged {
  /**
   * The room as the host last had all of this client's edits, and as it is here,
   * if it holds edits of this client the host has not acknowledged; else null.
   */
  unsent(schema: Schema): { base: PMNode; ours: PMNode } | null;
  stop(): void;
}

/**
 * Follow a client's room: `unsynced` is how many of its updates the host has
 * not acknowledged (the provider's count). Just before an edit made here while
 * the host has everything, the room is kept as it is (one copy, until the host
 * has everything again), so what was made since is known.
 */
export function trackAcknowledged(ydoc: Y.Doc, unsynced: () => number): Acknowledged {
  let acked: Uint8Array | null = null;
  const before = (tr: Y.Transaction) => {
    if (tr.local && unsynced() === 0) acked = Y.encodeStateAsUpdate(ydoc);
  };
  ydoc.on('beforeTransaction', before);
  return {
    unsent(schema) {
      if (!acked || unsynced() === 0) return null;
      const base = new Y.Doc();
      Y.applyUpdate(base, acked);
      return {
        base: yXmlFragmentToProseMirrorRootNode(base.getXmlFragment(FRAGMENT), schema),
        ours: yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT), schema),
      };
    },
    stop: () => ydoc.off('beforeTransaction', before),
  };
}

/** Make a document the room's, as a minimal difference: an edit of this client's, sent to the host as any. */
export function applyDocument(ydoc: Y.Doc, doc: PMNode): void {
  const fragment = ydoc.getXmlFragment(FRAGMENT);
  ydoc.transact(() => updateYFragment(ydoc, fragment, doc, { mapping: new Map(), isOMark: new Map() }));
}
