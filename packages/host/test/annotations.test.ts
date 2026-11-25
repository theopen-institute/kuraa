// Annotations, step 2 (docs/decisions/0082-annotations.md): comments and replies, through a real host,
// kept in each person's own file beside the document, as a W3C AnnotationPage.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { annotationsFeature, aboutOf, readPage, textOf, type Item } from '@kuraa/annotations';
import { startHost, type RunningHost } from '../src/index.js';
import { createPerson } from '../src/peers/person.js';

const NOTES = `---
title: Field notes
---

# Day one

After the flood 🌊, I never trusted the council. Nobody came for us.

## Day two

Light rain all morning.
`;
const ALICE = { name: 'Alice Ng', email: 'alice@example.org', color: '#d33' };
const FAST = { flushMs: 150, idleCommitMs: 500, maxCommitMs: 5000, dropMs: 400 };
const schema = pandocMarkdown.schema;
let ME = '';
let OWN = '';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
function where(doc: PMNode, phrase: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(phrase)) at = pos + n.text!.indexOf(phrase);
    return at < 0;
  });
  if (at < 0) throw new Error(`not found: ${phrase}`);
  return at;
}
const comment = (motivation: 'commenting' | 'replying', id: string, value: string, target: Item['target']): Item => ({
  id, type: 'Annotation', motivation, created: new Date().toISOString(), modified: new Date().toISOString(),
  creator: { id: `urn:kuraa:person:${ME}`, type: 'Person', name: 'Alice Ng' },
  body: { type: 'TextualBody', value, format: 'text/markdown', purpose: motivation }, target,
});

beforeAll(async () => {
  process.env.KURAA_PERSON = join(mkdtempSync(join(tmpdir(), 'kuraa-annotations-person-')), 'person.json');
  ME = (await createPerson('Alice Ng')).id;
  OWN = `notes.md.annotations/@${ME}.jsonld`;
});

