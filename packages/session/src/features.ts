// What features keep in a room (docs/decisions/0082-annotations.md): a map of
// JSON values per feature and per person, beside the document's fragment in the
// room's Yjs document, so it is shared live, travels between devices with the
// room, and starts and ends with the room's session; and anchors, places in the
// document that move with everyone's typing (Yjs relative positions), read back
// as ProseMirror positions.
//
// Each person's annotations are their own (0082, Who owns an annotation): their
// map is seeded from their own file by their own device, changed only from
// their devices (whatChanged says whose maps a change to a room touches, for
// whoever passes changes on to judge), and written to their file by their device.
//
// y-prosemirror maps between Yjs and ProseMirror positions through an editor's
// binding, which the host has none of. Here a position is found by walking the
// fragment, sizing each element as ProseMirror would (a leaf 1, any other node
// its content and two), from the schema: the same on the host and in a browser.
import * as Y from 'yjs';
import type { Schema } from 'prosemirror-model';
import { FRAGMENT, type FeatureJson } from './model.js';

/** The name of one person's map for a feature in a room. */
export const featureMap = (id: string, person: string) => `feature:${id}:${person}`;
const MAP = /^feature:([a-z][a-z0-9-]{0,40}):([0-9a-f]{64})$/;

/**
 * Which features each person's map was seeded for, from their file, by their
 * own device: `<feature>:<person>`. Only those are written back, so a session
 * started without a feature (or without a person's device) never empties a file.
 */
const SEEDED = 'features-seeded';

/** A room's state for features, and its anchors: what the host reads when it writes a person's file. */
export interface FeatureView {
  /** A person's entries for a feature (empty if none). */
  entries(id: string, person: string): { [key: string]: FeatureJson };
  /** The people with entries (or a seeded map) for a feature in the room. */
  people(id: string): string[];
  /** Where an anchor is in the room's document now, or null if what it was at is gone. */
  positionOf(anchor: FeatureJson): number | null;
  /** Whether a person's map was seeded for the feature, so its entries are their file's and may be written back. */
  seeded(id: string, person: string): boolean;
}

/** Makes anchors in a room's document, as a person's map is seeded. */
export interface Anchors {
  anchorAt(pos: number, assoc?: -1 | 1): FeatureJson;
}

/** What one person's maps start with, by feature id. */
export type FeatureSeed = (anchors: Anchors) => { [id: string]: { [key: string]: FeatureJson } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs types its nodes loosely
type YType = Y.AbstractType<any>;

/** ProseMirror's size of each node of a fragment, from the schema, remembered for one use. */
function sizer(schema: Schema): (t: YType) => number {
  const cache = new Map<YType, number>();
  const size = (t: YType): number => {
    if (t instanceof Y.XmlText) return t.length;
    const known = cache.get(t);
    if (known !== undefined) return known;
    const el = t as Y.XmlElement;
    let s: number;
    if (schema.nodes[el.nodeName]?.isLeaf) s = 1;
    else {
      s = 2;
      for (const c of el.toArray()) s += size(c as YType);
    }
    cache.set(t, s);
    return s;
  };
  return size;
}

/** The Yjs type and index a ProseMirror position is at, inside `parent` (whose content starts at 0). */
function locate(parent: Y.XmlFragment | Y.XmlElement, pos: number, size: (t: YType) => number): { type: YType; index: number } {
  let offset = 0;
  const kids = parent.toArray() as YType[];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!;
    if (c instanceof Y.XmlText) {
      const len = c.length;
      if (pos <= offset + len) return { type: c, index: pos - offset };
      offset += len;
      continue;
    }
    const s = size(c);
    if (pos <= offset) return { type: parent as YType, index: i };
    if (pos < offset + s) {
      // Inside it: in its content, unless it is a leaf (then before it).
      if (s === 1) return { type: parent as YType, index: i };
      const inner = Math.min(Math.max(pos - offset - 1, 0), s - 2);
      return locate(c as Y.XmlElement, inner, size);
    }
    offset += s;
  }
  return { type: parent as YType, index: kids.length };
}

