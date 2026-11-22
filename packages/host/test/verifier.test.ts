// Attestations and a verifier: email addresses checked with a code, counted where
// a workspace names the verifier; recovery keys kept locked (decision 0066, step 6).
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import crypto from 'hypercore-crypto';
import { Verifier } from '../src/verifier.js';
import { askMessage, readAttestation } from '../src/peers/attest.js';
import { createPerson, openRecovery, recoveryLine, sealRecovery } from '../src/peers/person.js';
import { Git } from '../src/git.js';
import { Identity } from '../src/peers/identity.js';
import { signRecord } from '../src/peers/records.js';
import { startHub } from '../src/index.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `kuraa-${name}-`));
  dirs.push(d);
  return d;
};

/** A verifier on this computer, its mail kept to read. */
async function verifier(escrow = true) {
  const mail: { to: string; text: string }[] = [];
  let now = Date.now();
  const v = new Verifier({ dir: tmp('verifier'), label: 'Test verifier', escrow, mail: async (to, _s, text) => void mail.push({ to, text }), now: () => now });
  await v.start();
  const server = createServer((req, res) => void v.handle(req, res, new URL(req.url ?? '/', 'http://localhost')));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ask = async (path: string, body?: unknown) => {
    const r = await fetch(`${url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const code = () => /(\d{6})/.exec(mail.at(-1)!.text)![1]!;
  return { v, url, ask, mail, code, later: (ms: number) => (now += ms) };
}

describe('a verifier', () => {
  it('checks an address with a code sent there, and attests it of the identity that asked', async () => {
    const { v, ask, mail, code, later } = await verifier();
    expect((await ask('/verify')).body).toMatchObject({ key: v.publicKey, label: 'Test verifier', escrow: true });
    const bo = await createPerson('Bo', join(tmp('bo'), 'person.json'));
    const proof = (email: string, key = bo) => crypto.sign(askMessage('email', bo.id, `email:${email}`), key.secretKey).toString('hex');
    // Only the identity's own key asks for it.
    expect((await ask('/verify/email/start', { id: bo.id, email: 'bo@uni.edu', log: bo.events, proof: proof('bo@uni.edu', crypto.keyPair() as never) })).status).toBe(400);
    expect((await ask('/verify/email/start', { id: bo.id, email: 'Bo@Uni.edu', log: bo.events, proof: proof('bo@uni.edu') })).status).toBe(200);
    expect(mail.at(-1)!.to).toBe('bo@uni.edu');
    // Once a while: not again at once.
    expect((await ask('/verify/email/start', { id: bo.id, email: 'bo@uni.edu', log: bo.events, proof: proof('bo@uni.edu') })).body.error).toMatch(/a moment ago/);
    expect((await ask('/verify/email/finish', { id: bo.id, email: 'bo@uni.edu', code: '000000' === code() ? '111111' : '000000' })).body.error).toMatch(/not the code/);
    const r = await ask('/verify/email/finish', { id: bo.id, email: 'bo@uni.edu', code: code() });
    const a = readAttestation(r.body.attestation);
    expect(a).toMatchObject({ id: bo.id, claim: 'email:bo@uni.edu', verifier: v.publicKey });
    // The code is used up; a later one expires.
    expect((await ask('/verify/email/finish', { id: bo.id, email: 'bo@uni.edu', code: code() })).status).toBe(400);
    later(60_000);
    await ask('/verify/email/start', { id: bo.id, email: 'bo@uni.edu', log: bo.events, proof: proof('bo@uni.edu') });
    later(16 * 60_000);
    expect((await ask('/verify/email/finish', { id: bo.id, email: 'bo@uni.edu', code: code() })).body.error).toMatch(/expired/);
  });

  it('keeps a recovery key locked with a passphrase it never sees, and gives it back for a code', async () => {
    const { ask, code, later } = await verifier();
    const file = join(tmp('bo'), 'person.json');
    const bo = await createPerson('Bo', file);
    await ask('/verify/email/start', { id: bo.id, email: 'bo@uni.edu', log: bo.events, proof: crypto.sign(askMessage('email', bo.id, 'email:bo@uni.edu'), bo.secretKey).toString('hex') });
    const attestation = (await ask('/verify/email/finish', { id: bo.id, email: 'bo@uni.edu', code: code() })).body.attestation;
    const line = (await recoveryLine(file))!;
    const blob = sealRecovery(line, 'correct horse battery');
    const put = (proofBlob: string) => ask('/verify/escrow/put', { attestation, blob, id: bo.id, log: bo.events, proof: crypto.sign(askMessage('escrow', bo.id, createHash('sha256').update(proofBlob).digest('hex')), bo.secretKey).toString('hex') });
    expect((await put('another blob')).status).toBe(400);
    expect((await put(blob)).body).toEqual({ kept: true });
    // Back, for a code sent to the address: still locked; the passphrase opens it.
    later(31_000);
    expect((await ask('/verify/escrow/start', { email: 'bo@uni.edu' })).body).toEqual({ sent: true });
    expect((await ask('/verify/escrow/get', { email: 'bo@uni.edu', code: '12345x' })).status).toBe(400);
    const kept = (await ask('/verify/escrow/get', { email: 'bo@uni.edu', code: code() })).body.kept as { id: string; blob: string }[];
    expect(kept.map((k) => k.id)).toEqual([bo.id]);
    expect(openRecovery(kept[0]!.blob, 'correct horse battery')).toBe(line);
    expect(openRecovery(kept[0]!.blob, 'wrong')).toBeNull();
  });

  it('a workspace counts attestations only by the verifiers its policy names; an email entry then names that person', async () => {
    const { v, ask, code } = await verifier(false);
    const dir = tmp('records');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const id = new Identity(new Git(dir), join(dir, '.git', 'kuraa'));
    await id.found();
    const ada = await createPerson('Ada', join(tmp('ada'), 'person.json'));
    const bo = await createPerson('Bo', join(tmp('bo'), 'person.json'));
    const adaKey = crypto.keyPair();
    await id.signsWith(adaKey);
    await id.vouch(ada, adaKey);
    await id.ensureGenesis(ada.id, adaKey, true);
    // Ada invites bo@uni.edu as an admin, before Bo has said that address is his.
    await id.adminOp({ t: 'grant', group: 'workspace', who: 'email:bo@uni.edu', role: 'admin' }, adaKey);
    expect((await id.policy()).invited()).toEqual([{ email: 'bo@uni.edu', role: 'admin' }]);
    // Bo has it checked, and says so here (as his device would, passing on what the verifier signed).
    await ask('/verify/email/start', { id: bo.id, email: 'bo@uni.edu', log: bo.events, proof: crypto.sign(askMessage('email', bo.id, 'email:bo@uni.edu'), bo.secretKey).toString('hex') });
    const attestation = readAttestation((await ask('/verify/email/finish', { id: bo.id, email: 'bo@uni.edu', code: code() })).body.attestation)!;
    const device = crypto.keyPair();
    await id.addMember(device.publicKey.toString('hex'), 'bo');
    await id.takeRecords([signRecord({ kind: 'attest', workspace: (await id.workspace())!.id, subject: bo.id, attestation }, device)]);
    // Not counted: this workspace names no verifier yet.
    expect((await id.policy()).role(bo.id)).toBeNull();
    // Ada names it: Bo is an admin, as the entry says, and his address names him.
    await id.adminOp({ t: 'verifier', key: v.publicKey, url: 'https://verify.example.org' }, adaKey);
    const p = await id.policy();
    expect(p.role(bo.id)).toBe('admin');
    expect(p.invited()).toEqual([]);
    expect(await id.emailsOf(bo.id)).toEqual(['bo@uni.edu']);
  });
});

describe('a locked recovery key', () => {
  it('opens with its passphrase alone', () => {
    const blob = sealRecovery('kuraa-recovery:abc', 'correct horse battery');
    expect(openRecovery(blob, 'correct horse battery')).toBe('kuraa-recovery:abc');
    expect(openRecovery(blob, 'wrong horse battery')).toBeNull();
    expect(() => sealRecovery('x', 'short')).toThrow('8 characters');
  });
});

describe('your email and your recovery key, through the app (step 6)', () => {
  it('a hub that is a verifier: the app has an address checked, and the recovery key kept and had back', async () => {
    const mail: string[] = [];
    // A person of this test's own (the tests' keys folder is shared by every test file).
    const before = process.env.KURAA_PERSON;
    process.env.KURAA_PERSON = join(tmp('keys'), 'person.json');
    const running = await startHub({ root: tmp('hub'), host: '127.0.0.1', port: 0, verifier: { dir: tmp('verifier-state'), escrow: true, resendMs: 0, mail: async (_to, _s, text) => void mail.push(text) } });
    try {
      const call = async (path: string, body?: unknown) => {
        const r = await fetch(running.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };
      const ws = (await call('/hub/api/workspaces', { kind: 'new', name: 'Notes' })).body.workspace as { id: string };
      const at = (path: string, body?: unknown) => call(`/w/${ws.id}${path}`, body);
      await at('/api/person', { name: 'Bo' });
      const code = () => /(\d{6})/.exec(mail.at(-1)!)![1]!;
      expect((await at('/api/person/email/start', { url: running.url, email: 'bo@uni.edu' })).status).toBe(200);
      const done = await at('/api/person/email/finish', { url: running.url, email: 'bo@uni.edu', code: code() });
      expect(done.status).toBe(200);
      expect((done.body.person as { identity: { emails: { email: string }[] } }).identity.emails.map((e) => e.email)).toEqual(['bo@uni.edu']);
      // Kept with the hub, locked; then no longer here.
      expect((await at('/api/person/escrow/put', { url: running.url, passphrase: 'short' })).status).toBe(400);
      const kept = await at('/api/person/escrow/put', { url: running.url, passphrase: 'correct horse battery' });
      expect(kept.status).toBe(200);
      expect((kept.body.person as { identity: { recovery: string } }).identity.recovery).toBe('saved');
      // Had back: a code, and the passphrase.
      await at('/api/person/escrow/start', { url: running.url, email: 'bo@uni.edu' });
      expect((await at('/api/person/escrow/get', { url: running.url, email: 'bo@uni.edu', code: code(), passphrase: 'wrong passphrase' })).status).toBe(400);
      await at('/api/person/escrow/start', { url: running.url, email: 'bo@uni.edu' });
      const back = await at('/api/person/escrow/get', { url: running.url, email: 'bo@uni.edu', code: code(), passphrase: 'correct horse battery' });
      expect(back.body).toMatchObject({ name: 'Bo' });
      expect(String(back.body.line)).toMatch(/^kuraa-recovery:/);
    } finally {
      await running.close();
      process.env.KURAA_PERSON = before;
    }
  });
});
