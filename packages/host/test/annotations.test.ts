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
import { annotationsFeature, aboutOf, codeOf, readCodebook, readPage, textOf, writeCodebook, type Item } from '@kuraa/annotations';
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
  // What the host said, told where a wait times out (a failure on CI alone says why).
  const said: string[] = [];
  const start = async () => {
    said.length = 0;
    running = await startHost({ dir, timings: FAST, features: [annotationsFeature], log: (m: string) => said.push(m) });
  };
  const waitFor = (cond: () => boolean | Promise<boolean>, ms: number, what: string) =>
    until(cond, ms, what).catch((e: Error) => {
      throw new Error(`${e.message}. The host said:\n${said.join('\n') || '(nothing)'}\ngit status:\n${git(dir, 'status', '--porcelain') || '(clean)'}\nlast commit: ${git(dir, 'log', '-1', '--format=%s')}`);
    });

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

  it('codes: a codebook changed by whoever may, codings in your own file, counted and retrieved, merged and deleted without touching anyone’s', async () => {
    const post = async (body: object) => {
      const r = await api('/api/features/annotations/codebook', { method: 'POST', body: JSON.stringify({ body, by: ALICE }) });
      return { status: r.status, body: (await r.json()) as { id: string; error?: string } };
    };
    // Off until the workspace codes.
    expect((await post({ op: 'add', label: 'Trust' })).status).toBe(409);
    expect((await api('/api/features/annotations', { method: 'PATCH', body: JSON.stringify({ settings: { coding: true }, by: ALICE }) })).status).toBe(200);
    const institutions = (await post({ op: 'add', label: 'Institutions' })).body.id;
    const council = (await post({ op: 'add', label: 'Council', broader: institutions })).body.id;
    const govt = (await post({ op: 'add', label: 'Govt' })).body.id;
    const spare = (await post({ op: 'add', label: 'Spare' })).body.id;
    expect((await post({ op: 'change', id: institutions, broader: council })).status).toBe(400);
    expect((await post({ op: 'change', id: council, definition: 'The town council', color: '#123456' })).status).toBe(200);
    let book = readCodebook(file('.kuraa/codebook.jsonld'));
    expect(book.codes.find((c) => c.id === council)).toMatchObject({ label: 'Council', definition: 'The town council', color: '#123456', broader: institutions });
    expect(git(dir, 'log', '-1', '--format=%s')).toMatch(/codebook\.jsonld/);

    // Two passages coded, one with Govt.
    const a = await connect();
    const f = a.feature('annotations', ME);
    const code = (id: string, codeId: string, phrase: string) => {
      const at = where(a.read(), phrase);
      const item: Item = { ...comment('commenting', id, '', { source: '../notes.md', selector: [] }), motivation: 'classifying', body: { type: 'SpecificResource', source: codeId, purpose: 'classifying' } };
      f.update({ set: { [id]: { item, from: f.anchorAt(at, 1), to: f.anchorAt(at + phrase.length, -1) } } });
    };
    code('urn:uuid:k1', council, 'the council');
    code('urn:uuid:k2', govt, 'Nobody came');
    await until(() => readPage(file(OWN)).length === 2 && git(dir, 'status', '--porcelain') === '', 10_000, 'the codings committed');
    const k1 = readPage(file(OWN)).find((i) => i.id === 'urn:uuid:k1')!;
    expect(k1).toMatchObject({ motivation: 'classifying', body: { type: 'SpecificResource', source: council, purpose: 'classifying' } });
    expect((aboutOf(k1) as { exact: string }).exact).toBe('the council');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Field notes: 2 codings added (Alice Ng)');

    // Counted, and retrieved with the codes under one.
    const json = async (p: string) => (await (await api(p)).json()) as never;
    expect(await json('/api/features/annotations/counts')).toEqual({ [council]: 1, [govt]: 1 });
    const under = (await json(`/api/features/annotations/retrieve?code=${encodeURIComponent(institutions)}&below=1`)) as { id: string; at: { from: number; to: number } }[];
    expect(under.map((r) => r.id)).toEqual(['urn:uuid:k1']);
    expect(NOTES.slice(under[0]!.at.from, under[0]!.at.to)).toBe('the council');
    expect(await json(`/api/features/annotations/retrieve?code=${encodeURIComponent(institutions)}&below=0`)).toEqual([]);
    // Codings are not comments: the newest comments leave them out.
    expect(await json('/api/features/annotations/recent')).toEqual([]);

    // Govt merged into Council: its codings count as Council's, and nobody's file is rewritten.
    const before = file(OWN);
    expect((await post({ op: 'merge', id: govt, into: council })).status).toBe(200);
    expect(await json('/api/features/annotations/counts')).toEqual({ [council]: 2 });
    expect(file(OWN)).toBe(before);
    expect(codeOf(readPage(file(OWN)).find((i) => i.id === 'urn:uuid:k2')!)).toBe(govt);
    // Deleting a code keeps it, marked deleted (OWL's deprecated): a coding of it, someone's own, still says what it was.
    expect((await post({ op: 'delete', id: council })).status).toBe(200);
    expect((await post({ op: 'delete', id: spare })).status).toBe(200);
    book = readCodebook(file('.kuraa/codebook.jsonld'));
    expect(book.codes.find((c) => c.id === council)).toMatchObject({ deleted: true });
    expect(book.codes.find((c) => c.id === spare)).toMatchObject({ label: 'Spare', deleted: true });
    expect(textOf(k1)).toBe('');
  });

  it('moves a codebook at the top into .kuraa, its history with it; one made at the top again, merged in', async () => {
    const top = (labels: string[]) => writeCodebook({ scheme: 'urn:uuid:s', label: 'Codebook', codes: labels.map((l) => ({ id: `urn:uuid:${l}`, label: l })) });
    await running.close();
    writeFileSync(join(dir, 'codebook.jsonld'), top(['Trust']));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'A codebook, as 0.6.0 kept it');
    await start();
    await waitFor(() => file('codebook.jsonld') === null && file('.kuraa/codebook.jsonld') !== null && git(dir, 'status', '--porcelain') === '', 10_000, 'the codebook moved');
    expect(file('.kuraa/codebook.jsonld')).toBe(top(['Trust']));
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Move codebook.jsonld to .kuraa/codebook.jsonld');
    // One commit, a rename: its history follows it.
    expect(git(dir, 'log', '--follow', '--format=%s', '--', '.kuraa/codebook.jsonld').split('\n')).toContain('A codebook, as 0.6.0 kept it');
    const json = async (p: string) => (await (await api(p)).json()) as { path: string; book: { codes: { label: string }[] } };
    expect((await json('/api/features/annotations/codebook')).path).toBe('.kuraa/codebook.jsonld');

    // A device on 0.6.0 makes one at the top again: its codes join those in .kuraa.
    await running.close();
    writeFileSync(join(dir, 'codebook.jsonld'), top(['Fear']));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'From 0.6.0');
    await start();
    await waitFor(() => file('codebook.jsonld') === null && git(dir, 'status', '--porcelain') === '', 10_000, 'the top one merged in');
    expect(readCodebook(file('.kuraa/codebook.jsonld')).codes.map((c) => c.label).sort()).toEqual(['Fear', 'Trust']);
  });

  it('codes a point (# at the caret): no quote, its start its end, kept beside what is before it and found again', async () => {
    let a = await connect();
    let f = a.feature('annotations', ME);
    const at = where(a.read(), 'Nobody came') - 1;
    const item: Item = { ...comment('commenting', 'urn:uuid:p1', '', { source: '../notes.md', selector: [{ type: 'TextQuoteSelector', exact: '' }] }), motivation: 'classifying', body: { type: 'SpecificResource', source: 'urn:uuid:code', purpose: 'classifying' } };
    f.update({ set: { 'urn:uuid:p1': { item, from: f.anchorAt(at, -1), to: f.anchorAt(at, -1) } } });
    await until(() => readPage(file(OWN)).length === 1 && git(dir, 'status', '--porcelain') === '', 10_000, 'the point coded');
    const about = aboutOf(readPage(file(OWN))[0]!) as { exact: string; prefix: string; suffix: string; start: number; end: number };
    expect(about).toMatchObject({ exact: '', start: about.end });
    expect(about.prefix.endsWith('the council.')).toBe(true);
    expect(about.suffix.startsWith(' Nobody came')).toBe(true);
    expect(about.start).toBe([...NOTES.slice(0, NOTES.indexOf(' Nobody came'))].length);

    // Typed at the point: the point stays after what was before it.
    a.destroy();
    clients.length = 0;
    await running.close();
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('# Day one\n', '# Day one\n\nA line before it all.\n'));
    git(dir, 'commit', '-qam', 'Outside');
    await start();
    a = await connect();
    f = a.feature('annotations', ME);
    const e = f.entries() as Record<string, { from?: unknown; to?: unknown; lost?: boolean }>;
    expect(e['urn:uuid:p1']!.lost).toBeUndefined();
    const pos = f.positionOf(e['urn:uuid:p1']!.from as never)!;
    expect(f.positionOf(e['urn:uuid:p1']!.to as never)).toBe(pos);
    expect(a.read().textBetween(pos - 'the council.'.length, pos)).toBe('the council.');
    expect(a.read().textBetween(pos, pos + ' Nobody'.length)).toBe(' Nobody');
  });

  it('keeps a codebook the workspace names where it is', async () => {
    await running.close();
    writeFileSync(join(dir, 'codebook.jsonld'), writeCodebook({ scheme: 'urn:uuid:s', label: 'Codebook', codes: [{ id: 'urn:uuid:a', label: 'Trust' }] }));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'A codebook at the top, named in the settings');
    const features = JSON.parse(file('.kuraa/features.json')!);
    features.annotations = { ...features.annotations, coding: true, codebook: 'codebook.jsonld' };
    writeFileSync(join(dir, '.kuraa/features.json'), JSON.stringify(features, null, 2) + '\n');
    git(dir, 'commit', '-qam', 'Named');
    await start();
    const r = (await (await api('/api/features/annotations/codebook')).json()) as { path: string; book: { codes: { label: string }[] } };
    expect(r.path).toBe('codebook.jsonld');
    expect(r.book.codes.map((c) => c.label)).toEqual(['Trust']);
    await new Promise((res) => setTimeout(res, 500));
    expect(file('codebook.jsonld')).not.toBeNull();
    expect(file('.kuraa/codebook.jsonld')).toBeNull();
  });
});
