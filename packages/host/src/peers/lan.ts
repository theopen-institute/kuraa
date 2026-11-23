// Finding the workspace's devices on the local network, with or without the
// internet (0050): two computers in one office, one home, or on one plane's
// network sync even when the DHT cannot be reached.
//
// Each device says on the network, by multicast, "a device with this key listens
// on this port", tagged for each workspace it is in with a code made from that
// workspace's secret (lanKeyFor), and from each invite link's topic it
// announces: only a device that knows one can tell the tag is its workspace's,
// and no other learns which workspace it is. A device that hears one of its own
// connects to it over TCP, encrypted and checked as Hyperswarm's connections
// are (Noise, @hyperswarm/secret-stream, with the same keys): the rest of the
// peer layer cannot tell the two kinds apart. Of two devices that hear each
// other, the one with the lower key connects. The tag covers the address it is
// said from, so what one device said, said again from another computer, sends
// no one to that computer.
//
// Said when a device starts, when its network changes, and when it looks for
// a device that is missing; asking those that hear it to say where they are.
// One socket for the whole process, shared by every workspace, listening on
// every network the computer is on, and said on each (not only the one the
// system routes by: with a VPN taking every route, or Ethernet and Wi-Fi both
// up, that one is not the local network).
import { createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

/** The multicast group and port kuraa devices say where they are on (site-local: never routed beyond it). */
export const LAN_GROUP = '239.255.77.77';
export const LAN_PORT = 48776;

/** What a device of a workspace hears through the local network. */
export interface LanMember {
  /** Its key, hex. */
  key: string;
  /** The port it listens on for connections from devices of its workspaces. */
  port(): number;
  /** Its workspaces' codes for the network: the secret's (lanKeyFor), and each link's topic it announces. */
  keys(): Buffer[];
  /** A device of one of its workspaces said where it is. */
  found(key: string, host: string, port: number): void;
}

interface Said { k: string; p: number; t: string[]; a?: boolean }

/** A device's tag for a workspace: its key, port, and the address it says it from ('' where it cannot tell: only taken from this computer itself). */
export const lanTag = (key: Buffer, device: string, port: number, from: string) => createHmac('sha256', key).update(`kuraa lan/2\0${device}\0${port}\0${from}`).digest('hex').slice(0, 32);

/** An address of this computer itself. */
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/** Whether tags heard from `host` say a device of the workspace whose code is `key` listens on `port` there. */
export const saidBy = (tags: Set<string>, key: Buffer, device: string, port: number, host: string) =>
  tags.has(lanTag(key, device, port, host)) || (LOOPBACK.test(host) && tags.has(lanTag(key, device, port, '')));

/** This computer's addresses on its networks (IPv4, not its own loopback). */
function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((a) => !!a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
}

class LocalNetwork {
  private readonly members = new Set<LanMember>();
  private socket: dgram.Socket | null = null;
  /** One socket to say things on for each network, by its address here (multicast goes out on one network per socket). */
  private readonly senders = new Map<string, dgram.Socket>();
  /** The networks the listening socket has joined the group on. */
  private readonly joined = new Set<string>();
  private starting: Promise<void> | null = null;
  /** When the socket last failed to open: tried again from say, at most every REOPEN_MS (0071: no network yet at login, say). */
  private failedAt = 0;
  /** When each member last answered someone asking: at most once a second. */
  private readonly answered = new WeakMap<LanMember, number>();

  constructor(private readonly log: (m: string) => void) {}

  get size(): number {
    return this.members.size;
  }

  async add(m: LanMember): Promise<void> {
    this.members.add(m);
    this.starting ??= this.open();
    await this.starting;
  }

  remove(m: LanMember): void {
    this.members.delete(m);
  }

  private open(): Promise<void> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', (e) => {
        this.log(`peers: the local network cannot be used to find devices: ${e.message}`);
        socket.close();
        if (this.socket === socket) this.socket = null;
        this.failed();
        resolve();
      });
      socket.on('message', (buf, rinfo) => this.heard(buf, rinfo.address));
      socket.bind(LAN_PORT, () => {
        try {
          socket.setMulticastTTL(1);
          socket.setMulticastLoopback(true);
          this.socket = socket;
          this.networks();
          // No network to join on (none up, or none said): the system's choice, as a last resort.
          if (!this.joined.size) socket.addMembership(LAN_GROUP);
        } catch (e) {
          this.log(`peers: the local network cannot be used to find devices: ${(e as Error).message}`);
          socket.close();
          this.socket = null;
          this.failed();
        }
        resolve();
      });
    });
  }

  /** The socket could not be opened, or failed: opened again later (say). */
  private failed(): void {
    this.failedAt = Date.now();
    this.starting = null;
    this.joined.clear();
  }

  /** Hear and say on each network the computer is on now: networks come and go (Wi-Fi, VPN, a cable). */
  private networks(): void {
    const socket = this.socket;
    if (!socket) return;
    const now = new Set(localAddresses());
    for (const address of now) {
      if (!this.joined.has(address)) {
        try {
          socket.addMembership(LAN_GROUP, address);
          this.joined.add(address);
        } catch { /* a network that takes no multicast */ }
      }
      if (!this.senders.has(address)) {
        const sender = dgram.createSocket({ type: 'udp4' });
        sender.on('error', () => {
          sender.close();
          if (this.senders.get(address) === sender) this.senders.delete(address);
        });
        sender.bind({ address, port: 0 }, () => {
          try {
            sender.setMulticastInterface(address);
            sender.setMulticastTTL(1);
            sender.setMulticastLoopback(true);
          } catch { /* closed meanwhile */ }
        });
        this.senders.set(address, sender);
      }
    }
    for (const [address, sender] of this.senders) {
      if (now.has(address)) continue;
      sender.close();
      this.senders.delete(address);
    }
    for (const address of this.joined) if (!now.has(address)) this.joined.delete(address);
  }

  /** Say where a member is, to every device of its workspaces on the network; `ask`: and ask them to say where they are. */
  say(m: LanMember, ask: boolean): void {
    if (!this.socket && this.members.has(m) && !this.starting && Date.now() - this.failedAt > REOPEN_MS) {
      this.starting = this.open();
      void this.starting.then(() => this.socket && this.say(m, ask));
      return;
    }
    if (!this.socket || !this.members.has(m) || !m.port()) return;
    const keys = m.keys().slice(0, 32);
    if (!keys.length) return;
    const said = (from: string): string => JSON.stringify({ k: m.key, p: m.port(), t: keys.map((k) => lanTag(k, m.key, m.port(), from)), ...(ask ? { a: true } : {}) } satisfies Said);
    this.networks();
    // Each network's from its own address, which the tags cover; with none, from wherever the system says.
    if (!this.senders.size) this.socket.send(said(''), LAN_PORT, LAN_GROUP, () => undefined);
    for (const [address, sender] of this.senders) sender.send(said(address), LAN_PORT, LAN_GROUP, () => undefined);
  }

  private heard(buf: Buffer, host: string): void {
    if (buf.length > 4096) return;
    let m: Said;
    try {
      m = JSON.parse(buf.toString('utf8')) as Said;
    } catch {
      return;
    }
    if (typeof m?.k !== 'string' || !/^[0-9a-f]{64}$/.test(m.k) || !Number.isInteger(m.p) || m.p <= 0 || m.p > 65535 || !Array.isArray(m.t) || m.t.length > 32) return;
    const tags = new Set(m.t.filter((t): t is string => typeof t === 'string'));
    for (const member of this.members) {
      if (member.key === m.k) continue;
      // Said from the address it came from (or, from this computer itself, from one it could not tell).
      if (!member.keys().some((k) => saidBy(tags, k, m.k, m.p, host))) continue;
      member.found(m.k, host, m.p);
      const last = this.answered.get(member) ?? 0;
      if (m.a && Date.now() - last > 1000) {
        this.answered.set(member, Date.now());
        this.say(member, false);
      }
    }
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.starting = null;
    for (const sender of this.senders.values()) sender.close();
    this.senders.clear();
    this.joined.clear();
  }
}

/** How long after the socket failed it is opened again, at the soonest. */
const REOPEN_MS = 30_000;

let shared: LocalNetwork | null = null;

/**
 * Hear and be heard on the local network, as a device of a workspace. Returns
 * how to say where it is, and how to stop (the socket closes with the last).
 */
export async function joinLan(m: LanMember, log: (m: string) => void): Promise<{ say(ask: boolean): void; leave(): void }> {
  const net = (shared ??= new LocalNetwork(log));
  await net.add(m);
  return {
    say: (ask) => net.say(m, ask),
    leave: () => {
      net.remove(m);
      if (!net.size && shared === net) {
        net.close();
        shared = null;
      }
    },
  };
}
