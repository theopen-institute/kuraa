// Features (docs/decisions/0082-annotations.md), through a real host: loading, on
// and off at the host and the workspace, companions kept with their documents,
// rooms' state seeded from them and written back with the document, events,
// routes. The example feature (marks) is what drives them.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless, featureUpdate, type HeadlessClient } from '@kuraa/session/testing';
import { defineFeature, type FeatureEvents, type HostFeature } from '@kuraa/feature-kit/host';
import { marksFeature, readMarks } from '@kuraa/feature-example';
import { startHost, type RunningHost } from '../src/index.js';
import { checkFeatures } from '../src/features.js';
import { createPerson } from '../src/peers/person.js';

const NOTES = `---
title: Field notes
---

# Day one

The tide was already on the turn when we arrived.

Mateus recalibrated the *refractometer* before lunch.

## Day two

Light rain all morning.
`;
const ALICE = { name: 'Alice Ng', email: 'alice@example.org', color: '#d33' };
const BOB = { name: 'Bob Ferreira', email: 'bob@example.org', color: '#33d' };
const FAST = { flushMs: 150, idleCommitMs: 500, maxCommitMs: 5000, dropMs: 400 };
const schema = pandocMarkdown.schema;
/** This test's person (a key of its own, in this process): whose own files are written. */
let ME = '';
let COMPANION = '';
const BO = 'b'.repeat(64);

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-features-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Host');
  git(dir, 'config', 'user.email', 'host@example.org');
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Where a phrase starts in a document, as a position. */
function where(doc: PMNode, phrase: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(phrase)) at = pos + n.text!.indexOf(phrase);
    return at < 0;
  });
  if (at < 0) throw new Error(`not found: ${phrase}`);
  return at;
}

/** A spy feature: what it is told, in order. */
function spyFeature(seen: { event: string; payload: unknown }[]): HostFeature {
  return defineFeature({
    id: 'spy',
    label: 'Spy',
    files: () => ['spy.json', '.kuraa/spy.json'],
    open(ctx) {
      for (const e of ['open', 'save', 'commit', 'merge', 'rename', 'delete', 'settings'] as (keyof FeatureEvents)[]) {
        ctx.on(e, (payload) => void seen.push({ event: e, payload }));
      }
      return {
        routes: [
          { method: 'GET', path: 'hello', handle: ({ query }) => ({ body: { hello: query.get('who') } }) },
          {
            method: 'POST',
            path: 'move',
            handle: async ({ body }) => {
              const { from, to } = body as { from: string; to: string };
              await ctx.move(from, to);
              return { body: { moved: true } };
            },
          },
        ],
      };
    },
  });
}

beforeAll(async () => {
  process.env.KURAA_PERSON = join(mkdtempSync(join(tmpdir(), 'kuraa-features-person-')), 'person.json');
  ME = (await createPerson('Alice Ng')).id;
  COMPANION = `notes.md.marks/@${ME}.json`;
});

