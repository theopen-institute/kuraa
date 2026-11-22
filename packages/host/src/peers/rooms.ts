// Rooms across devices: when people on two devices have the same file open,
// their hosts join the two rooms, so everyone edits one document live.
//
// A room is known to other devices by branch, path and type version (its key)
// and by the blob it started from (its seed, 0027). Each device tells the
// others which rooms it has open. Rooms with the same seed are kept in step
// with Yjs updates both ways (and who is in them: names, cursors). Rooms with
// different seeds cannot merge their histories: the one with the higher seed
// takes the other's room and brings its own text in as a three-way merge, so
// every device in the end shares the lowest seed among them, and nothing is
// lost (Host.adoptRoom).
//
// A device takes live edits from the devices whose person may change the
// document (0066: the workspace's write rules; everyone, where there are none),
// and sends its own to every device with it open, so all can read along. Of the
// devices with a room open that may change it, the one with the lowest key
// commits it (Host.commitNow asks `commits`); the others write the file but
// leave committing to it, and its commit reaches them within moments. A device
// that may not change it takes the room of one that may, never the other way
// round. Every device sees the same devices in the room, and holds the same
// policy, so they agree without any setting they share.
import type { PresenceUser } from '@kuraa/session/server';
import type { Host, RoomView } from '../host.js';
import type { PeerLink } from './link.js';
import type { PeerNode } from './node.js';

/** Bytes: as they are on the rooms channel, base64 from a device that has only the control channel (link.ts). */
type Bytes = Uint8Array | string;

type RoomMessage =
  | { type: 'room'; op: 'open'; key: string; seed: string; sv: Bytes; people?: PresenceUser[] }
  | { type: 'room'; op: 'close'; key: string }
  | { type: 'room'; op: 'sync'; key: string; seed: string; sv: Bytes; update: Bytes; people?: PresenceUser[] }
  | { type: 'room'; op: 'update'; key: string; update: Bytes; by?: PresenceUser | null }
  | { type: 'room'; op: 'awareness'; key: string; update: Bytes }
  | { type: 'room'; op: 'want'; key: string }
  | { type: 'room'; op: 'state'; key: string; seed: string; state: Bytes; base?: string | null };

/** The document a room is of, from its key (Host.roomKey: branch, path and type version, apart by NULs); null if it is not one. */
export function pathOf(key: string): string | null {
  const parts = key.split('\0');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/** A message's bytes, however they came; empty if they are not bytes at all. */
export function bytesOf(v: unknown): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array();
}

const EMPTY = new Uint8Array();

export class Rooms {
  /** What each device has open: device key → room key → seed. */
  private readonly remote = new Map<string, Map<string, string>>();
  private readonly stops: (() => void)[] = [];
  /**
   * Rooms this device has sent to another to take (room key → that device's
   * key), until it opens them again from this one's seed. Meanwhile the room is
   * as good as shared with it: its work must not also come into the room through git.
   */
  private readonly handedTo = new Map<string, string>();
  /** Another device opened a document here not open there before (for run outputs under way: outputs.ts). */
  onOpened: ((link: PeerLink, path: string) => void) | null = null;

  constructor(private readonly host: Host, private readonly node: PeerNode) {
    const relay = host.sessionRelay;
    this.stops.push(relay.onUpdate((name, update, source) => {
      const room = host.roomView(name);
      if (!room) return;
      const by = source.from === 'host' ? null : source.user;
      for (const link of this.peersIn(room)) {
        if (source.from === 'peer' && source.peer === link.key) continue;
        this.send(link, { type: 'room', op: 'update', key: room.key, update, by });
      }
    }));
    this.stops.push(relay.onAwareness((name, update, peer) => {
      const room = host.roomView(name);
      if (!room) return;
      for (const link of this.peersIn(room)) if (link.key !== peer) this.send(link, { type: 'room', op: 'awareness', key: room.key, update });
    }));
  }

  private send(link: PeerLink, m: RoomMessage): void {
    link.sendRoom(m);
  }

  /** Connected devices of this workspace with the same room open, from the same seed. */
  private peersIn(room: RoomView): PeerLink[] {
    return [...this.node.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.node.ws.id && this.remote.get(l.key)?.get(room.key) === room.seed);
  }

  private openMessage(room: RoomView): RoomMessage {
    return { type: 'room', op: 'open', key: room.key, seed: room.seed, sv: this.host.sessionRelay.stateVector(room.name) ?? EMPTY, people: this.host.roomContributors(room.name) };
  }

