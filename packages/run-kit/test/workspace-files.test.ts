// Files components keep in a workspace are never read or written through a
// symbolic link, at any part of their path (decision 0037).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceFile, readWorkspaceFileSync, writeWorkspaceFile } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace, and a file outside it. */
function setUp(): { ws: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'kuraa-ws-files-'));
  dirs.push(base);
  const ws = join(base, 'ws');
  mkdirSync(ws);
  mkdirSync(join(base, 'out'));
  writeFileSync(join(base, 'out', 'secret.json'), 'SECRET');
  return { ws, outside: join(base, 'out') };
}

describe('workspace files', () => {
  it('reads and writes a file, making its folders', async () => {
    const { ws } = setUp();
    await writeWorkspaceFile(ws, '.kuraa/deep/r.json', '{}\n');
    expect((await readWorkspaceFile(ws, '.kuraa/deep/r.json')).toString()).toBe('{}\n');
    expect(readWorkspaceFileSync(ws, '.kuraa/deep/r.json').toString()).toBe('{}\n');
    await expect(readWorkspaceFile(ws, 'none.json')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a file that is a link', async () => {
    const { ws, outside } = setUp();
    mkdirSync(join(ws, '.kuraa'));
    symlinkSync(join(outside, 'secret.json'), join(ws, '.kuraa', 'r.json'));
    await expect(readWorkspaceFile(ws, '.kuraa/r.json')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(() => readWorkspaceFileSync(ws, '.kuraa/r.json')).toThrow('symbolic link');
    await expect(writeWorkspaceFile(ws, '.kuraa/r.json', 'PWNED')).rejects.toThrow('symbolic link');
    expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe('SECRET');
  });

  it('refuses a path through a folder that is a link', async () => {
    const { ws, outside } = setUp();
    symlinkSync(outside, join(ws, '.kuraa'));
    await expect(readWorkspaceFile(ws, '.kuraa/secret.json')).rejects.toThrow('symbolic link');
    expect(() => readWorkspaceFileSync(ws, '.kuraa/secret.json')).toThrow('symbolic link');
    await expect(writeWorkspaceFile(ws, '.kuraa/secret.json', 'PWNED')).rejects.toThrow('symbolic link');
    await expect(writeWorkspaceFile(ws, '.kuraa/new.json', 'PWNED')).rejects.toThrow('symbolic link');
    expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe('SECRET');
  });

  it('refuses a path outside the workspace', async () => {
    const { ws } = setUp();
    await expect(writeWorkspaceFile(ws, '../out/secret.json', 'PWNED')).rejects.toThrow('outside the workspace');
    expect(() => readWorkspaceFileSync(ws, '../out/secret.json')).toThrow('outside the workspace');
  });
});
