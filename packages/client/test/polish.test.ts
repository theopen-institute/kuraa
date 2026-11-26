// The pure logic of decision 0044: errors in plain words with the original kept,
// counts with their plurals, keys as people read them and as handlers match
// them, the file tree's keys, and the shortcuts sheet.
import { describe, expect, it } from 'vitest';
import type { FormatEditor, HelpItem } from '@kuraa/editor-kit';
import { ApiError } from '../src/api.js';
import { explain } from '../src/errors.js';
import { count, plural, S } from '../src/strings.js';
import { keyLabel, keyMatches } from '../src/keys.js';
import { helpMatches, helpSheet } from '../src/help.js';

describe('errors in plain words', () => {
  it('says the common ones plainly, with what to do, and keeps what was said for Details', () => {
    const git = explain(new Error("git push failed (128): fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com"));
    expect(git.text).toBe(S.errors.remoteUnreachable);
    expect(git.details).toContain('Could not resolve host');
    expect(explain(new Error("fatal: Unable to create '/w/.git/index.lock': File exists.")).text).toBe(S.errors.gitBusy);
    expect(explain(new Error('git@github.com: Permission denied (publickey).')).text).toBe(S.errors.remoteAuth);
    expect(explain(new Error('! [rejected] main -> main (fetch first)')).text).toBe(S.errors.remoteAhead);
    expect(explain(new Error("EACCES: permission denied, open '/w/notes.md'")).text).toBe(S.errors.permission);
    expect(explain(new Error('ENOSPC: no space left on device')).text).toBe(S.errors.diskFull);
  });

  it('knows a host that cannot be reached, and an access code turned down, by their status', () => {
    expect(explain(new ApiError(0, 'Cannot reach the host at http://x: Failed to fetch')).text).toBe(S.errors.unreachable);
    expect(explain(new ApiError(401, 'Unauthorized')).text).toBe(S.errors.accessCode);
  });

  it('shows a message that already reads as a sentence as it is', () => {
    expect(explain(new ApiError(403, 'Making invitations from the app is turned off on this host'))).toEqual({ text: 'Making invitations from the app is turned off on this host', details: null });
    expect(explain('Give the workspace a name.')).toEqual({ text: 'Give the workspace a name.', details: null });
  });

  it('hides output that is not for people behind Details', () => {
    const e = explain(new Error('TypeError: x is undefined\n    at foo (app.js:1:2)'));
    expect(e.text).toBe(S.errors.generic);
    expect(e.details).toContain('TypeError');
    expect(explain(null)).toEqual({ text: S.errors.generic, details: null });
  });
});

describe('counts', () => {
  it('uses the plural rules, not a hand-made "s"', () => {
    expect(count(1, 'file', 'files')).toBe('1 file');
    expect(count(0, 'file', 'files')).toBe('0 files');
    expect(count(2, 'match', 'matches')).toBe('2 matches');
    expect(count(1200, 'change', 'changes')).toBe('1,200 changes');
    expect(plural(1, 'part differs', 'parts differ')).toBe('part differs');
    expect(S.offline.unsent(4)).toBe('4 changes not yet sent.');
  });
});

