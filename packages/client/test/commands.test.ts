import { describe, expect, it } from 'vitest';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import { claimKeys, commandHelp, commandsOf, menuItem, normalKeys } from '../src/commands.js';

const feature = defineClientFeature({
  id: 'notes',
  commands: [
    { id: 'note', label: 'Note', keys: 'Mod-Alt-n', about: 'editor', help: 'Note the selection' },
    { id: 'quiet', label: 'Quiet', keys: 'Mod-Alt-q', help: false },
    { id: 'plain', label: 'Plain' },
  ],
  panels: [{ id: 'notes', label: 'Notes', about: 'document', keys: 'Alt-Mod-K', mount: () => () => undefined }],
});

describe('features’ commands (0091)', () => {
  it('are a feature’s own and one for each of its panels', () => {
    const list = commandsOf(feature, 'Notes');
    expect(list.map((c) => [c.id, c.about, c.panel ?? null])).toEqual([
      ['note', 'editor', null], ['quiet', 'workspace', null], ['plain', 'workspace', null], ['panel:notes', 'document', 'notes'],
    ]);
  });

  it('compare keys however they are written', () => {
    expect(normalKeys('Alt-Mod-K')).toBe(normalKeys('Mod-Alt-k'));
    expect(normalKeys('Cmd-Option-k')).toBe('Mod-Alt-k');
    expect(normalKeys('Mod-Shift-f')).not.toBe(normalKeys('Mod-f'));
    expect(normalKeys('Shift-F10')).toBe('Shift-F10');
  });

  it('keep keys for the first to claim them, never what the app or a format has', () => {
    const other = defineClientFeature({ id: 'other', commands: [{ id: 'grab', label: 'Grab', keys: 'Mod-Alt-K' }, { id: 'undo', label: 'Undo', keys: 'Mod-z' }] });
    const { bound, refused } = claimKeys([...commandsOf(feature, 'Notes'), ...commandsOf(other, 'Other')], [{ keys: 'Mod-z', by: 'the app (undo)' }]);
    expect(refused.map((r) => [r.command.id, r.by])).toEqual([['grab', 'the feature notes (panel:notes)'], ['undo', 'the app (undo)']]);
    expect(bound.map((c) => c.id)).toEqual(['note', 'quiet', 'plain', 'panel:notes']);
  });

  it('list their keys on the sheet, under the feature’s heading, unless they say not to', () => {
    expect(commandHelp(commandsOf(feature, 'Notes'))).toEqual([
      { group: 'Notes', does: 'Note the selection', keys: ['Mod-Alt-n'] },
      { group: 'Notes', does: 'Notes', keys: ['Alt-Mod-K'] },
    ]);
  });

  it('fill menu items that name them', () => {
    const list = commandsOf(feature, 'Notes');
    const ran: string[] = [];
    const find = (id: string) => list.find((c) => c.id === id);
    const item = menuItem({ command: 'panel:notes', testid: 'menu-notes' }, find, (c) => ran.push(c.id))!;
    expect([item.label, item.keys, item.testid]).toEqual(['Notes', 'Alt-Mod-K', 'menu-notes']);
    item.run();
    expect(ran).toEqual(['panel:notes']);
    expect(menuItem({ command: 'note', label: 'Note this' }, find, () => undefined)!.label).toBe('Note this');
    expect(menuItem({ command: 'missing' }, find, () => undefined)).toBeNull();
    const own = { label: 'Own', run: () => undefined };
    expect(menuItem(own, find, () => undefined)).toBe(own);
  });
});
