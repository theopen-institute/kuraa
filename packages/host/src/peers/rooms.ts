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
// One device commits a shared room (Host.commitNow asks `commits`): the
// upstream device if it is in the room, else the one with the lowest key. The
// others write the file but leave committing to it; its commit reaches them
// within moments, and their files already match.
import type { PresenceUser } from '@kuraa/session/server';
import type { Host, RoomView } from '../host.js';
import type { PeerLink } from './link.js';
import type { PeerNode } from './node.js';

type RoomMessage =
  | { type: 'room'; op: 'open'; key: string; seed: string; sv: string; people?: PresenceUser[] }
  | { type: 'room'; op: 'close'; key: string }
  | { type: 'room'; op: 'sync'; key: string; seed: string; sv: string; update: string; people?: PresenceUser[] }
  | { type: 'room'; op: 'update'; key: string; update: string; by?: PresenceUser | null }
  | { type: 'room'; op: 'awareness'; key: string; update: string }
  | { type: 'room'; op: 'want'; key: string }
  | { type: 'room'; op: 'state'; key: string; seed: string; state: string; base?: string | null };

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const bytes = (s: unknown) => new Uint8Array(Buffer.from(typeof s === 'string' ? s : '', 'base64'));

export class Rooms {
  /** What each device has open: device key → room key → seed. */
  private readonly remote = new Map<string, Map<string, string>>();
  private readonly stops: (() => void)[] = [];
  private upstream: string | null = null;

  constructor(private readonly host: Host, private readonly node: PeerNode) {
    const relay = host.sessionRelay;
    this.stops.push(relay.onUpdate((name, update, source) => {
      const room = host.roomView(name);
      if (!room) return;
      const by = source.from === 'host' ? null : source.user;
      for (const link of this.peersIn(room)) {
        if (source.from === 'peer' && source.peer === link.key) continue;
        this.send(link, { type: 'room', op: 'update', key: room.key, update: b64(update), by });
      }
    }));
    this.stops.push(relay.onAwareness((name, update, peer) => {
      const room = host.roomView(name);
      if (!room) return;
      for (const link of this.peersIn(room)) if (link.key !== peer) this.send(link, { type: 'room', op: 'awareness', key: room.key, update: b64(update) });
    }));
  }

  private send(link: PeerLink, m: RoomMessage): void {
    link.send(m as never);
  }

  /** Connected devices of this workspace with the same room open, from the same seed. */
  private peersIn(room: RoomView): PeerLink[] {
    return [...this.node.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.node.ws.id && this.remote.get(l.key)?.get(room.key) === room.seed);
  }

  private openMessage(room: RoomView): RoomMessage {
    return { type: 'room', op: 'open', key: room.key, seed: room.seed, sv: b64(this.host.sessionRelay.stateVector(room.name) ?? new Uint8Array()), people: this.host.roomContributors(room.name) };
  }

  async refreshUpstream(): Promise<void> {
    this.upstream = await this.node.upstreamKey();
  }

  /** A device connected: tell it which rooms are open here. */
  connected(link: PeerLink): void {
    void this.refreshUpstream();
    if (link.hello?.workspace !== this.node.ws.id) return;
    for (const room of this.host.liveRooms()) this.send(link, this.openMessage(room));
  }

  /** A device went away: its people leave the rooms, and rooms it committed are committed here now. */
  disconnected(link: PeerLink): void {
    const had = this.remote.get(link.key);
    this.remote.delete(link.key);
    this.host.sessionRelay.removePeerAwareness(link.key);
    if (had) this.recommit(had.keys());
  }

  private recommit(keys: Iterable<string>): void {
    for (const key of keys) {
      const room = this.host.liveRooms().find((r) => r.key === key);
      if (room) this.host.commitSoon(room.name);
    }
  }