  /** The connected devices of this workspace with a document open, on any branch. */
  devicesWith(path: string): PeerLink[] {
    return [...this.node.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.node.ws.id && [...(this.remote.get(l.key)?.keys() ?? [])].some((key) => pathOf(key) === path));
  }

  /** A device connected: tell it which rooms are open here. */
  connected(link: PeerLink): void {
    if (link.hello?.workspace !== this.node.ws.id) return;
    for (const room of this.host.liveRooms()) this.send(link, this.openMessage(room));
  }

  /** A device went away: its people leave the rooms, and rooms it committed are committed here now. */
  disconnected(link: PeerLink): void {
    const had = this.remote.get(link.key);
    this.remote.delete(link.key);
    for (const [key, to] of this.handedTo) if (to === link.key) this.handedTo.delete(key);
    this.host.sessionRelay.removePeerAwareness(link.key);
    if (had) this.recommit(had.keys());
  }

  private recommit(keys: Iterable<string>): void {
    for (const key of keys) {
      const room = this.host.liveRoom(key);
      if (room) this.host.commitSoon(room.name);
    }
  }

  /** A room opened here (the relay holds it): tell the other devices. */
  opened(name: string): void {
    const room = this.host.roomView(name);
    if (!room) return;
    for (const link of this.node.links.values()) if (link.accepted && link.hello?.workspace === this.node.ws.id) this.send(link, this.openMessage(room));
  }

  /** A room closed here (no one has it open). */
  closed(key: string): void {
    for (const link of this.node.links.values()) if (link.accepted) this.send(link, { type: 'room', op: 'close', key });
  }

  message(link: PeerLink, raw: { type: 'room'; [k: string]: unknown }): void {
    try {
      this.handle(link, raw);
    } catch (e) {
      this.host.log(`peers: a room message from ${link.remote} could not be used: ${(e as Error).message}`);
    }
  }

  private handle(link: PeerLink, raw: { type: 'room'; [k: string]: unknown }): void {
    if (link.hello?.workspace !== this.node.ws.id) return;
    const m = raw as unknown as RoomMessage;
    if (typeof m.key !== 'string') return;
    const relay = this.host.sessionRelay;
    const room = this.host.liveRoom(m.key);
    const theirs = this.remote.get(link.key) ?? new Map<string, string>();
    this.remote.set(link.key, theirs);
    switch (m.op) {
      case 'open':
      case 'sync': {
        const path = pathOf(m.key);
        const fresh = path !== null && ![...theirs.keys()].some((k) => pathOf(k) === path);
        theirs.set(m.key, String(m.seed));
        if (fresh) this.onOpened?.(link, path);
        if (!room) return;
        const theyMay = this.node.mayWrite(link.key, room.path);
        const iMay = this.node.mayWrite(this.node.myKey, room.path);
        if (m.seed === room.seed) {
          // A room handed over is theirs now too.
          if (this.handedTo.get(room.key) === link.key) this.handedTo.delete(room.key);
          // Who edited it there since its last commit: credited by whichever device commits.
          if (Array.isArray(m.people) && theyMay) this.host.addContributors(room.name, m.people);
          if (m.op === 'sync' && theyMay) relay.applyPeerUpdate(room.name, bytesOf(m.update), link.key, null);
          const update = relay.diff(room.name, bytesOf(m.sv));
          if (m.op === 'open') this.send(link, { type: 'room', op: 'sync', key: room.key, seed: room.seed, sv: relay.stateVector(room.name) ?? EMPTY, update: update ?? EMPTY, people: this.host.roomContributors(room.name) });
          else if (update) this.send(link, { type: 'room', op: 'update', key: room.key, update });
          const people = relay.awarenessState(room.name);
          if (people) this.send(link, { type: 'room', op: 'awareness', key: room.key, update: people });
        } else if (theyMay && (String(m.seed) < room.seed || !iMay)) {
          // Theirs is the room to share (the lower seed, or theirs to change and not this one's): take it.
          this.send(link, { type: 'room', op: 'want', key: room.key });
        } else if (m.op === 'open') {
          // This one is: make sure they know of it, so they ask for it.
          this.send(link, this.openMessage(room));
        }
        return;
      }
      case 'close':
        theirs.delete(m.key);
        if (room) {
          relay.removePeerAwareness(link.key, room.name);
          this.recommit([m.key]);
        }
        return;
      case 'update':
        // Only from a device whose person may change the document (0066): any other's edits are not taken.
        if (room && theirs.get(m.key) === room.seed && this.node.mayWrite(link.key, room.path)) relay.applyPeerUpdate(room.name, bytesOf(m.update), link.key, m.by ?? null);
        return;
      case 'awareness':
        if (room && theirs.get(m.key) === room.seed) relay.applyPeerAwareness(room.name, bytesOf(m.update), link.key);
        return;
      case 'want': {
        // Answered in turn with this device's git work (Host.serial), never in the middle of it. Bringing
        // the other device's commits in may change this room as an outside change; the state sent must
        // already hold that change, or the other device, merging its own text into this state, would
        // bring the same change in a second time, and the room would hold it twice.
        void this.host.serial(async () => {
          const now = this.host.liveRoom(m.key);
          const state = now && relay.state(now.name);
          if (!now || !state) return;
          this.handedTo.set(now.key, link.key);
          this.send(link, { type: 'room', op: 'state', key: now.key, seed: now.seed, state, base: this.host.roomBase(now.name) });
        }).catch((e: Error) => this.host.log(`peers: could not send the room for ${m.key} to ${link.remote}: ${e.message}`));
        return;
      }
      case 'state': {
        // A room taken only from a device that may change the document: with the lower seed, or where this one may not.
        if (!room || !this.node.mayWrite(link.key, room.path)) return;
        if (!(String(m.seed) < room.seed) && this.node.mayWrite(this.node.myKey, room.path)) return;
        const base = typeof m.base === 'string' && /^[0-9a-f]{40,64}$/.test(m.base) ? m.base : null;
        void (async () => {
          // Their room's starting commit is needed to merge from where the two meet: fetch it if it is not here yet.
          if (base && (await this.host.git.run(['cat-file', '-e', `${base}^{commit}`], { allowFail: true })).code !== 0) await this.node.fetch(link.remote!);
          await this.host.adoptRoom(room.name, String(m.seed), bytesOf(m.state), link.remote ?? 'another device', base);
        })().catch((e: Error) => this.host.log(`peers: could not take ${link.remote}'s room for ${room.path}: ${e.message}`));
        return;
      }
    }
  }