/** An anchor at a ProseMirror position of a room's document. */
export function anchorIn(ydoc: Y.Doc, schema: Schema, pos: number, assoc: -1 | 1 = 1): FeatureJson {
  const fragment = ydoc.getXmlFragment(FRAGMENT);
  const at = locate(fragment, Math.max(0, pos), sizer(schema));
  const rel = Y.createRelativePositionFromTypeIndex(at.type, at.index, assoc < 0 ? -1 : 0);
  return Y.relativePositionToJSON(rel) as FeatureJson;
}

/** Where an anchor is in a room's document, as a ProseMirror position; null if it is not an anchor, or what it was at is gone. */
export function positionIn(ydoc: Y.Doc, schema: Schema, anchor: FeatureJson): number | null {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
  let abs: Y.AbsolutePosition | null;
  try {
    abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor), ydoc);
  } catch {
    return null;
  }
  if (!abs) return null;
  const fragment = ydoc.getXmlFragment(FRAGMENT);
  const size = sizer(schema);
  let t = abs.type as YType;
  let pos = 0;
  if (t instanceof Y.XmlText) pos = abs.index;
  else {
    const kids = (t as Y.XmlElement).toArray() as YType[];
    for (let i = 0; i < abs.index && i < kids.length; i++) pos += size(kids[i]!);
  }
  while (t !== (fragment as YType)) {
    if (!t._item || t._item.deleted) return null;
    const parent = t._item.parent as YType | null;
    if (!parent || !(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) return null;
    let before = 0;
    for (const k of parent.toArray() as YType[]) {
      if (k === t) break;
      before += size(k);
    }
    pos += before + (t instanceof Y.XmlText ? 0 : 1);
    t = parent;
  }
  return pos;
}

/** The people with a map (or a seeded one) for a feature in a room's document. */
export function peopleIn(ydoc: Y.Doc, id: string): string[] {
  const out = new Set<string>();
  for (const name of ydoc.share.keys()) {
    const m = MAP.exec(name);
    // (Reading a map makes it, empty: only one with entries counts.)
    if (m && m[1] === id && ydoc.getMap(name).size > 0) out.add(m[2]!);
  }
  for (const k of ydoc.getMap<boolean>(SEEDED).keys()) if (k.startsWith(`${id}:`)) out.add(k.slice(id.length + 1));
  return [...out].sort();
}

/** A person's entries for a feature in a room's document. */
export function entriesIn(ydoc: Y.Doc, id: string, person: string): { [key: string]: FeatureJson } {
  return ydoc.getMap<FeatureJson>(featureMap(id, person)).toJSON() as { [key: string]: FeatureJson };
}

/** Set and remove a person's entries for a feature, as one change. */
export function updateIn(ydoc: Y.Doc, id: string, person: string, changes: { set?: { [key: string]: FeatureJson }; remove?: string[] }, origin?: unknown): void {
  const map = ydoc.getMap<FeatureJson>(featureMap(id, person));
  ydoc.transact(() => {
    for (const k of changes.remove ?? []) map.delete(k);
    for (const [k, v] of Object.entries(changes.set ?? {})) map.set(k, v);
  }, origin);
}

/** Fill a person's maps from a seed (their device's, from their file), in a document whose fragment is there. */
export function seedIn(ydoc: Y.Doc, schema: Schema, person: string, seed: FeatureSeed, origin?: unknown): void {
  const values = seed({ anchorAt: (pos, assoc) => anchorIn(ydoc, schema, pos, assoc) });
  ydoc.transact(() => {
    const seeded = ydoc.getMap<boolean>(SEEDED);
    for (const [id, entries] of Object.entries(values)) {
      const map = ydoc.getMap<FeatureJson>(featureMap(id, person));
      for (const [k, v] of Object.entries(entries)) map.set(k, v);
      seeded.set(`${id}:${person}`, true);
    }
  }, origin);
}

