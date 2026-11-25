// Rooms across devices (0077): when people on two devices have the same file
// open, their hosts are in one session of it, so everyone edits one document live.
//
// A session is one Yjs document on one base: started by the first device to
// open the file (from its file), joined by others (from the state of a device
// in it), and over when the last device in it leaves. Each device tells the
// others which sessions it is in: a room's key (branch, path and type version)
// and the session's id. Devices in the same session are kept in step with Yjs
// updates both ways, and who is in it (names, cursors).
//
// One device leads a session: of the devices in it that may change the
// document, the one with the lowest key. Every device works this out the same
// from who says it is in the session; there is no election. Only the leader
// writes the room's text to the file, commits it, and brings changes from git
// into it (Host.leads). When it leaves, it says on which commit (its last) the
// next is to build, and the next carries on with the same document. One with a
// lower key that joins takes over once the one leading has made its last commit.
//
// Two sessions of one file never combine: two Yjs histories of one text would
// show it twice. Devices that were apart (a network split, or two that opened
// the file at once) meet in git: each side's leader commits, git merges, and the
// devices of the session whose leader has the higher key, once the other session
// holds their last commit and they have nothing since, move to the other
// session (Host.switchRoom; the app carries its people's edits not yet sent). A
// device whose leader goes without a word (the network) waits a while for it
// (rejoinMs): no one leads meanwhile. Then the one with the lowest key left
// goes on in a session of its own (a fork: the same document, a new id), which
// the others with it follow, so the two sides, when they meet, meet in git.
//
// A device takes live edits from the devices whose person may change the
// document (0066: the workspace's write rules; everyone, where there are none),
// and sends its own to every device in the session, so all can read along. An
// edit passed on from another device says whose it is (`origin`, the device it
// was made on): taken only if both that device's person and the one passing it
// on may change the document, and passed on only where this device's would.
// Who edited is credited as the devices' records say, not as a message says;
// and a device sets where people are (awareness) only for those it brought.
import { randomBytes } from 'node:crypto';
import { covers, type PresenceUser } from '@kuraa/session/server';
import type { Host, RoomView } from '../host.js';
import { isAncestor } from '../merging.js';
import type { PeerLink } from './link.js';
import type { PeerNode } from './node.js';

/** Bytes: as they are on the rooms channel, base64 from a device that has only the control channel (link.ts). */
type Bytes = Uint8Array | string;

type RoomMessage =
  /** In this session (and, `was`: gone on from that one, its leader gone). */
  | { type: 'room'; op: 'open'; key: string; session: string; sv: Bytes; base?: string | null; people?: PresenceUser[]; was?: string }
  | { type: 'room'; op: 'sync'; key: string; session: string; sv: Bytes; update: Bytes; base?: string | null; people?: PresenceUser[] }
  | { type: 'room'; op: 'update'; key: string; update: Bytes; by?: PresenceUser | null; /** The device the edit was made on, where it was passed on. */ origin?: string }
  | { type: 'room'; op: 'awareness'; key: string; update: Bytes }
  /** Left its session, having committed what it was to: `base`, for the next to build on. */
  | { type: 'room'; op: 'close'; key: string; base?: string | null }
  /** The session's text is held in `commit` (exactly as it was at `sv`, where said); `handover`: its last as leader. */
  | { type: 'room'; op: 'base'; key: string; session: string; commit: string; sv?: Bytes; handover?: boolean }
  | { type: 'room'; op: 'want'; key: string; id: string }
  | { type: 'room'; op: 'state'; key: string; id: string; session?: string | null; state?: Bytes; base?: string | null }
  /** A named version of the session's text, asked of its leader. */
  | { type: 'room'; op: 'version'; key: string; id: string; message: string }
  | { type: 'room'; op: 'versioned'; key: string; id: string; commit: string | null };

