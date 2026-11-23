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
//
// An edit passed on from another device says whose it is (`origin`, the device
// it was made on): taken only if both that device's person and the one passing
// it on may change the document, and passed on only where this device's would.
// Who edited is credited as the devices' records say, not as a message says;
// and a device sets where people are (awareness) only for those it brought.
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
  | { type: 'room'; op: 'update'; key: string; update: Bytes; by?: PresenceUser | null; /** The device the edit was made on, where it was passed on. */ origin?: string }
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

/** What the relay is told an edit came through (applyPeerUpdate's `peer`): the device passing it on, and the one it was made on. */
const through = (link: string, origin: string) => (origin === link ? link : `${link}>${origin}`);

/** An awareness update (y-protocols): each client's id, clock and state (JSON; null, gone). */
interface AwarenessEntry { id: number; clock: number; state: string }

/** An awareness update read (y-protocols' encoding: lib0 variable-length numbers and strings); null if it is not one. */
export function readAwareness(bytes: Uint8Array): AwarenessEntry[] | null {
  let at = 0;
  const uint = (): number => {
    let n = 0;
    for (let mult = 1; ; mult *= 128) {
      if (at >= bytes.length || mult > 2 ** 49) throw new Error('short');
      const b = bytes[at++]!;
      n += (b & 127) * mult;
      if (b < 128) return n;
    }
  };
  try {
    const out: AwarenessEntry[] = [];
    for (let count = uint(); count > 0; count--) {
      const id = uint();
      const clock = uint();
      const length = uint();
      if (at + length > bytes.length) return null;
      out.push({ id, clock, state: Buffer.from(bytes.subarray(at, at + length)).toString('utf8') });
      at += length;
    }
    return out;
  } catch {
    return null;
  }
}

