// A verifier (docs/decisions/0066-permissions-without-a-centre.md, step 6): a kuraa
// server that checks that an identity controls an email address, by sending a
// code there, and says so in an attestation it signs (peers/attest.ts); and
// that keeps, if asked to, a person's recovery key locked with a passphrase it
// never sees (escrow), handing it back to whoever shows a code sent to their
// address. Workspaces count its attestations only if their policy names it.
//
// Its routes are public (under /verify/: whoever asks has no access code here),
// so each is guarded by what it asks for: an identity's signature to have a
// code sent for it, the code to have the attestation or the locked key, a few
// tries per code, and one code per address at a time.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import { keptKey, type KeyPair } from './keys.js';
import { askMessage, attest, emailOf, readAttestation } from './peers/attest.js';
import { readEvent, resolve, type KeyEvent } from './peers/kel.js';
import { readBody, send } from './http.js';

export interface VerifierOptions {
  /** Where it keeps its key, and the locked recovery keys. */
  dir: string;
  /** What it is called, to people choosing it. */
  label?: string;
  /** Send an email (the code). */
  mail: (to: string, subject: string, text: string) => Promise<void>;
  /** Keep people's locked recovery keys too. */
  escrow?: boolean;
  now?: () => number;
  /** How long before another code may go to one address (ms; default half a minute). */
  resendMs?: number;
}

/** Send mail by a command (`sendmail -t`, say) that takes the message, headers first, on its input. */
export function mailCommand(command: string): VerifierOptions['mail'] {
  return (to, subject, text) => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`The mail command failed: ${err.trim() || `exit ${code}`}`))));
    child.stdin.end(`To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${text}\n`);
  });
}

const CODE_MS = 15 * 60_000;
const RESEND_MS = 30_000;
const TRIES = 5;

export class Verifier {
  private key: KeyPair | null = null;
  private readonly codes = new Map<string, { code: string; expires: number; tries: number }>();
  private readonly sent = new Map<string, number>();

  constructor(private readonly o: VerifierOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    this.key = await keptKey(join(this.o.dir, 'verifier.json'));
  }

  get publicKey(): string {
    return this.key!.publicKey.toString('hex');
  }

  /** Answer a request under /verify/; false if it is not one. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/verify' && !url.pathname.startsWith('/verify/')) return false;
    const route = `${req.method} ${url.pathname.replace(/\/$/, '')}`;
    try {
      send(res, 200, await this.answer(route, req));
    } catch (e) {
      send(res, e instanceof NoRoute ? 404 : 400, { error: (e as Error).message });
    }
    return true;
  }

  private async answer(route: string, req: IncomingMessage): Promise<unknown> {
    if (route === 'GET /verify') return { key: this.publicKey, label: this.o.label ?? 'kuraa verifier', escrow: !!this.o.escrow };
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (route === 'POST /verify/email/start') return this.startEmail(body);
    if (route === 'POST /verify/email/finish') return this.finishEmail(body);
    if (this.o.escrow && route === 'POST /verify/escrow/put') return this.put(body);
    if (this.o.escrow && route === 'POST /verify/escrow/start') return this.startEscrow(body);
    if (this.o.escrow && route === 'POST /verify/escrow/get') return this.get(body);
    throw new NoRoute('No such route');
  }

  /** The identity asking, by its log and its key's signature on what it asks; refused if not. */
  private identity(body: Record<string, unknown>, what: string, claim: string): string {
    const id = typeof body.id === 'string' ? body.id : '';
    const log = Array.isArray(body.log) ? (body.log as unknown[]).map(readEvent).filter((e): e is KeyEvent => !!e) : [];
    const state = resolve(log, id, { trustTrots: true });
    if (!state || state.disputed) throw new Error('Not an identity');
    const proof = typeof body.proof === 'string' && /^[0-9a-f]{128}$/.test(body.proof) ? body.proof : '';
    if (!proof || !crypto.verify(askMessage(what, id, claim), Buffer.from(proof, 'hex'), Buffer.from(state.current, 'hex'))) throw new Error('Not signed by that identity’s key');
    return id;
  }