  /**
   * Rooms open both here and on the device from different seeds, where one will
   * take the other's (the one with the higher seed), or handed to it and not yet taken.
   */
  private unsettled(link: PeerLink): boolean {
    if ([...this.handedTo.values()].includes(link.key)) return true;
    const theirs = this.remote.get(link.key);
    if (!theirs) return false;
    return this.host.liveRooms().some((r) => {
      const seed = theirs.get(r.key);
      return seed !== undefined && seed !== r.seed;
    });
  }

  /** Whether the room here holds the device's edits too: shared with it, or handed to it to take. */
  private sharedWith(link: PeerLink, room: RoomView): boolean {
    return this.remote.get(link.key)?.get(room.key) === room.seed || this.handedTo.get(room.key) === link.key;
  }

  /**
   * Wait (a while at most) until rooms open on both devices share a seed, so a
   * device's work reaches such a room through the room and not also through git.
   */
  async settle(link: PeerLink, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (this.unsettled(link) && Date.now() < end && !link.closed) await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * For merging a device's commits: the text a file is to have, if its room is
   * shared with that device (the room already holds both sides' edits).
   */
  override(link: PeerLink): (path: string) => string | undefined {
    return (path) => {
      const room = this.host.liveRooms().find((r) => r.path === path);
      if (!room || !this.sharedWith(link, room)) return undefined;
      return this.host.roomText(room.name);
    };
  }

  /** Whether the room is shared with the device. */
  shares(link: PeerLink, path: string): boolean {
    return this.override(link)(path) !== undefined;
  }

  /**
   * Whether this device commits the room: it may change the document, and has
   * the lowest key of the devices with it open that may (0066).
   */
  commits(name: string): boolean {
    const room = this.host.roomView(name);
    if (!room) return true;
    if (!this.node.mayWrite(this.node.myKey, room.path)) return false;
    return this.peersIn(room).filter((l) => this.node.mayWrite(l.key, room.path)).every((l) => this.node.myKey < l.key);
  }

  close(): void {
    for (const stop of this.stops) stop();
  }
}
