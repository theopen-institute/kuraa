// Words written by day and person, from the history (0094; @kuraa/words's host
// half through the feature contract, 0121): every commit but merges, on its own day, credited in full to everyone credited on it (its
// co-authors, else its author); renames followed; only documents counted; and
// what is typed here not committed yet, today.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Transform } from 'prosemirror-transform';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless } from '@kuraa/session/testing';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wordsFeature } from '@kuraa/words';
import { coAuthors, parseBatch, parseDiffTree, parseLog } from '../src/history.js';
import { startHost, type RunningHost } from '../src/index.js';

const FAST = { flushMs: 150, idleCommitMs: 500, maxCommitMs: 5000, dropMs: 400 };

describe('reading git for features’ history (0121)', () => {
  it('reads diff-tree’s batch: each commit’s paths, renames old and new', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(parseDiffTree(`${a}\0M\0x.md\0R087\0old.md\0new.md\0${b}\0A\0y.md\0D\0z.md\0`)).toEqual(new Map([
      [a, [['x.md', 'x.md'], ['old.md', 'new.md']]],
      [b, [[null, 'y.md'], ['z.md', null]]],
    ]));
  });

  it('reads cat-file’s batch, a missing one as none, and one not in UTF-8 as none', () => {
    const out = Buffer.from('1111 blob 6\nhé\nl\n\nx:y missing\n2222 blob 0\n\n');
    expect(parseBatch(out, 3)).toEqual(['hé\nl\n', null, '']);
    expect(parseBatch(Buffer.concat([Buffer.from('3333 blob 2\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]), 1)).toEqual([null]);
  });

  it('reads the log: its commits, who made them and is named on them, and which are merges', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const c = 'c'.repeat(40);
    const out = `${a}\x1f2026-01-10T10:00:00+02:00\x1fAna\x1fana@example.org\x1f\x1f${b}\x1e\n${b}\x1f2026-01-09T09:00:00+00:00\x1fKuraa host\x1fhost@kuraa.invalid\x1fBo <bo@example.org>\x1f${c} ${a}\x1e\n`;
    expect(parseLog(out)).toEqual([
      { id: a, date: '2026-01-10T10:00:00+02:00', author: { name: 'Ana', email: 'ana@example.org' }, coAuthors: [], merge: false },
      { id: b, date: '2026-01-09T09:00:00+00:00', author: { name: 'Kuraa host', email: 'host@kuraa.invalid' }, coAuthors: [{ name: 'Bo', email: 'bo@example.org' }], merge: true },
    ]);
  });

  it('reads co-authors from their trailers', () => {
    expect(coAuthors('Ana Lima <ana@example.org>\x1dBo <bo@example.org>')).toEqual([{ name: 'Ana Lima', email: 'ana@example.org' }, { name: 'Bo', email: 'bo@example.org' }]);
    expect(coAuthors('')).toEqual([]);
  });
});

describe('words by day on a host', () => {
  let dir: string;
  let running: RunningHost;
  const git = (env: Record<string, string>, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  const at = (date: string, name = 'Ana', email = 'ana@example.org') => ({
    GIT_AUTHOR_DATE: `${date}T10:00:00+02:00`, GIT_COMMITTER_DATE: `${date}T10:00:00+02:00`,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
  });
  const days = async (since: string) => ((await (await fetch(`${running.url}/api/features/words/days?since=${since}`, { headers: { authorization: `Bearer ${running.token}` } })).json()) as { days: unknown[] }).days;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-wordlog-'));
    git({}, 'init', '-q', '-b', 'main');
    git({}, 'config', 'user.name', 'Test Host');
    git({}, 'config', 'user.email', 'host@example.org');
    // Day one: Ana writes four words (and some code, not counted).
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\n---\n\nOne two three four.\n');
    writeFileSync(join(dir, 'code.R'), 'x <- 1 # many words here\n');
    git({}, 'add', '-A');
    git(at('2026-01-10'), 'commit', '-q', '-m', 'Start');
    // Day two: an automatic save names Ana and Bo: both credited with all of it (three words rewritten, two more).
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\n---\n\nOne two six seven eight nine.\n');
    git({}, 'add', '-A');
    git(at('2026-01-11', 'Kuraa host', 'host@kuraa.invalid'), 'commit', '-q', '-m', 'Edit A\n\nCo-authored-by: Ana <ana@example.org>\nCo-authored-by: Bo <bo@example.org>\nKuraa-Kind: autosave');
    // Day two, on a branch merged back: Bo's renaming (nothing written) and his new document; the merge itself counts nothing.
    git({}, 'checkout', '-q', '-b', 'side');
    git({}, 'mv', 'a.md', 'arrival.md');
    writeFileSync(join(dir, 'b.md'), 'Ten eleven.\n');
    git({}, 'add', '-A');
    git(at('2026-01-11', 'Bo', 'bo@example.org'), 'commit', '-q', '-m', 'Bo');
    git({}, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'notes.md'), 'Twelve.\n');
    git({}, 'add', '-A');
    git(at('2026-01-12'), 'commit', '-q', '-m', 'Notes');
    git(at('2026-01-12'), 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  });

  afterEach(async () => {
    await running?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts each commit but merges on its own day, for everyone credited on it, net and added', async () => {
    running = await startHost({ dir, timings: FAST, features: [wordsFeature] });
    expect(await days('2026-01-01')).toEqual([
      { date: '2026-01-12', people: [{ name: 'Ana', email: 'ana@example.org', net: 1, added: 1 }] },
      // Most written first.
      { date: '2026-01-11', people: [
        { name: 'Bo', email: 'bo@example.org', net: 4, added: 6 },
        { name: 'Ana', email: 'ana@example.org', net: 2, added: 4 },
      ] },
      { date: '2026-01-10', people: [{ name: 'Ana', email: 'ana@example.org', net: 4, added: 4 }] },
    ]);
    // From a day on; counted once (kept), the same again.
    expect(await days('2026-01-12')).toEqual([{ date: '2026-01-12', people: [{ name: 'Ana', email: 'ana@example.org', net: 1, added: 1 }] }]);
    expect((await fetch(`${running.url}/api/features/words/days?since=yesterday`, { headers: { authorization: `Bearer ${running.token}` } })).status).toBe(400);
    // What it counted is kept on this device, in its store (0121): in .git, never committed.
    expect(existsSync(join(dir, '.git/kuraa/features/words/commits.json'))).toBe(true);
    expect(git({}, 'status', '--porcelain')).toBe('');
  });

  it('counts what is typed in an open document and not committed yet, today, for whoever typed it (0121: edited)', async () => {
    running = await startHost({ dir, timings: { flushMs: 60_000, idleCommitMs: 60_000, maxCommitMs: 60_000, dropMs: 60_000 }, features: [wordsFeature] });
    const auth = { authorization: `Bearer ${running.token}` };
    const { room } = (await (await fetch(`${running.url}/api/rooms?path=notes.md`, { headers: auth })).json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: { name: 'Cy', email: 'cy@example.org', color: '#123456' }, schema: pandocMarkdown.schema });
    try {
      await c.ready;
      const doc = c.read();
      let pos = -1;
      doc.descendants((n, p) => {
        if (pos < 0 && n.isTextblock && n.textContent.includes('Twelve')) pos = p + 1;
        return pos < 0;
      });
      c.write(new Transform(doc).insert(pos, pandocMarkdown.schema.text('Seagrass and kelp ')).doc);
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let found: unknown[] = [];
      for (let i = 0; i < 50 && !found.length; i++) {
        found = await days(today);
        if (!found.length) await new Promise((r) => setTimeout(r, 100));
      }
      expect(found).toEqual([{ date: today, people: [{ name: 'Cy', email: 'cy@example.org', net: 3, added: 3 }] }]);
    } finally {
      c.destroy();
    }
  });
});
