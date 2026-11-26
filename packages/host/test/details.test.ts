// Document details (docs/decisions/0094-word-counts-and-document-details.md) on
// a host: on by default; every document's synopsis, label, status and keywords
// read from its header, those with none left out; read again after a change
// from elsewhere (a commit of the file brought in).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detailsFeature } from '@kuraa/details';
import { startHost, type RunningHost } from '../src/index.js';

const FAST = { flushMs: 150, idleCommitMs: 500, maxCommitMs: 5000, dropMs: 400 };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('document details', () => {
  let dir: string;
  let running: RunningHost;
  const documents = async () => ((await (await fetch(`${running.url}/api/features/details/documents`, { headers: { authorization: `Bearer ${running.token}` } })).json()) as { documents: Record<string, unknown> }).documents;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-details-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'novel'), { recursive: true });
    writeFileSync(join(dir, 'novel/a.md'), '---\ntitle: Arrival\nlabel: Chapter\nstatus: First draft\nkeywords: sea, night\nsynopsis: They come.\n---\n\nWe came.\n');
    writeFileSync(join(dir, 'novel/b.md'), '---\ntitle: Boats\n---\n\nBoats.\n');
    writeFileSync(join(dir, 'notes.txt'), 'label: not a header\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, timings: FAST, features: [detailsFeature] });
  });

  afterEach(async () => {
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads every document’s details from its header, and leaves out those with none', async () => {
    expect(await documents()).toEqual({ 'novel/a.md': { synopsis: 'They come.', label: 'Chapter', status: 'First draft', keywords: ['sea', 'night'] } });
  });
});