describe('keys', () => {
  it('shows keys for the system', () => {
    expect(keyLabel('Mod-Shift-f', true)).toBe('⇧⌘F');
    expect(keyLabel('Mod-Shift-f', false)).toBe('Ctrl+Shift+F');
    expect(keyLabel('Mod-Alt-o', true)).toBe('⌥⌘O');
    expect(keyLabel('Mod-Shift-Enter', true)).toBe('⇧⌘↩');
    expect(keyLabel('Shift-F10', false)).toBe('Shift+F10');
    expect(keyLabel('Mod-/', false)).toBe('Ctrl+/');
    expect(keyLabel('Mod-Shift-.', true)).toBe('⇧⌘.');
  });

  it('matches key events as the handlers need, whatever ⌥ does to the character', () => {
    const e = (key: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
      ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    expect(keyMatches(e('ø', 'KeyO', { metaKey: true, altKey: true }), 'Mod-Alt-o')).toBe(true);
    expect(keyMatches(e('o', 'KeyO', { metaKey: true }), 'Mod-Alt-o')).toBe(false);
    expect(keyMatches(e('F', 'KeyF', { ctrlKey: true, shiftKey: true }), 'Mod-Shift-f')).toBe(true);
    expect(keyMatches(e('f', 'KeyF', { ctrlKey: true }), 'Mod-Shift-f')).toBe(false);
    expect(keyMatches(e(',', 'Comma', { metaKey: true }), 'Mod-,')).toBe(true);
    // A slash typed with Shift (some keyboards) is still ⌘/.
    expect(keyMatches(e('/', 'Digit7', { metaKey: true, shiftKey: true }), 'Mod-/')).toBe(true);
    expect(keyMatches(e('/', 'Slash'), 'Mod-/')).toBe(false);
  });
});

describe('the shortcuts sheet', () => {
  it('lists each module’s lines once, grouped as they group them, then the client’s keys', () => {
    const md: FormatEditor = { label: 'Markdown', help: [{ group: 'Text', type: '**bold**', keys: ['Mod-b'], does: 'Bold' }] };
    const rmd: FormatEditor = { label: 'R Markdown', help: [...md.help!, { group: 'Notes', type: '^[text]', does: 'Inline note' }] };
    // A component's line in the client's group (Search's, 0089) is listed in it.
    const search = { label: 'Search', help: [{ group: S.help.findYourWay, does: 'Search every file', keys: ['Mod-Shift-f'] }] } as FormatEditor;
    // The file list's keys are the file tree's (0087): in the client's group of that name.
    const files = { label: 'File tree', help: [{ group: S.help.tree, does: 'Rename', keys: ['F2'] }] } as FormatEditor;
    const sheet = helpSheet({ md, rmd, search, files });
    expect(sheet.map((g) => g.title).slice(0, 2)).toEqual(['Text', 'Notes']);
    expect(sheet[0]!.items).toHaveLength(1);
    expect(sheet.slice(0, 2).every((g) => !g.app)).toBe(true);
    const keys = sheet.filter((g) => g.app).flatMap((g) => g.items.flatMap((i) => i.keys ?? []));
    expect(keys).toEqual(expect.arrayContaining(['Mod-/', 'Mod-,', 'Mod-Shift-f', 'Mod-f', 'Mod-Enter', 'F2']));
  });

  it('lists a module’s line in the client’s group of the same title, first', () => {
    const rmd: FormatEditor = { label: 'R Markdown', help: [{ group: S.help.code, type: '```{r}', enter: true, keys: ['Mod-Alt-i'], does: 'New R chunk' }] };
    const sheet = helpSheet({ rmd });
    expect(sheet.filter((g) => g.title === S.help.code)).toHaveLength(1);
    const code = sheet.find((g) => g.title === S.help.code)!;
    expect(code.app).toBe(true);
    expect(code.items.map((i) => i.does)).toEqual(['New R chunk', S.help.runChunk, S.help.runLine]);
  });

  it('filters by what a line is, its note, its cue or its keys as shown', () => {
    const link: HelpItem = { group: 'Text', does: 'Link', type: '[text](url)', keys: ['Mod-k'], note: 'opens with a click' };
    const label = (k: string) => (k === 'Mod-k' ? '⌘K' : k);
    expect(helpMatches(link, '', label)).toBe(true);
    expect(helpMatches(link, 'LINK', label)).toBe(true);
    expect(helpMatches(link, 'click', label)).toBe(true);
    expect(helpMatches(link, '](url', label)).toBe(true);
    expect(helpMatches(link, '⌘k', label)).toBe(true);
    expect(helpMatches(link, 'text link', label)).toBe(true);
    expect(helpMatches(link, 'bold', label)).toBe(false);
  });
});