/** An awareness update made of entries (readAwareness, back). */
export function writeAwareness(entries: AwarenessEntry[]): Uint8Array {
  const out: number[] = [];
  const uint = (n: number) => {
    for (; n >= 128; n = Math.floor(n / 128)) out.push((n % 128) | 128);
    out.push(n);
  };
  uint(entries.length);
  for (const e of entries) {
    uint(e.id);
    uint(e.clock);
    const text = Buffer.from(e.state, 'utf8');
    uint(text.length);
    out.push(...text);
  }
  return new Uint8Array(out);
}

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
  /** Whose clients' awareness each device brought, room by room: room name → client id → device. */
  private readonly clients = new Map<string, Map<number, string>>();
  /** Who each device is, as the records say, to credit with its edits (credit). */
  private readonly people = new Map<string, PresenceUser>();

  constructor(private readonly host: Host, private readonly node: PeerNode) {
    const relay = host.sessionRelay;
    this.stops.push(relay.onUpdate((name, update, source) => {
      const room = host.roomView(name);
      if (!room) return;
      const by = source.from === 'host' ? null : source.user;
      // Made here, or passed on from the device it was made on (through): passed on only where this device takes it.
      const [via, origin] = source.from === 'peer' ? source.peer.split('>') as [string, string?] : [null, undefined];
      const from = origin ?? via ?? this.node.myKey;
      if (via && !this.node.mayWrite(from, room.path)) return;
      for (const link of this.peersIn(room)) {
        if (link.key === via || link.key === from) continue;
        this.send(link, { type: 'room', op: 'update', key: room.key, update, by, ...(from !== this.node.myKey ? { origin: from } : {}) });
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

  /** Whether a device's person may read a document: one in a space, only its audience (0066); nothing of it is said to anyone else. */
  private reads(link: PeerLink, path: string): boolean {
    return this.node.mayReadSpace(link.key, this.host.spaceOf(path));
  }

  /** Connected devices of this workspace with the same room open, from the same seed. */
  private peersIn(room: RoomView): PeerLink[] {
    return [...this.node.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.node.ws.id && this.remote.get(l.key)?.get(room.key) === room.seed && this.reads(l, room.path));
  }

  private openMessage(room: RoomView): RoomMessage {
    return { type: 'room', op: 'open', key: room.key, seed: room.seed, sv: this.host.sessionRelay.stateVector(room.name) ?? EMPTY, people: this.host.roomContributors(room.name) };
  }

  /** The connected devices of this workspace with a document open, on any branch. */
  devicesWith(path: string): PeerLink[] {
    return [...this.node.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.node.ws.id && this.reads(l, path) && [...(this.remote.get(l.key)?.keys() ?? [])].some((key) => pathOf(key) === path));
  }

  /** A device connected: tell it which rooms are open here. */
  connected(link: PeerLink): void {
    if (link.hello?.workspace !== this.node.ws.id) return;
    void this.know(link.key, link.remote);
    for (const room of this.host.liveRooms()) if (this.reads(link, room.path)) this.send(link, this.openMessage(room));
  }

  /** Who a device is, as the records say (its person, and an address verified of them), for credit. */
  private async know(device: string, remote: string | null): Promise<PresenceUser> {
    const person = await this.node.identity.personOf(device).catch(() => null);
    const email = person ? (await this.node.identity.emailsOf(person.key).catch(() => []))[0] ?? '' : '';
    const user = { name: person?.name || remote || 'someone on another device', email, color: '' };
    this.people.set(device, user);
    return user;
  }

  /**
   * Whom to credit with edits made on a device: its person, as the records say;
   * not as the message says, which any device could make say anyone. The colour
   * a message says, which credits no one, is kept.
   */
  private credit(device: string, said?: PresenceUser | null): PresenceUser {
    const known = this.people.get(device);
    if (!known) void this.know(device, this.node.links.get(device)?.remote ?? null);
    const user = known ?? { name: this.node.links.get(device)?.remote ?? 'someone on another device', email: '', color: '' };
    return { ...user, color: typeof said?.color === 'string' ? said.color.slice(0, 32) : '' };
  }

  /**
   * Of an awareness update from a device, the entries it may set: for clients
   * it brought, or new ones; never for this device's own clients, or another
   * device's. Null if none.
   */
  private ownAwareness(link: PeerLink, name: string, update: Uint8Array): Uint8Array | null {
    const entries = readAwareness(update);
    if (!entries) return null;
    const owners = this.clients.get(name) ?? new Map<number, string>();
    this.clients.set(name, owners);
    const present = new Set((readAwareness(this.host.sessionRelay.awarenessState(name) ?? EMPTY) ?? []).map((e) => e.id));
    const mine = entries.filter((e) => {
      const owner = owners.get(e.id);
      return owner === link.key || (owner === undefined && !present.has(e.id));
    });
    for (const e of mine) {
      if (e.state === 'null') owners.delete(e.id);
      else owners.set(e.id, link.key);
    }
    return mine.length ? writeAwareness(mine) : null;
  }

  /** A device's clients are gone from a room (or every room): no longer its. */
  private forgetClients(device: string, name?: string): void {
    for (const [room, owners] of this.clients) {
      if (name !== undefined && room !== name) continue;
      for (const [id, owner] of owners) if (owner === device) owners.delete(id);
    }
  }

  /** A device went away: its people leave the rooms, and rooms it committed are committed here now. */
  disconnected(link: PeerLink): void {
    const had = this.remote.get(link.key);
    this.remote.delete(link.key);
    for (const [key, to] of this.handedTo) if (to === link.key) this.handedTo.delete(key);
    this.host.sessionRelay.removePeerAwareness(link.key);
    this.forgetClients(link.key);
    this.people.delete(link.key);
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
    for (const link of this.node.links.values()) if (link.accepted && link.hello?.workspace === this.node.ws.id && this.reads(link, room.path)) this.send(link, this.openMessage(room));
  }

  /** A room closed here (no one has it open). */
  closed(key: string): void {
    const path = pathOf(key);
    // Only to this workspace's devices (0071): a fork's are not told what is open here.
    for (const link of this.node.links.values()) if (link.accepted && link.hello?.workspace === this.node.ws.id && (path === null || this.reads(link, path))) this.send(link, { type: 'room', op: 'close', key });
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
    // A document in a space: nothing taken from, or given to, a device whose person may not read it (0066).
    const about = pathOf(m.key);
    if (about !== null && !this.reads(link, about)) return;
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
          // Who edited it there since its last commit: credited by whichever device commits (its person, as the records say).
          if (Array.isArray(m.people) && m.people.length && theyMay) this.host.addContributors(room.name, [this.credit(link.key)]);
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
          this.forgetClients(link.key, room.name);
          this.recommit([m.key]);
        }
        return;
      case 'update': {
        // Only from a device whose person may change the document (0066), made on one whose person may too: any other's
        // edits are not taken, whoever passes them on.
        const origin = typeof m.origin === 'string' && /^[0-9a-f]{64}$/.test(m.origin) ? m.origin : link.key;
        if (room && theirs.get(m.key) === room.seed && this.node.mayWrite(link.key, room.path) && this.node.mayWrite(origin, room.path)) {
          relay.applyPeerUpdate(room.name, bytesOf(m.update), through(link.key, origin), this.credit(origin, m.by));
        }
        return;
      }
      case 'awareness': {
        const own = room && theirs.get(m.key) === room.seed ? this.ownAwareness(link, room.name, bytesOf(m.update)) : null;
        if (room && own) relay.applyPeerAwareness(room.name, own, link.key);
        return;
      }
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
  override(link: PeerLink, branch: string, space: string | null): (path: string) => string | undefined {
    return (path) => {
      // The room of that file on that branch, in that history: the workspace's, or the space's (0071).
      const room = this.host.liveRooms().find((r) => r.path === path && r.branch === branch && this.host.spaceOf(r.path) === space);
      if (!room || !this.sharedWith(link, room)) return undefined;
      return this.host.roomText(room.name);
    };
  }

  /**
   * Whether this device commits the room: it may change the document, and has
   * the lowest key of the devices with it open that may (0066). A room nobody is
   * in here (kept warm) is not shared, whoever has the same room open elsewhere:
   * it hears nothing of theirs, so it is this device's to commit (unless it was
   * left to them: Host.leftToOthers), and takes changes from git as any room does.
   */
  commits(name: string): boolean {
    const room = this.host.roomView(name);
    if (!room) return true;
    if (!this.node.mayWrite(this.node.myKey, room.path)) return false;
    if (!this.host.sessionRelay.clients(name)) return true;
    return this.writersIn(room).every((l) => this.node.myKey < l.key);
  }

  /** Whether another device that may change the document has this room open, from the same seed: its room holds all of this one's edits. */
  heldElsewhere(name: string): boolean {
    const room = this.host.roomView(name);
    return !!room && this.writersIn(room).length > 0;
  }

  private writersIn(room: RoomView): PeerLink[] {
    return this.peersIn(room).filter((l) => this.node.mayWrite(l.key, room.path));
  }

  close(): void {
    for (const stop of this.stops) stop();
  }
}