  /** A room opened here: tell the other devices (once the relay holds it). */
  opened(name: string, tries = 0): void {
    const room = this.host.roomView(name);
    if (!room) return;
    if (!this.host.sessionRelay.stateVector(name)) {
      if (tries < 40) setTimeout(() => this.opened(name, tries + 1), 25);
      return;
    }
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
    const room = this.host.liveRooms().find((r) => r.key === m.key);
    const theirs = this.remote.get(link.key) ?? new Map<string, string>();
    this.remote.set(link.key, theirs);
    switch (m.op) {
      case 'open':
      case 'sync': {
        theirs.set(m.key, String(m.seed));
        if (!room) return;
        if (m.seed === room.seed) {
          // Who edited it there since its last commit: credited by whichever device commits.
          if (Array.isArray(m.people)) this.host.addContributors(room.name, m.people);
          if (m.op === 'sync') relay.applyPeerUpdate(room.name, bytes(m.update), link.key, null);
          const update = relay.diff(room.name, bytes(m.sv));
          if (m.op === 'open') this.send(link, { type: 'room', op: 'sync', key: room.key, seed: room.seed, sv: b64(relay.stateVector(room.name) ?? new Uint8Array()), update: b64(update ?? new Uint8Array()), people: this.host.roomContributors(room.name) });
          else if (update) this.send(link, { type: 'room', op: 'update', key: room.key, update: b64(update) });
          const people = relay.awarenessState(room.name);
          if (people) this.send(link, { type: 'room', op: 'awareness', key: room.key, update: b64(people) });
        } else if (String(m.seed) < room.seed) {
          // Theirs is the room to share: take it, with what this one has brought in.
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
        if (room && theirs.get(m.key) === room.seed) relay.applyPeerUpdate(room.name, bytes(m.update), link.key, m.by ?? null);
        return;
      case 'awareness':
        if (room && theirs.get(m.key) === room.seed) relay.applyPeerAwareness(room.name, bytes(m.update), link.key);
        return;
      case 'want': {
        const state = room && relay.state(room.name);
        if (room && state) this.send(link, { type: 'room', op: 'state', key: room.key, seed: room.seed, state: b64(state), base: this.host.roomBase(room.name) });
        return;
      }
      case 'state': {
        if (!room || !(String(m.seed) < room.seed)) return;
        const base = typeof m.base === 'string' && /^[0-9a-f]{40,64}$/.test(m.base) ? m.base : null;
        void (async () => {
          // Their room's starting commit is needed to merge from where the two meet: fetch it if it is not here yet.
          if (base && (await this.host.git.run(['cat-file', '-e', `${base}^{commit}`], { allowFail: true })).code !== 0) await this.node.fetch(link.remote!);
          await this.host.adoptRoom(room.name, String(m.seed), bytes(m.state), link.remote ?? 'another device', base);
        })().catch((e: Error) => this.host.log(`peers: could not take ${link.remote}'s room for ${room.path}: ${e.message}`));
        return;
      }
    }
  }

  /** Rooms open both here and on the device, from different seeds: one will take the other's. */
  private unsettled(link: PeerLink): boolean {
    const theirs = this.remote.get(link.key);
    return !!theirs && this.host.liveRooms().some((r) => theirs.has(r.key) && theirs.get(r.key) !== r.seed);
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
      if (!room || this.remote.get(link.key)?.get(room.key) !== room.seed) return undefined;
      return this.host.roomText(room.name);
    };
  }

  /** Whether the room is shared with the device. */
  shares(link: PeerLink, path: string): boolean {
    return this.override(link)(path) !== undefined;
  }

  /** Whether this device commits the room: the upstream if it is in the room, else the lowest key among those in it. */
  commits(name: string): boolean {
    const room = this.host.roomView(name);
    if (!room) return true;
    const keys = [this.node.myKey, ...this.peersIn(room).map((l) => l.key)];
    if (keys.length === 1) return true;
    if (this.upstream && keys.includes(this.upstream)) return this.upstream === this.node.myKey;
    return keys.sort()[0] === this.node.myKey;
  }

  close(): void {
    for (const stop of this.stops) stop();
  }
}