describe('features', () => {
  let dir: string;
  let running: RunningHost;
  const clients: HeadlessClient[] = [];
  const seen: { event: string; payload: unknown }[] = [];

  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const json = async (path: string, init: RequestInit = {}) => {
    const r = await api(path, init);
    return { status: r.status, body: (await r.json()) as never };
  };
  const turn = (id: string, on: boolean, settings?: object) => json(`/api/features/${id}`, { method: 'PATCH', body: JSON.stringify({ on, settings, by: ALICE }) });
  const connect = async (path: string, user = ALICE) => {
    const { room } = (await (await api(`/api/rooms?path=${encodeURIComponent(path)}`)).json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user, schema });
    clients.push(c);
    await c.ready;
    return c;
  };
  const file = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
  const start = async (o: { featuresOn?: string[] } = {}) => {
    running = await startHost({ dir, timings: FAST, features: [marksFeature, spyFeature(seen)], ...o });
  };
  /** Mark a phrase in an open document, as a client's editor would. */
  const mark = (c: HeadlessClient, id: string, phrase: string, by = ALICE) => {
    const doc = c.read();
    const from = where(doc, phrase);
    const f = c.feature('marks', ME);
    f.update({ set: { [id]: { from: f.anchorAt(from, 1), to: f.anchorAt(from + phrase.length, -1), quote: phrase, by: by.name, color: by.color } } });
  };

  beforeEach(async () => {
    dir = makeRepo();
    seen.length = 0;
    await start();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a feature that does not keep to the contract', () => {
    expect(() => checkFeatures([{ id: 'x' }])).toThrow(/defineFeature/);
    expect(() => checkFeatures([{ ...marksFeature, apiVersion: 99 }])).toThrow(/version 99/);
    expect(() => checkFeatures([marksFeature, marksFeature])).toThrow(/Two features/);
    expect(() => checkFeatures([{ ...marksFeature, id: 'Bad Id' }])).toThrow(/id/);
    expect(() => checkFeatures([{ ...marksFeature, companions: ['marks'] }])).toThrow(/suffix/);
    expect(() => checkFeatures([{ ...marksFeature, room: { ...marksFeature.room!, extension: 'json' } }])).toThrow(/extension/);
    expect(() => checkFeatures([{ ...marksFeature, room: { ...marksFeature.room!, companion: '.other' } }])).toThrow(/not one of its companions/);
  });

  it('is off for a workspace until it is turned on there, which is committed for everyone', async () => {
    const before = (await json('/api/features')).body as { features: { id: string; on: boolean; host: boolean; workspace: boolean; mayChange: boolean }[] };
    expect(before.features.find((f) => f.id === 'marks')).toMatchObject({ on: false, host: true, workspace: false, mayChange: true });
    // Its routes are not there while it is off.
    expect((await api('/api/features/marks/all')).status).toBe(409);

    const r = await turn('marks', true, { label: '*' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'marks', on: true, settings: { label: '*' } });
    expect(JSON.parse(file('.kuraa/features.json')!)).toEqual({ marks: { label: '*', on: true } });
    expect(JSON.parse(file('.kuraa/companions.json')!)).toEqual({ suffixes: ['.marks'] });
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toMatch(/^Turn on Marks \(example\)[\s\S]*Co-authored-by: Alice Ng/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // Its settings changed, and it was told so.
    await turn('marks', true, { label: '+' });
    // A setting called "on" is not one.
    expect((await turn('marks', true, { on: false })).status).toBe(400);
    // Turned off: written so, the companions' suffixes still recorded (their files stay with their documents).
    await turn('marks', false);
    expect(JSON.parse(file('.kuraa/features.json')!)).toEqual({ marks: { label: '+' } });
    expect(JSON.parse(file('.kuraa/companions.json')!)).toEqual({ suffixes: ['.marks'] });
  });

  it('is on by default where it says so, until the workspace turns it off, which is written as off (0087)', async () => {
    await running.close();
    running = await startHost({ dir, timings: FAST, features: [{ ...marksFeature, onByDefault: true }, spyFeature(seen)] });
    type S = { features: { id: string; on: boolean; workspace: boolean }[] };
    expect(((await json('/api/features')).body as S).features.find((f) => f.id === 'marks')).toMatchObject({ on: true, workspace: true });
    expect(file('.kuraa/features.json')).toBeNull();
    // Off: said so, as the default is on.
    await turn('marks', false);
    expect(JSON.parse(file('.kuraa/features.json')!)).toEqual({ marks: { on: false } });
    expect(((await json('/api/features')).body as S).features.find((f) => f.id === 'marks')).toMatchObject({ on: false, workspace: false });
    // On again: the default, so nothing is said.
    await turn('marks', true);
    expect(JSON.parse(file('.kuraa/features.json')!)).toEqual({});
    expect(((await json('/api/features')).body as S).features.find((f) => f.id === 'marks')).toMatchObject({ on: true });
  });

  it('is off where the host has it off, whatever the workspace says', async () => {
    await turn('marks', true);
    await running.close();
    await start({ featuresOn: ['spy'] });
    const s = (await json('/api/features')).body as { features: { id: string; on: boolean; host: boolean; workspace: boolean }[] };
    expect(s.features.find((f) => f.id === 'marks')).toMatchObject({ on: false, host: false, workspace: true });
    expect((await api('/api/features/marks/all')).status).toBe(409);
  });

  it('keeps marks in the room, written beside the document into the same commit, moving as people type', async () => {
    await turn('marks', true);
    const a = await connect('notes.md', ALICE);
    mark(a, 'm1', 'refractometer');
    await until(() => !!file(COMPANION), 10_000, 'the companion');
    let marks = readMarks(file(COMPANION));
    expect(marks).toEqual([{ id: 'm1', start: NOTES.indexOf('refractometer'), end: NOTES.indexOf('refractometer') + 13, quote: 'refractometer', by: ALICE.name, color: ALICE.color }]);
    // Committed, the companion with it, saying what changed.
    await until(() => git(dir, 'log', '-1', '--format=%s').includes('mark'), 10_000, 'the commit');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Field notes: 1 mark added (Alice Ng)');
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual([COMPANION]);

    // Someone types before it: its place moves, its text is the same, and the document and companion are committed together.
    const b = await connect('notes.md', BOB);
    await until(() => Object.keys(b.feature('marks', ME).entries()).length === 1, 5000, 'the mark in the other client');
    b.write(new Transform(b.read()).insert(where(b.read(), 'Mateus'), schema.text('Then ')).doc);
    await until(() => (file('notes.md') ?? '').includes('Then Mateus') && readMarks(file(COMPANION))[0]!.start !== marks[0]!.start, 10_000, 'the mark moved');
    const text = file('notes.md')!;
    marks = readMarks(file(COMPANION));
    expect(text.slice(marks[0]!.start!, marks[0]!.end!)).toBe('refractometer');
    await until(() => git(dir, 'status', '--porcelain') === '', 10_000, 'everything committed');
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['notes.md', COMPANION].sort());

    // Removed: the companion goes when no marks are left.
    a.feature('marks', ME).update({ remove: ['m1'] });
    await until(() => file(COMPANION) === null, 10_000, 'the companion removed');
    await until(() => git(dir, 'status', '--porcelain') === '', 10_000, 'the removal committed');
    // (Credited to Alice where her change came after any commit already under way: commitNow clears contributors added meanwhile.)
    expect(git(dir, 'log', '-1', '--format=%s')).toMatch(/^Field notes: 1 mark removed/);
  });

  it('starts a room from the companion, finding marks again after the document changed outside the app, keeping lost ones', async () => {
    await turn('marks', true);
    mkdirSync(join(dir, 'notes.md.marks'), { recursive: true });
    writeFileSync(join(dir, COMPANION), JSON.stringify({ marks: [
      { id: 'm1', start: NOTES.indexOf('tide'), end: NOTES.indexOf('tide') + 4, quote: 'tide', by: 'X', color: '#000' },
      { id: 'm2', start: 3, end: 9, quote: 'no such words', by: 'X', color: '#000' },
    ] }));
    // The document changed outside the app: the marked words are further on.
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('# Day one', '# Day one\n\nAn added paragraph.'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Outside');
    const a = await connect('notes.md');
    const e = a.feature('marks', ME).entries() as Record<string, { from?: unknown; lost?: boolean }>;
    expect(e.m2).toMatchObject({ lost: true, quote: 'no such words' });
    const from = a.feature('marks', ME).positionOf(e.m1!.from as never)!;
    expect(a.read().textBetween(from, from + 4)).toBe('tide');
    // The next save writes it where it is now, and keeps the lost one.
    mark(a, 'm3', 'Light rain');
    await until(() => readMarks(file(COMPANION)).length === 3, 10_000, 'the companion written');
    const text = file('notes.md')!;
    const marks = Object.fromEntries(readMarks(file(COMPANION)).map((m) => [m.id, m]));
    expect(text.slice(marks.m1!.start!, marks.m1!.end!)).toBe('tide');
    expect(marks.m2).toMatchObject({ start: 3, end: 9, quote: 'no such words' });
  });

  it('seeds rooms already open when it is turned on, and leaves companions alone while it is off', async () => {
    mkdirSync(join(dir, 'notes.md.marks'), { recursive: true });
    writeFileSync(join(dir, COMPANION), JSON.stringify({ marks: [{ id: 'm1', start: null, end: null, quote: 'tide', by: 'X', color: '#000' }] }));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Marks from before');
    const a = await connect('notes.md');
    // Off: nothing in the room, and nothing it does touches the companion.
    expect(a.feature('marks', ME).entries()).toEqual({});
    a.write(new Transform(a.read()).insert(where(a.read(), 'Light'), schema.text('Some ')).doc);
    await until(() => (file('notes.md') ?? '').includes('Some Light'), 10_000, 'the edit written');
    expect(readMarks(file(COMPANION))).toHaveLength(1);
    // On: the open room gets the companion's marks, found again.
    await turn('marks', true);
    await until(() => Object.keys(a.feature('marks', ME).entries()).length === 1, 10_000, 'the room seeded');
    mark(a, 'm2', 'Some Light');
    await until(() => readMarks(file(COMPANION)).length === 2, 10_000, 'both written');
    const m1 = readMarks(file(COMPANION)).find((m) => m.id === 'm1')!;
    expect(file('notes.md')!.slice(m1.start!, m1.end!)).toBe('tide');
  });

  it('moves everyone’s files beside a document with it, deletes only your own with it, and the file list shows them with it', async () => {
    await turn('marks', true);
    await turn('spy', true);
    // Bo's marks, made on his own computer, here by git.
    mkdirSync(join(dir, 'notes.md.marks'), { recursive: true });
    writeFileSync(join(dir, `notes.md.marks/@${BO}.json`), JSON.stringify({ marks: [{ id: 'b1', start: null, end: null, quote: 'rain', by: 'Bo', color: '#00f' }] }));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Bo’s marks');
    const a = await connect('notes.md');
    mark(a, 'm1', 'tide');
    await until(() => !!file(COMPANION) && git(dir, 'status', '--porcelain') === '', 10_000, 'your file committed');
    // Bo's, from his file (no device of his in the room), are not in the room: only yours are.
    expect(a.feature('marks', ME).people()).toEqual([ME]);
    a.destroy();
    const tree = (await json('/api/tree')).body as { files: { path: string; of?: string }[] };
    expect(tree.files.find((f) => f.path === COMPANION)).toMatchObject({ of: 'notes.md' });
    expect(tree.files.find((f) => f.path === `notes.md.marks/@${BO}.json`)).toMatchObject({ of: 'notes.md' });
    const all = (await json('/api/companions?path=notes.md&suffix=.marks')).body as { companions: { person: string }[] };
    expect(all.companions.map((c) => c.person).sort()).toEqual([ME, BO].sort());

    const r = await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'notes.md', to: 'field/notes.md' }) });
    expect(r.status).toBe(200);
    expect(existsSync(join(dir, 'notes.md.marks'))).toBe(false);
    expect(readMarks(file(`field/notes.md.marks/@${ME}.json`))).toHaveLength(1);
    expect(readMarks(file(`field/notes.md.marks/@${BO}.json`))).toHaveLength(1);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n').map((l) => l.split('\t')[0])).toEqual(['R100', 'R100', 'R100']);
    await until(() => seen.some((s) => s.event === 'rename'), 5000, 'the rename told');
    expect(seen.find((s) => s.event === 'rename')!.payload).toEqual({ from: 'notes.md', to: 'field/notes.md', folder: false });

    // Deleted: your own go with it; Bo's are his, and stay, shown on their own.
    expect((await api(`/api/files?path=${encodeURIComponent('field/notes.md')}`, { method: 'DELETE' })).status).toBe(200);
    expect(file(`field/notes.md.marks/@${ME}.json`)).toBeNull();
    expect(readMarks(file(`field/notes.md.marks/@${BO}.json`))).toHaveLength(1);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const after = (await json('/api/tree')).body as { files: { path: string; of?: string }[] };
    expect(after.files.find((f) => f.path === `field/notes.md.marks/@${BO}.json`)?.of).toBeUndefined();
    await until(() => seen.some((s) => s.event === 'delete'), 5000, 'the delete told');
  });

  it('routes to its own, writes only its own files, and never one a room is keeping', async () => {
    await turn('marks', true);
    await turn('spy', true);
    expect((await json('/api/features/spy/hello?who=you')).body).toEqual({ hello: 'you' });
    expect((await api('/api/features/spy/nothing')).status).toBe(404);
    expect((await api('/api/features/nobody/x')).status).toBe(404);

    const a = await connect('notes.md');
    mark(a, 'm1', 'tide');
    await until(() => !!file(COMPANION) && git(dir, 'status', '--porcelain') === '', 10_000, 'the companion committed');
    const all = (await json('/api/features/marks/all')).body as { path: string; marks: unknown[] }[];
    expect(all).toEqual([{ path: 'notes.md', person: ME, marks: [expect.objectContaining({ id: 'm1', quote: 'tide' })] }]);
    // Open in a room: its companion is the room's to write.
    const clear = () => json('/api/features/marks/clear', { method: 'POST', body: JSON.stringify({ body: { path: 'notes.md' }, by: ALICE }) });
    expect((await clear()).status).toBe(409);
    a.destroy();
    clients.length = 0;
    await running.close();
    await start();
    expect((await clear()).status).toBe(200);
    expect(file(COMPANION)).toBeNull();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('1 mark removed');
    // Search leaves companions out.
    mkdirSync(join(dir, 'other.md.marks'), { recursive: true });
    writeFileSync(join(dir, `other.md.marks/@${ME}.json`), '{"marks": []} tide');
    const found = (await json('/api/search?q=tide')).body as { files: { path: string }[] };
    expect(found.files.map((f) => f.path)).toEqual(['notes.md']);
  });

  it('moves a file it keeps to another it keeps, in one commit, and nothing else', async () => {
    await turn('spy', true);
    const move = (from: string, to: string) => api('/api/features/spy/move', { method: 'POST', body: JSON.stringify({ body: { from, to }, by: ALICE }) }).then((r) => r.status);
    expect(await move('spy.json', '.kuraa/spy.json')).toBe(404);
    writeFileSync(join(dir, 'spy.json'), '{"kept": true}\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Spy');
    // Not its own: a document, or a companion (which moves only with its document).
    expect(await move('notes.md', '.kuraa/spy.json')).toBe(403);
    expect(await move('spy.json', 'elsewhere.json')).toBe(403);
    expect(await move('spy.json', COMPANION)).toBe(403);
    expect(await move('spy.json', '.kuraa/spy.json')).toBe(200);
    expect(file('spy.json')).toBeNull();
    expect(file('.kuraa/spy.json')).toBe('{"kept": true}\n');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Move spy.json to .kuraa/spy.json');
    expect(git(dir, 'show', '--format=', '--name-status', '-M', 'HEAD')).toMatch(/^R100\tspy\.json\t\.kuraa\/spy\.json$/);
    // Something there already: not moved over it.
    writeFileSync(join(dir, 'spy.json'), '{"again": true}\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Spy again');
    expect(await move('spy.json', '.kuraa/spy.json')).toBe(409);
    expect(file('.kuraa/spy.json')).toBe('{"kept": true}\n');
  });

  it('writes into your file only what you did: what a sync put in your map is shown, never signed as yours', async () => {
    await turn('marks', true);
    const { room } = (await (await api(`/api/rooms?path=notes.md`)).json()) as { room: string };
    const a = await connect('notes.md');
    mark(a, 'm1', 'tide');
    await until(() => readMarks(file(COMPANION)).length === 1, 10_000, 'your mark written');
    // Another device passes on a sync that puts a mark in your map (one it may not make).
    const relay = running.host.sessionRelay;
    const fake = featureUpdate(relay.state(room)!, 'marks', ME, { fake: { lost: true, start: 0, end: 3, quote: 'not mine', by: 'Mallory', color: '#000' } });
    relay.applyPeerUpdate(room, fake, 'f'.repeat(64), null, { sync: true });
    await until(() => 'fake' in a.feature('marks', ME).entries(), 5000, 'the sync in the room');
    // Your next mark: written with yours, not with what the sync put there.
    mark(a, 'm2', 'Light rain');
    await until(() => readMarks(file(COMPANION)).length === 2, 10_000, 'your second mark written');
    expect(readMarks(file(COMPANION)).map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('deletes a folder but others’ own files in it, which stay theirs', async () => {
    await turn('marks', true);
    mkdirSync(join(dir, 'field/notes.md.marks'), { recursive: true });
    writeFileSync(join(dir, 'field/notes.md'), NOTES);
    writeFileSync(join(dir, `field/notes.md.marks/@${BO}.json`), JSON.stringify({ marks: [] }));
    writeFileSync(join(dir, `field/notes.md.marks/@${ME}.json`), JSON.stringify({ marks: [] }));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'A folder');
    expect((await api(`/api/files?path=field`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(dir, 'field/notes.md'))).toBe(false);
    expect(existsSync(join(dir, `field/notes.md.marks/@${ME}.json`))).toBe(false);
    expect(existsSync(join(dir, `field/notes.md.marks/@${BO}.json`))).toBe(true);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('tells features what happened, after it happened', async () => {
    await turn('spy', true);
    await turn('marks', true);
    const a = await connect('notes.md');
    a.write(new Transform(a.read()).insert(where(a.read(), 'Light'), schema.text('Soft ')).doc);
    // Its own events: a host closed by the test before may still be saying its last.
    const saved = () => seen.find((s) => s.event === 'save' && (s.payload as { text: string }).text.includes('Soft Light'));
    await until(() => !!saved() && seen.some((s) => s.event === 'commit' && (s.payload as { paths: string[] }).paths.includes('notes.md')), 10_000, 'save and commit told');
    expect(seen.some((s) => s.event === 'open' && (s.payload as { path: string }).path === 'notes.md')).toBe(true);
    expect(saved()!.payload).toMatchObject({ path: 'notes.md' });
  });

  it('merges by its file types, whether it is on or off, as every device must', async () => {
    const ws = (await json('/api/workspace')).body as { types: { id: string }[] };
    expect(ws.types.map((t) => t.id)).toContain('marks');
    const host = running as unknown as { host: { mergeSignature: string } };
    expect(host.host?.mergeSignature ?? '').toContain('marks@1');
  });
});