/** What a device has said of a room it has open. */
interface Said {
  session: string;
  /** The newest commit it said the session's text is held in. */
  base: string | null;
  /** Its last commit as leader, and how far the session's edits went in it. */
  committed: { commit: string; sv: Uint8Array } | null;
}

/** This device's view of a room it is in, beyond the host's. */
interface Local {
  /** Whether the host was last told it may lead it. */
  told: boolean;
  /** The leader as last worked out. */
  leader: string | null;
  /** The leader, gone without a word: waited for (rejoinMs). */
  lost: { key: string; timer: NodeJS.Timeout } | null;
  /** The leader gone, and another to lead it now: its session (a fork) is waited for. */
  orphan: boolean;
  /** Joined with the lowest key: the one leading it, whose last commit is waited for. */
  awaiting: { key: string; timer: NodeJS.Timeout } | null;
  /** Devices that went on from this session in one of their own (a fork): device → from and to. */
  forks: Map<string, { from: string; to: string }>;
}

/** Sorts after every key: a session with no one who may change it is never the one kept. */
const NO_ONE = '~';
/** How long a device waits for another's answer (a session's state, a named version). */
const ASK_MS = 5000;
/** How long one joining with the lowest key waits for the one leading to hand over. */
const HANDOVER_MS = 10_000;
/** How often devices of a session giving way to another look again whether they may move. */
const MEET_MS = 250;

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
  /** What each device has open: device key → room key → what it said. */
  private readonly remote = new Map<string, Map<string, Said>>();
  /** This device's view of the rooms it is in, by room key. */
  private readonly local = new Map<string, Local>();
  private readonly stops: (() => void)[] = [];
  /** Another device opened a document here not open there before (for run outputs under way: outputs.ts). */
  onOpened: ((link: PeerLink, path: string) => void) | null = null;
  /** Whose clients' awareness each device brought, room by room: room name → client id → device. */
  private readonly clients = new Map<string, Map<number, string>>();
  /** Who each device is, as the records say, to credit with its edits (credit). */
  private readonly people = new Map<string, PresenceUser>();
  /** Questions asked of other devices (a session's state, a named version), by id. */
  private readonly asked = new Map<string, { device: string; answer: (m: RoomMessage | null) => void }>();
  /** Rooms whose session gives way to another: looked at again until it has (meet). */
  private readonly meetings = new Map<string, NodeJS.Timeout>();
  private readonly meeting = new Set<string>();
  private readonly meetAgain = new Set<string>();
  /** When a room giving way was last written and committed for it (meetOnce). */
  private readonly settled = new Map<string, number>();
  private closed = false;

  constructor(private readonly host: Host, private readonly node: PeerNode) {
    const relay = host.sessionRelay;
    this.stops.push(relay.onUpdate((name, update, source) => {
      const room = host.roomView(name);
      if (!room?.session) return;
      const by = source.from === 'host' ? null : source.user;
      // Made here, or passed on from the device it was made on (through): passed on only where this device takes it.
      const [via, origin] = source.from === 'peer' ? source.peer.split('>') as [string, string?] : [null, undefined];
      const from = origin ?? via ?? this.node.myKey;
      // (Where features keep state in rooms, what was taken from another device was judged as it came: takes.)
      if (via && !this.node.mayWrite(from, room.path) && !this.host.features.keepsRoomState()) return;
      for (const link of this.peersIn(room)) {
        if (link.key === via || link.key === from) continue;
        this.send(link, { type: 'room', op: 'update', key: room.key, update, by, ...(from !== this.node.myKey ? { origin: from } : {}) });
      }
    }));
    this.stops.push(relay.onAwareness((name, update, peer) => {
      const room = host.roomView(name);
      if (!room?.session) return;
      for (const link of this.peersIn(room)) if (link.key !== peer) this.send(link, { type: 'room', op: 'awareness', key: room.key, update });
    }));
  }

  private send(link: PeerLink, m: RoomMessage): void {
    link.sendRoom(m);
  }

  /**
   * Whether a change to a room is taken from a device (`origin`: the device an
   * edit was made on; null for a sync, which may hold anyone's): its document
   * only from those whose people may change it (0066); a person's feature maps
   * (0082) only as their own, an edit made on one of their devices, or a sync
   * from someone who may change the document; and this host's own person's maps
   * only from their own devices, whoever passes the change on, since this host
   * writes them to that person's file, signed as theirs. Where no feature keeps
   * state in rooms here, as before: from those who may change the document.
   */
  private takes(room: RoomView, update: Uint8Array, link: string, origin: string | null): boolean {
    const docOk = this.node.mayWrite(link, room.path) && (origin === null || this.node.mayWrite(origin, room.path));
    if (!this.host.features.keepsRoomState()) return docOk;
    const w = this.host.sessionRelay.whatChanged(room.name, update);
    if (!w) return docOk;
    if ((w.doc || w.other) && !docOk) return false;
    const me = this.host.features.person();
    const maker = this.node.personOfDevice(origin ?? link);
    for (const p of w.people) {
      if (origin !== null && maker !== p) return false;
      if (origin === null && !docOk && maker !== p) return false;
      if (p === me && maker !== me) return false;
    }
    return true;
  }

  /** Whether a device's person may read a document: one in a space, only its audience (0066); nothing of it is said to anyone else. */
  private reads(link: PeerLink, path: string): boolean {
    return this.node.mayReadSpace(link.key, this.host.spaceOf(path));
  }

  /** Connected devices of this workspace that may read a document. */
  private linksFor(path: string | null): PeerLink[] {
    return [...this.node.links.values()].filter((l) => l.accepted && !l.closed && l.hello?.workspace === this.node.ws.id && (path === null || this.reads(l, path)));
  }

  private said(device: string, key: string): Said | undefined {
    return this.remote.get(device)?.get(key);
  }

  /** Connected devices in a room's session. */
  private peersIn(room: RoomView): PeerLink[] {
    return this.linksFor(room.path).filter((l) => room.session !== null && this.said(l.key, room.key)?.session === room.session);
  }

  /** The devices that may change the document in a room's session, this one too if it may: their keys. */
  private writers(room: RoomView): string[] {
    const out = this.peersIn(room).filter((l) => this.node.mayWrite(l.key, room.path)).map((l) => l.key);
    if (this.node.mayWrite(this.node.myKey, room.path)) out.push(this.node.myKey);
    return out;
  }

  /** Who leads a room's session: the lowest key of those in it that may change the document. */
  private leaderOf(room: RoomView): string | null {
    const keys = this.writers(room);
    return keys.length ? keys.reduce((a, b) => (b < a ? b : a)) : null;
  }

  /**
   * Whether this device may lead a room's session now: it has the lowest key of
   * those in it that may change it, and waits neither for a leader gone without
   * a word nor for the one leading to hand over. A room in no session: its own.
   */
  mayLead(name: string): boolean {
    const room = this.host.roomView(name);
    if (!room?.session) return true;
    const l = this.local.get(room.key);
    if (l && (l.lost || l.orphan || l.awaiting)) return false;
    return this.leaderOf(room) === this.node.myKey;
  }

  private localOf(key: string): Local {
    let l = this.local.get(key);
    if (!l) {
      l = { told: false, leader: null, lost: null, orphan: false, awaiting: null, forks: new Map() };
      this.local.set(key, l);
    }
    return l;
  }

  private forget(key: string): void {
    const l = this.local.get(key);
    if (l?.lost) clearTimeout(l.lost.timer);
    if (l?.awaiting) clearTimeout(l.awaiting.timer);
    this.local.delete(key);
    this.stopMeeting(key);
  }

  /** Work out again who leads a room here: the host is told when whether it may lead changes; and whether to meet another session. */
  private review(key: string): void {
    if (this.closed) return;
    const room = this.host.liveRoom(key);
    if (!room) {
      if (this.local.has(key)) this.forget(key);
      return;
    }
    const l = this.localOf(key);
    l.leader = this.leaderOf(room);
    const may = this.mayLead(room.name);
    if (may !== l.told) {
      l.told = may;
      this.host.leadingChanged(room.name, may);
    }
    void this.meet(key);
  }

  private openMessage(room: RoomView, was?: string): RoomMessage {
    const relay = this.host.sessionRelay;
    return { type: 'room', op: 'open', key: room.key, session: room.session!, sv: relay.stateVector(room.name) ?? EMPTY, base: room.base, people: this.host.roomContributors(room.name), ...(was ? { was } : {}) };
  }

  /** The connected devices of this workspace with a document open, on any branch. */
  devicesWith(path: string): PeerLink[] {
    return this.linksFor(path).filter((l) => [...(this.remote.get(l.key)?.keys() ?? [])].some((key) => pathOf(key) === path));
  }

  /** A device connected: tell it which sessions this one is in. */
  connected(link: PeerLink): void {
    if (link.hello?.workspace !== this.node.ws.id) return;
    void this.know(link.key, link.remote);
    for (const room of this.host.liveRooms()) if (this.reads(link, room.path)) this.send(link, this.openMessage(room));
  }

  /** Who a device is, as the records say (its person), for credit. */
  private async know(device: string, remote: string | null): Promise<PresenceUser> {
    const person = await this.node.identity.personOf(device).catch(() => null);
    const user = { name: person?.name || remote || 'someone on another device', email: '', color: '' };
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

  /**
   * A device went away. Its people leave the rooms. If it led a session this
   * one is in, it went without a word: perhaps only the network, and it leads
   * on where it is. It is waited for (rejoinMs), no one here leading meanwhile;
   * back in time, the session goes on as one. Else this side goes on without it (goOn).
   */
  disconnected(link: PeerLink): void {
    const had = this.remote.get(link.key);
    this.remote.delete(link.key);
    this.host.sessionRelay.removePeerAwareness(link.key);
    this.forgetClients(link.key);
    this.people.delete(link.key);
    for (const [id, q] of this.asked) {
      if (q.device !== link.key) continue;
      this.asked.delete(id);
      q.answer(null);
    }
    for (const [key, said] of had ?? []) {
      const room = this.host.liveRoom(key);
      const l = this.local.get(key);
      if (room && l && said.session === room.session && (l.leader === link.key || l.awaiting?.key === link.key)) {
        if (l.awaiting) clearTimeout(l.awaiting.timer);
        l.awaiting = null;
        if (!l.lost) l.lost = { key: link.key, timer: setTimeout(() => this.rejoinTimedOut(key), this.host.timings.rejoinMs) };
      }
      this.review(key);
    }
  }

  private rejoinTimedOut(key: string): void {
    const l = this.local.get(key);
    const room = this.host.liveRoom(key);
    if (!l?.lost || !room) return;
    const gone = l.lost.key;
    l.lost = null;
    // Back, in the same session: it goes on as one (no one here led it meanwhile, so it holds nothing made twice).
    if (this.peersIn(room).some((p) => p.key === gone)) return this.review(key);
    this.log(`${room.path}: the device leading it is gone; going on without it`);
    l.orphan = true;
    this.goOn(key);
  }

  /**
   * Its leader gone: of those still in the session, and those that went on
   * from it in one of their own, the one with the lowest key that may change it
   * leads now. This device, if that is it: in a session of its own (a fork),
   * which it tells the others; else the session that one went on in, or (it has
   * not yet) wait for it.
   */
  private goOn(key: string): void {
    const room = this.host.liveRoom(key);
    const l = this.local.get(key);
    if (!room?.session || !l?.orphan) return;
    const candidates = new Map<string, string | null>(this.writers(room).map((k) => [k, null]));
    for (const [by, f] of l.forks) {
      if (f.from === room.session && this.node.mayWrite(by, room.path) && this.linksFor(room.path).some((x) => x.key === by)) candidates.set(by, f.to);
    }
    if (!candidates.size) return;
    const next = [...candidates.keys()].reduce((a, b) => (b < a ? b : a));
    const to = candidates.get(next);
    if (next === this.node.myKey) {
      const fork = randomBytes(8).toString('hex');
      this.follow(room, fork, room.session);
      this.log(`${room.path}: going on in a session of this device's own`);
    } else if (to) {
      this.follow(room, to);
    } else return;
    this.review(key);
  }

  /** Go on in another session with the same document (a fork, made here, `was` the one before; or one another made): told to every device. */
  private follow(room: RoomView, session: string, was?: string): void {
    const l = this.localOf(room.key);
    l.orphan = false;
    l.forks.clear();
    this.host.setSession(room.name, session);
    const now = this.host.roomView(room.name)!;
    for (const link of this.linksFor(now.path)) this.send(link, this.openMessage(now, was));
  }

  /** A room's document opened here: the other devices are told it is in its session. */
  opened(name: string): void {
    const room = this.host.roomView(name);
    if (!room?.session) return;
    const l = this.localOf(room.key);
    l.told = room.leading;
    // Joined, with the lowest key in it: it leads once the one leading has made its last commit and said so (handedOver).
    const others = this.writers(room).filter((k) => k !== this.node.myKey).sort();
    if (!room.leading && this.node.mayWrite(this.node.myKey, room.path) && others.length && others[0]! > this.node.myKey && !l.awaiting) {
      l.awaiting = {
        key: others[0]!,
        timer: setTimeout(() => {
          l.awaiting = null;
          this.review(room.key);
        }, HANDOVER_MS),
      };
    }
    for (const link of this.linksFor(room.path)) this.send(link, this.openMessage(room));
    this.review(room.key);
  }

  /** This device left a room's session (its last commit `base`, if it led it): the others are told. */
  left(key: string, base: string | null): void {
    this.forget(key);
    // Only to this workspace's devices (0071): a fork's are not told what is open here.
    for (const link of this.linksFor(pathOf(key))) this.send(link, { type: 'room', op: 'close', key, base });
  }

  /** The room's text was committed here, or a commit brought into it: the others are told. */
  committed(name: string, handover = false): void {
    const room = this.host.roomView(name);
    if (!room?.session) return;
    void (async () => {
      const exact = await this.host.committedOf(name);
      const commit = exact?.commit ?? room.base;
      if (!commit) return;
      const now = this.host.roomView(name);
      if (now?.session !== room.session) return;
      for (const link of this.linksFor(room.path)) this.send(link, { type: 'room', op: 'base', key: room.key, session: room.session!, commit, ...(exact ? { sv: exact.sv } : {}), ...(handover ? { handover } : {}) });
      void this.meet(room.key);
    })().catch((e: Error) => this.log(`could not say ${room.path} was committed: ${e.message}`));
  }

  /** This device led a session and no longer does (a lower key came into it): its last commit, said. */
  handedOver(name: string): void {
    this.committed(name, true);
    const room = this.host.roomView(name);
    if (room) this.review(room.key);
  }

  /**
   * Join the session another device has of a file, if any: its state, from a
   * device in it that may change it (the one leading it, if it is connected).
   * Of two sessions (devices meeting), the one that is kept: whose leader has
   * the lower key. Null if none, or no answer.
   */
  async join(key: string): Promise<{ session: string; state: Uint8Array; base: string | null } | null> {
    const sessions = this.sessionsOf(key, null);
    let kept: { session: string; leader: string; links: PeerLink[] } | null = null;
    for (const s of sessions) if (!kept || s.leader < kept.leader) kept = s;
    if (!kept) return null;
    const source = kept.links.find((l) => l.key === kept.leader) ?? kept.links.find((l) => this.node.mayWrite(l.key, pathOf(key) ?? '')) ?? null;
    if (!source) return null;
    const m = await this.ask(source, { type: 'room', op: 'want', key, id: '' });
    if (!m || m.op !== 'state' || typeof m.session !== 'string' || !m.state) return null;
    const state = bytesOf(m.state);
    return state.length ? { session: m.session, state, base: typeof m.base === 'string' && /^[0-9a-f]{40,64}$/.test(m.base) ? m.base : null } : null;
  }

  /** The sessions connected devices say they are in for a room key (but `except`), each with its leader and the devices in it. */
  private sessionsOf(key: string, except: string | null): { session: string; leader: string; links: PeerLink[] }[] {
    const path = pathOf(key);
    if (path === null) return [];
    const by = new Map<string, PeerLink[]>();
    for (const l of this.linksFor(path)) {
      const s = this.said(l.key, key)?.session;
      if (s && s !== except) by.set(s, [...(by.get(s) ?? []), l]);
    }
    const out: { session: string; leader: string; links: PeerLink[] }[] = [];
    for (const [session, links] of by) {
      const writers = links.filter((l) => this.node.mayWrite(l.key, path)).map((l) => l.key);
      if (writers.length) out.push({ session, leader: writers.reduce((a, b) => (b < a ? b : a)), links });
    }
    return out;
  }

  /** Ask a device something, and wait (a while) for its answer. */
  private ask(link: PeerLink, m: Extract<RoomMessage, { op: 'want' | 'version' }>): Promise<RoomMessage | null> {
    const id = randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.asked.delete(id);
        resolve(null);
      }, ASK_MS);
      this.asked.set(id, {
        device: link.key,
        answer: (a) => {
          clearTimeout(timer);
          resolve(a);
        },
      });
      this.send(link, { ...m, id });
    });
  }

  /** A named version of a room another device leads: made there (Host.commitRoom). Its commit, or null. */
  async askVersion(name: string, message: string): Promise<string | null> {
    const room = this.host.roomView(name);
    const leader = room ? this.local.get(room.key)?.leader : null;
    const link = leader ? this.node.links.get(leader) : undefined;
    if (!room || !link) return null;
    const m = await this.ask(link, { type: 'room', op: 'version', key: room.key, id: '', message: message.slice(0, 2000) });
    return m?.op === 'versioned' && typeof m.commit === 'string' ? m.commit : null;
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
    const theirs = this.remote.get(link.key) ?? new Map<string, Said>();
    this.remote.set(link.key, theirs);
    const commitId = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v) ? v : null);
    switch (m.op) {
      case 'open':
      case 'sync': {
        if (typeof m.session !== 'string' || !m.session) return;
        const path = pathOf(m.key);
        const fresh = path !== null && ![...theirs.keys()].some((k) => pathOf(k) === path);
        const before = theirs.get(m.key);
        const same = before?.session === m.session;
        theirs.set(m.key, { session: m.session, base: commitId(m.base) ?? (same ? before.base : null), committed: same ? before.committed : null });
        if (fresh) this.onOpened?.(link, path);
        if (!room) return;
        const l = this.localOf(m.key);
        // Gone on from this session in one of its own, its leader gone: followed, if it is the one to lead now (goOn).
        if (m.op === 'open' && typeof m.was === 'string' && m.was === room.session && m.session !== room.session) {
          l.forks.set(link.key, { from: m.was, to: m.session });
          if (l.orphan) this.goOn(m.key);
        }
        const now = this.host.liveRoom(m.key)!;
        if (m.session === now.session) {
          // Back within rejoinMs: one session still.
          if (l.lost?.key === link.key) {
            clearTimeout(l.lost.timer);
            l.lost = null;
          }
          const theyMay = this.node.mayWrite(link.key, now.path);
          // Who edited it there since its last commit: credited by whichever device commits (its person, as the records say).
          if (Array.isArray(m.people) && m.people.length && theyMay) this.host.addContributors(now.name, [this.credit(link.key)]);
          if (m.op === 'sync' && this.takes(now, bytesOf(m.update), link.key, null)) relay.applyPeerUpdate(now.name, bytesOf(m.update), link.key, null);
          const update = relay.diff(now.name, bytesOf(m.sv));
          if (m.op === 'open') this.send(link, { type: 'room', op: 'sync', key: now.key, session: now.session!, sv: relay.stateVector(now.name) ?? EMPTY, update: update ?? EMPTY, base: now.base, people: this.host.roomContributors(now.name) });
          else if (update) this.send(link, { type: 'room', op: 'update', key: now.key, update });
          const people = relay.awarenessState(now.name);
          if (people) this.send(link, { type: 'room', op: 'awareness', key: now.key, update: people });
        }
        this.review(m.key);
        return;
      }
      case 'close': {
        const said = theirs.get(m.key);
        theirs.delete(m.key);
        if (room && said?.session === room.session) {
          relay.removePeerAwareness(link.key, room.name);
          this.forgetClients(link.key, room.name);
          const l = this.localOf(m.key);
          // It led the session: the next to lead builds on its last commit.
          const base = commitId(m.base);
          if (base && (l.leader === link.key || l.awaiting?.key === link.key || l.lost?.key === link.key)) this.host.roomHolds(room.name, base);
          if (l.awaiting?.key === link.key) {
            clearTimeout(l.awaiting.timer);
            l.awaiting = null;
          }
          if (l.lost?.key === link.key) {
            clearTimeout(l.lost.timer);
            l.lost = null;
          }
        }
        this.review(m.key);
        return;
      }
      case 'base': {
        const said = theirs.get(m.key);
        const commit = commitId(m.commit);
        if (!said || !commit || said.session !== m.session) return;
        said.base = commit;
        if (m.sv !== undefined) said.committed = { commit, sv: bytesOf(m.sv) };
        if (room && room.session === m.session && this.node.mayWrite(link.key, room.path)) {
          const l = this.localOf(m.key);
          this.host.roomHolds(room.name, commit);
          if (m.handover && l.awaiting?.key === link.key) {
            clearTimeout(l.awaiting.timer);
            l.awaiting = null;
          }
        }
        this.review(m.key);
        return;
      }
      case 'update': {
        // Only from a device whose person may change the document (0066), made on one whose person may too: any other's
        // edits are not taken, whoever passes them on. Only from a device in this session: two sessions never combine (0077).
        const origin = typeof m.origin === 'string' && /^[0-9a-f]{64}$/.test(m.origin) ? m.origin : link.key;
        if (room && theirs.get(m.key)?.session === room.session && this.takes(room, bytesOf(m.update), link.key, origin)) {
          relay.applyPeerUpdate(room.name, bytesOf(m.update), through(link.key, origin), this.credit(origin, m.by));
        }
        return;
      }
      case 'awareness': {
        const own = room && theirs.get(m.key)?.session === room.session ? this.ownAwareness(link, room.name, bytesOf(m.update)) : null;
        if (room && own) relay.applyPeerAwareness(room.name, own, link.key);
        return;
      }
      case 'want': {
        if (typeof m.id !== 'string') return;
        const state = room && relay.state(room.name);
        this.send(link, room && state ? { type: 'room', op: 'state', key: m.key, id: m.id, session: room.session, state, base: room.base } : { type: 'room', op: 'state', key: m.key, id: m.id, session: null });
        return;
      }
      case 'state':
      case 'versioned': {
        const q = typeof m.id === 'string' ? this.asked.get(m.id) : undefined;
        if (!q || q.device !== link.key) return;
        this.asked.delete(m.id);
        // A session's state is taken only from a device that may change the document.
        q.answer(m.op === 'state' && !this.node.mayWrite(link.key, about ?? '') ? null : m);
        return;
      }
      case 'version': {
        if (typeof m.id !== 'string' || typeof m.message !== 'string') return;
        const reply = (commit: string | null) => this.send(link, { type: 'room', op: 'versioned', key: m.key, id: m.id, commit });
        if (!room || theirs.get(m.key)?.session !== room.session || !this.node.mayWrite(link.key, room.path) || !this.mayLead(room.name)) return reply(null);
        void this.host.namedVersion(room.name, m.message).then(reply, () => reply(null));
        return;
      }
    }
  }

  /**
   * Two sessions of one file meet (0077): the one whose leader has the higher
   * key gives way. Its leader commits; once the other session holds that
   * commit (its devices say so: base) and a device has nothing in the session
   * beyond it, the device moves to the other session. Looked at again on news,
   * and every MEET_MS while it gives way.
   */
  private async meet(key: string): Promise<void> {
    if (this.closed) return;
    if (this.meeting.has(key)) {
      this.meetAgain.add(key);
      return;
    }
    this.meeting.add(key);
    try {
      do {
        this.meetAgain.delete(key);
        await this.meetOnce(key);
      } while (this.meetAgain.has(key) && !this.closed);
    } catch (e) {
      this.log(`could not meet another session: ${(e as Error).message}`);
    } finally {
      this.meeting.delete(key);
    }
  }

  private async meetOnce(key: string): Promise<void> {
    const room = this.host.liveRoom(key);
    const others = room ? this.sessionsOf(key, room.session) : [];
    if (!room?.session || !others.length) return this.stopMeeting(key);
    const kept = others.reduce((a, b) => (b.leader < a.leader ? b : a));
    const mine = this.leaderOf(room) ?? NO_ONE;
    // This session is kept: the others come to it.
    if (mine < kept.leader) return this.stopMeeting(key);
    if (!this.meetings.has(key)) this.meetings.set(key, setInterval(() => void this.meet(key), MEET_MS));
    const me = mine === this.node.myKey;
    const committed = me ? await this.host.committedOf(room.name) : this.said(mine, key)?.session === room.session ? this.said(mine, key)!.committed : null;
    const now = this.host.sessionRelay.stateVector(room.name);
    if (!committed || !now || !covers(committed.sv, now)) {
      // Its leader commits what it has, now and again until the other holds it.
      if (me && Date.now() - (this.settled.get(key) ?? 0) > this.host.timings.flushMs) {
        this.settled.set(key, Date.now());
        await this.host.settleRoom(room.name);
      }
      return;
    }
    let held = false;
    for (const l of kept.links) {
      const base = this.said(l.key, key)?.base;
      if (base && (base === committed.commit || (await isAncestor(this.host.git, committed.commit, base)))) {
        held = true;
        break;
      }
    }
    if (!held) return;
    const source = kept.links.find((l) => l.key === kept.leader) ?? kept.links[0]!;
    const m = await this.ask(source, { type: 'room', op: 'want', key, id: '' });
    if (!m || m.op !== 'state' || m.session !== kept.session || !m.state) return;
    const base = typeof m.base === 'string' && /^[0-9a-f]{40,64}$/.test(m.base) ? m.base : null;
    const moved = await this.host.switchRoom(room.name, kept.session, bytesOf(m.state), base, () => {
      const v = this.host.sessionRelay.stateVector(room.name);
      return !!v && covers(committed.sv, v);
    });
    if (!moved) return;
    this.log(`${room.path}: moved to the session of the device with the lower key`);
    this.left(key, committed.commit);
  }

  private stopMeeting(key: string): void {
    const t = this.meetings.get(key);
    if (t) clearInterval(t);
    this.meetings.delete(key);
    this.settled.delete(key);
  }

  private log(m: string): void {
    this.host.log(`peers: ${m}`);
  }

  close(): void {
    this.closed = true;
    for (const stop of this.stops) stop();
    for (const key of [...this.local.keys(), ...this.meetings.keys()]) this.forget(key);
    for (const q of this.asked.values()) q.answer(null);
    this.asked.clear();
  }
}
