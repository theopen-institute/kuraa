// A workspace's own name (decision 0061): kept in .kuraa/workspace.json, read
// the same way on every device, even after two renames at once.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanName, MAX_NAME, nameText, parseName, readWorkspaceName, writeWorkspaceName } from '../src/workspace.js';

describe('a workspace’s name', () => {
  it('is kept as one line of JSON, and read back', () => {
    expect(nameText('Field notes')).toBe('{"name":"Field notes"}\n');
    expect(parseName(nameText('Café “Ålesund”'))).toBe('Café “Ålesund”');
    expect(parseName('')).toBeNull();
    expect(parseName('not json\n')).toBeNull();
    expect(parseName('{"name":"  "}\n')).toBeNull();
    expect(parseName('{"name":42}\n')).toBeNull();
  });

  it('after two renames at once, is the first of them, as on every device (and with a merge base shown too)', () => {
    const conflict = '<<<<<<< ours\n{"name":"Shore survey"}\n=======\n{"name":"Tide pools"}\n>>>>>>> theirs\n';
    expect(parseName(conflict)).toBe('Shore survey');
    const diff3 = '<<<<<<< ours\n{"name":"Shore survey"}\n||||||| base\n{"name":"Field notes"}\n=======\n{"name":"Tide pools"}\n>>>>>>> theirs\n';
    expect(parseName(diff3)).toBe('Shore survey');
  });

  it('is something, spaces tidied, and not too long', () => {
    expect(cleanName('  Field \t notes  ')).toBe('Field notes');
    expect(() => cleanName('   ')).toThrow('needs a name');
    expect(() => cleanName(undefined)).toThrow('needs a name');
    expect(cleanName('x'.repeat(MAX_NAME))).toHaveLength(MAX_NAME);
    expect(() => cleanName('x'.repeat(MAX_NAME + 1))).toThrow('at most');
  });

  it('is never read or written through a link, whether the file or its folder is one (0037)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kuraa-name-link-'));
    const victim = join(base, 'victim.txt');
    writeFileSync(victim, '{"name":"Secret"}\n');
    // The file a link out of the workspace (as a push could make it: the review's proof).
    const ws = join(base, 'ws');
    mkdirSync(join(ws, '.kuraa'), { recursive: true });
    symlinkSync('../../victim.txt', join(ws, '.kuraa', 'workspace.json'));
    expect(await readWorkspaceName(ws)).toBeNull();
    await expect(writeWorkspaceName(ws, 'pwned name')).rejects.toThrow('symbolic link');
    // Its folder a link.
    const other = join(base, 'other');
    mkdirSync(other);
    mkdirSync(join(base, 'elsewhere'));
    writeFileSync(join(base, 'elsewhere', 'workspace.json'), '{"name":"Secret"}\n');
    symlinkSync(join(base, 'elsewhere'), join(other, '.kuraa'));
    expect(await readWorkspaceName(other)).toBeNull();
    await expect(writeWorkspaceName(other, 'pwned name')).rejects.toThrow('symbolic link');
    expect(readFileSync(victim, 'utf8')).toBe('{"name":"Secret"}\n');
    expect(readFileSync(join(base, 'elsewhere', 'workspace.json'), 'utf8')).toBe('{"name":"Secret"}\n');
    // A workspace of its own is written and read as ever, its folder made.
    const own = join(base, 'own');
    mkdirSync(own);
    await writeWorkspaceName(own, 'Field notes');
    expect(await readWorkspaceName(own)).toBe('Field notes');
    rmSync(base, { recursive: true, force: true });
  });
});