describe('comments', () => {
  let dir: string;
  let running: RunningHost;
  const clients: HeadlessClient[] = [];
  const api = (path: string, init: RequestInit = {}) => fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
  const connect = async () => {
    const { room } = (await (await api('/api/rooms?path=notes.md')).json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: ALICE, schema });
    clients.push(c);
    await c.ready;
    return c;
  };
  const file = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : null);
  const start = async () => {
    running = await startHost({ dir, timings: FAST, features: [annotationsFeature] });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-annotations-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.org');
    writeFileSync(join(dir, 'notes.md'), NOTES);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    await start();
    expect((await api('/api/features/annotations', { method: 'PATCH', body: JSON.stringify({ on: true, by: ALICE }) })).status).toBe(200);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a comment on a passage in your own file, as a W3C annotation naming the passage by quote and code points', async () => {
    const a = await connect();
    const f = a.feature('annotations', ME);
    const at = where(a.read(), 'I never trusted');
    const item = comment('commenting', 'urn:uuid:c1', 'Which council?', { source: '../notes.md', selector: [] });
    f.update({ set: { 'urn:uuid:c1': { item, from: f.anchorAt(at, 1), to: f.anchorAt(at + 'I never trusted the council'.length, -1) } } });
    await until(() => readPage(file(OWN)).length === 1 && git(dir, 'status', '--porcelain') === '', 10_000, 'the comment committed');
    const page = JSON.parse(file(OWN)!);
    expect(page).toMatchObject({ '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'AnnotationPage', id: `@${ME}.jsonld` });
    const [c] = page.items as Item[];
    expect(c).toMatchObject({ id: 'urn:uuid:c1', motivation: 'commenting', body: { type: 'TextualBody', value: 'Which council?' } });
    expect(c!.target).toMatchObject({ source: '../notes.md' });
    const about = aboutOf(c!) as { exact: string; start: number; end: number; prefix: string };
    expect(about.exact).toBe('I never trusted the council');
    expect(about.prefix.endsWith('🌊, ')).toBe(true);
    // In code points: the wave is one, though JavaScript counts it as two.
    expect(about.start).toBe([...NOTES.slice(0, NOTES.indexOf('I never trusted'))].length);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Field notes: 1 comment added (Alice Ng)');
    // The document itself never changes.
    expect(file('notes.md')).toBe(NOTES);
  });

  it('keeps replies and comments on the document; the newest show across the workspace', async () => {
    const a = await connect();
    const f = a.feature('annotations', ME);
    const at = where(a.read(), 'Light rain');
    f.update({ set: { 'urn:uuid:c1': { item: comment('commenting', 'urn:uuid:c1', 'Rain again', { source: '../notes.md', selector: [] }), from: f.anchorAt(at, 1), to: f.anchorAt(at + 10, -1) } } });
    f.update({ set: { 'urn:uuid:c2': { item: comment('commenting', 'urn:uuid:c2', 'A good day’s notes', '../notes.md') } } });
    f.update({ set: { 'urn:uuid:r1': { item: comment('replying', 'urn:uuid:r1', 'It always rains', 'urn:uuid:c1') } } });
    await until(() => readPage(file(OWN)).length === 3, 10_000, 'all three written');
    const items = new Map(readPage(file(OWN)).map((i) => [i.id, i]));
    expect(items.get('urn:uuid:c2')!.target).toBe('../notes.md');
    expect(aboutOf(items.get('urn:uuid:r1')!)).toEqual({ kind: 'annotation', id: 'urn:uuid:c1' });
    await until(() => git(dir, 'status', '--porcelain') === '', 10_000, 'committed');
    const recent = (await (await api('/api/features/annotations/recent')).json()) as { path: string; id: string; text: string; at: { from: number; to: number } | null }[];
    expect(recent.map((r) => r.id).sort()).toEqual(['urn:uuid:c1', 'urn:uuid:c2', 'urn:uuid:r1']);
    const rain = recent.find((r) => r.id === 'urn:uuid:c1')!;
    expect(NOTES.slice(rain.at!.from, rain.at!.to)).toBe('Light rain');
  });

  it('finds passages again when the document changed outside the app, and keeps those no longer found', async () => {
    let a = await connect();
    let f = a.feature('annotations', ME);
    const at = where(a.read(), 'Nobody came');
    f.update({ set: { 'urn:uuid:c1': { item: comment('commenting', 'urn:uuid:c1', 'Who?', { source: '../notes.md', selector: [] }), from: f.anchorAt(at, 1), to: f.anchorAt(at + 'Nobody came'.length, -1) } } });
    const day2 = where(a.read(), 'Light rain');
    f.update({ set: { 'urn:uuid:c2': { item: comment('commenting', 'urn:uuid:c2', 'Rain', { source: '../notes.md', selector: [] }), from: f.anchorAt(day2, 1), to: f.anchorAt(day2 + 10, -1) } } });
    await until(() => readPage(file(OWN)).length === 2 && git(dir, 'status', '--porcelain') === '', 10_000, 'committed');
    a.destroy();
    clients.length = 0;
    await running.close();
    // Outside the app: a paragraph before the passage, and the rain gone.
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('# Day one\n', '# Day one\n\nAdded first.\n').replace('Light rain all morning.', 'Sun.'));
    git(dir, 'commit', '-qam', 'Outside');
    await start();
    a = await connect();
    f = a.feature('annotations', ME);
    const e = f.entries() as Record<string, { from?: unknown; lost?: boolean; item: Item }>;
    const from = f.positionOf(e['urn:uuid:c1']!.from as never)!;
    expect(a.read().textBetween(from, from + 'Nobody came'.length)).toBe('Nobody came');
    expect(e['urn:uuid:c2']).toMatchObject({ lost: true });
    expect(textOf(e['urn:uuid:c2']!.item)).toBe('Rain');
  });
});