  /** Send a code to an address (one at a time, a while apart). */
  private async sendCode(slot: string, email: string, subject: string, text: (code: string) => string): Promise<void> {
    const last = this.sent.get(email) ?? 0;
    if (this.now() - last < (this.o.resendMs ?? RESEND_MS)) throw new Error('A code was sent to that address a moment ago: wait half a minute');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(slot, { code, expires: this.now() + CODE_MS, tries: 0 });
    this.sent.set(email, this.now());
    await this.o.mail(email, subject, text(code));
  }

  /** A code for a slot, checked (and used up). */
  private checkCode(slot: string, code: unknown): void {
    const c = this.codes.get(slot);
    if (!c || c.expires < this.now()) throw new Error('No code is waiting for that, or it has expired: ask for another');
    if (++c.tries > TRIES) {
      this.codes.delete(slot);
      throw new Error('Too many tries: ask for another code');
    }
    if (typeof code !== 'string' || code.trim() !== c.code) throw new Error('That is not the code');
    this.codes.delete(slot);
  }

  private async startEmail(body: Record<string, unknown>): Promise<{ sent: true }> {
    const email = emailOf(String(body.email ?? ''));
    if (!email) throw new Error('Not an email address');
    const id = this.identity(body, 'email', `email:${email}`);
    await this.sendCode(`email\0${id}\0${email}`, email, 'Your kuraa code', (code) => `Your code is ${code}.\n\nType it in kuraa to say this address is yours. It works for 15 minutes. If you did not ask for it, ignore this email.`);
    return { sent: true };
  }

  private finishEmail(body: Record<string, unknown>): { attestation: ReturnType<typeof attest> } {
    const email = emailOf(String(body.email ?? ''));
    const id = typeof body.id === 'string' && /^[0-9a-f]{64}$/.test(body.id) ? body.id : null;
    if (!email || !id) throw new Error('Not an identity and an address');
    this.checkCode(`email\0${id}\0${email}`, body.code);
    return { attestation: attest(this.key!, id, `email:${email}`, undefined, this.now()) };
  }

  private escrowFile(email: string): string {
    return join(this.o.dir, 'escrow', `${createHash('sha256').update(email).digest('hex')}.json`);
  }

  private async escrowed(email: string): Promise<{ id: string; blob: string; at: number }[]> {
    try {
      return JSON.parse(await readFile(this.escrowFile(email), 'utf8')) as { id: string; blob: string; at: number }[];
    } catch {
      return [];
    }
  }

  /** Keep a locked recovery key, for an identity whose address this verifier attested, asked with its key. */
  private async put(body: Record<string, unknown>): Promise<{ kept: true }> {
    const a = readAttestation(body.attestation);
    if (!a || a.verifier !== this.publicKey || a.expires < this.now()) throw new Error('Have your address checked here first');
    const blob = typeof body.blob === 'string' && body.blob.length < 20_000 ? body.blob : null;
    if (!blob) throw new Error('Nothing to keep');
    const id = this.identity(body, 'escrow', createHash('sha256').update(blob).digest('hex'));
    if (id !== a.id) throw new Error('That address was checked for another identity');
    const email = a.claim.slice(6);
    const list = (await this.escrowed(email)).filter((x) => x.id !== id);
    list.push({ id, blob, at: this.now() });
    await mkdir(join(this.o.dir, 'escrow'), { recursive: true });
    await writeFile(this.escrowFile(email), JSON.stringify(list), { mode: 0o600 });
    return { kept: true };
  }

  private async startEscrow(body: Record<string, unknown>): Promise<{ sent: true }> {
    const email = emailOf(String(body.email ?? ''));
    if (!email) throw new Error('Not an email address');
    // Sent whether or not anything is kept for it: the answer says nothing of who keeps what here.
    await this.sendCode(`escrow\0${email}`, email, 'Your kuraa recovery code', (code) => `Your code is ${code}.\n\nType it in kuraa to have your locked recovery key back. It works for 15 minutes. If you did not ask for it, ignore this email: without your passphrase, the key is of no use to anyone.`);
    return { sent: true };
  }

  private async get(body: Record<string, unknown>): Promise<{ kept: { id: string; blob: string; at: number }[] }> {
    const email = emailOf(String(body.email ?? ''));
    if (!email) throw new Error('Not an email address');
    this.checkCode(`escrow\0${email}`, body.code);
    return { kept: await this.escrowed(email) };
  }
}

class NoRoute extends Error {}
