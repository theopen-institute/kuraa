// Key pairs kept in files (keys.ts): made once, never written over.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOnly, keptKey } from '../src/keys.js';

const dir = () => mkdtempSync(join(tmpdir(), 'kuraa-keys-'));

describe('kept keys', () => {
  it('are made once, the same for everyone asking at once, readable only by their owner', async () => {
    const file = join(dir(), 'nested', 'device.json');
    const keys = await Promise.all([keptKey(file), keptKey(file), keptKey(file)]);
    expect(new Set(keys.map((k) => k.publicKey.toString('hex'))).size).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).publicKey).toBe(keys[0]!.publicKey.toString('hex'));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('take the key another process made first', async () => {
    const file = join(dir(), 'signing.json');
    const theirs = '11'.repeat(32);
    // As another process would have it: written whole, before this one asks.
    expect(await createOnly(file, JSON.stringify({ secretKey: `${'00'.repeat(32)}${theirs}` }))).toBe(true);
    expect(await createOnly(file, '{}')).toBe(false);
    expect((await keptKey(file)).publicKey.toString('hex')).toBe(theirs);
  });

  it('never replace a key they cannot read', async () => {
    const file = join(dir(), 'device.json');
    writeFileSync(file, '{"secretKey": "not a key"}');
    await expect(keptKey(file)).rejects.toThrow('damaged');
    expect(readFileSync(file, 'utf8')).toBe('{"secretKey": "not a key"}');
    // One whose halves disagree is damaged too.
    const other = join(dir(), 'device.json');
    writeFileSync(other, JSON.stringify({ publicKey: '22'.repeat(32), secretKey: `${'00'.repeat(32)}${'11'.repeat(32)}` }));
    await expect(keptKey(other)).rejects.toThrow('damaged');
  });
});
