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
// A device takes another's live edits to a document only if it would accept
// that device's commits to it (accept.ts): otherwise the room would be a way
// round its rules. It sends its own edits to every device with the room open;
// each takes them or not by its own rules. So devices that accept each other
// hold the same room, and the lowest key among them commits it (Host.commitNow
// asks `commits`); the others write the file but leave committing to it, and its
// commit reaches them within moments. A device none of the others there accepts
// commits only what was edited on it. Every device knows the others' rules
// (published as records), so they agree without any setting they share.
import type { PresenceUser } from '@kuraa/session/server';
import type { Host, RoomView } from '../host.js';
import type { PeerLink } from './link.js';
import type { PeerNode } from './node.js';
import { EVERYONE, acceptsPath, commitsRoom, type AcceptRules, type AcceptRule } from './accept.js';

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
   * What this device knows of everyone's rules (accept.ts) and who each device is
   * (its key, and its person's): read again when a device connects, records come
   * in, or the rules change (refresh), so room messages are judged at once.
   */
  private mine: AcceptRules = EVERYONE;
  private readonly theirs = new Map<string, AcceptRule[] | undefined>();
  private readonly who = new Map<string, string[]>();
  /**
   * Rooms this device has sent to another to take (room key → that device's
   * key), until it opens them again from this one's seed. Meanwhile the room is
   * as good as shared with it: its work must not also come into the room through git.
   */
  private readonly handedTo = new Map<string, string>();

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

  async refresh(): Promise<void> {
    const id = this.node.identity;
    this.mine = await id.rules();
    this.who.set(this.node.myKey, await id.identitiesOf(this.node.myKey));
    for (const link of this.node.links.values()) {
      if (!link.accepted) continue;
      this.theirs.set(link.key, (await id.rulesOf(link.key))?.rules);
      this.who.set(link.key, await id.identitiesOf(link.key));
    }
  }

  private whoIs(key: string): string[] {
    return this.who.get(key) ?? [key];
  }

  /** Whether this device takes the device's edits to the room's document. */
  private takesFrom(link: PeerLink, room: RoomView): boolean {
    return acceptsPath(this.mine.rules, this.whoIs(link.key), room.branch, room.path);
  }

  /** Whether the device takes this one's edits to the room's document, as its rules say. */
  private takenBy(link: PeerLink, room: RoomView): boolean {
    return acceptsPath(this.theirs.get(link.key), this.whoIs(this.node.myKey), room.branch, room.path);
  }

  /** A device connected: tell it which rooms are open here. */
  connected(link: PeerLink): void {
    void this.refresh().catch((e: Error) => this.host.log(`peers: rules not read: ${e.message}`));
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
        theirs.set(m.key, String(m.seed));
        if (!room) return;
        if (m.seed === room.seed) {
          // A room handed over is theirs now too.
          if (this.handedTo.get(room.key) === link.key) this.handedTo.delete(room.key);
          // Who edited it there since its last commit: credited by whichever device commits.
          const takes = this.takesFrom(link, room);
          if (takes && Array.isArray(m.people)) this.host.addContributors(room.name, m.people);
          if (takes && m.op === 'sync') relay.applyPeerUpdate(room.name, bytesOf(m.update), link.key, null);
          const update = relay.diff(room.name, bytesOf(m.sv));
          if (m.op === 'open') this.send(link, { type: 'room', op: 'sync', key: room.key, seed: room.seed, sv: relay.stateVector(room.name) ?? EMPTY, update: update ?? EMPTY, people: this.host.roomContributors(room.name) });
          else if (update) this.send(link, { type: 'room', op: 'update', key: room.key, update });
          const people = relay.awarenessState(room.name);
          if (people) this.send(link, { type: 'room', op: 'awareness', key: room.key, update: people });
        } else if (String(m.seed) < room.seed) {
          // Theirs is the room to share: take it, with what this one has brought in (if this one takes their edits at all).
          if (this.takesFrom(link, room)) this.send(link, { type: 'room', op: 'want', key: room.key });
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
        if (room && theirs.get(m.key) === room.seed && this.takesFrom(link, room)) relay.applyPeerUpdate(room.name, bytesOf(m.update), link.key, m.by ?? null);
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
        if (!room || !(String(m.seed) < room.seed) || !this.takesFrom(link, room)) return;
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
   * take the other's (the one with the higher seed, if it takes the other's
   * edits), or handed to it and not yet taken.
   */
  private unsettled(link: PeerLink): boolean {
    if ([...this.handedTo.values()].includes(link.key)) return true;
    const theirs = this.remote.get(link.key);
    if (!theirs) return false;
    return this.host.liveRooms().some((r) => {
      const seed = theirs.get(r.key);
      if (seed === undefined || seed === r.seed) return false;
      return seed < r.seed ? this.takesFrom(link, r) : this.takenBy(link, r);
    });
  }

  /** Whether the room here holds the device's edits too: shared with it (or handed to it to take), and this device takes its edits. */
  private sharedWith(link: PeerLink, room: RoomView): boolean {
    return (this.remote.get(link.key)?.get(room.key) === room.seed || this.handedTo.get(room.key) === link.key) && this.takesFrom(link, room);
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

  /** Whether this device commits the room (accept.ts, commitsRoom). */
  commits(name: string): boolean {
    const room = this.host.roomView(name);
    if (!room) return true;
    const peers = this.peersIn(room);
    if (!peers.length) return true;
    const me = { key: this.node.myKey, who: this.whoIs(this.node.myKey), rules: this.mine.rules };
    const others = peers.map((l) => ({ key: l.key, who: this.whoIs(l.key), rules: this.theirs.get(l.key) }));
    return commitsRoom(me, others, room.branch, room.path, this.host.localEditsIn(name));
  }

  close(): void {
    for (const stop of this.stops) stop();
  }
}