/** Be told when a person's map is seeded for a feature (turned on, or their device came, while the room was open). Returns how to stop. */
export function onSeeded(ydoc: Y.Doc, fn: () => void): () => void {
  const map = ydoc.getMap<boolean>(SEEDED);
  const handler = () => fn();
  map.observe(handler);
  return () => map.unobserve(handler);
}

/** Whether a person's map was seeded for a feature. */
export function seededIn(ydoc: Y.Doc, id: string, person: string): boolean {
  return ydoc.getMap<boolean>(SEEDED).get(`${id}:${person}`) === true;
}

/** Be told of any change to any person's map for a feature, or to whose are seeded. Returns how to stop. */
export function observeFeature(ydoc: Y.Doc, id: string, fn: () => void): () => void {
  const prefix = `feature:${id}:`;
  const after = (tr: Y.Transaction) => {
    for (const type of tr.changed.keys()) {
      const name = nameOf(ydoc, type as YType);
      if (name?.startsWith(prefix) || name === SEEDED) return fn();
    }
  };
  ydoc.on('afterTransaction', after);
  return () => ydoc.off('afterTransaction', after);
}

/** The keys of people's feature maps a transaction changed (set or taken away), by feature and person. */
export function featureChanges(ydoc: Y.Doc, tr: Y.Transaction): { id: string; person: string; keys: string[] }[] {
  const out: { id: string; person: string; keys: string[] }[] = [];
  for (const [type, keys] of tr.changed) {
    const name = nameOf(ydoc, type as YType);
    const m = name ? MAP.exec(name) : null;
    if (m) out.push({ id: m[1]!, person: m[2]!, keys: [...keys].filter((k): k is string => typeof k === 'string') });
  }
  return out;
}

/** A root type's name in a document, if it is one. */
function nameOf(ydoc: Y.Doc, type: YType): string | null {
  if (type._item) return null;
  for (const [name, t] of ydoc.share) if (t === type) return name;
  return null;
}

/**
 * What a change would change in a room's document, tried on a copy of it: the
 * document itself (its fragment), which people's feature maps, and anything
 * else (the record of seeding, another kind of state; or what cannot be told,
 * a change waiting on others). For whoever takes changes from other devices to
 * judge (0082): the document only from someone who may change it, a person's
 * maps only from their own devices.
 */
export function whatChanged(ydoc: Y.Doc, update: Uint8Array): { doc: boolean; people: Set<string>; other: boolean } {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
  const out = { doc: false, people: new Set<string>(), other: false };
  const fragment = copy.getXmlFragment(FRAGMENT);
  copy.on('afterTransaction', (tr: Y.Transaction) => {
    for (const type of tr.changed.keys()) {
      const t = type as YType;
      if (t === (fragment as YType) || (t._item && Y.isParentOf(fragment, t._item))) {
        out.doc = true;
        continue;
      }
      const name = nameOf(copy, t);
      const m = name ? MAP.exec(name) : null;
      if (m) out.people.add(m[2]!);
      else if (name === SEEDED) {
        // A person's maps marked seeded: theirs (their device seeds them).
        for (const key of tr.changed.get(type) ?? []) {
          const who = typeof key === 'string' ? /^[a-z][a-z0-9-]{0,40}:([0-9a-f]{64})$/.exec(key)?.[1] : undefined;
          if (who) out.people.add(who);
          else out.other = true;
        }
      } else out.other = true;
    }
  });
  try {
    Y.applyUpdate(copy, update);
  } catch {
    out.other = true;
  }
  // What depends on what the copy has not: cannot be told, so taken as anything.
  if (copy.store.pendingStructs || copy.store.pendingDs) out.other = true;
  copy.destroy();
  return out;
}

/** A view of features' state in a room's document. */
export function viewOf(ydoc: Y.Doc, schema: Schema): FeatureView {
  return {
    entries: (id, person) => entriesIn(ydoc, id, person),
    people: (id) => peopleIn(ydoc, id),
    positionOf: (anchor) => positionIn(ydoc, schema, anchor),
    seeded: (id, person) => seededIn(ydoc, id, person),
  };
}
