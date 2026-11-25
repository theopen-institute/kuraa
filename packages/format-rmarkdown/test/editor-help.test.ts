// R Markdown's shortcuts sheet: Markdown's lines, and its own chunk cue and key.
import { describe, expect, it } from 'vitest';
import { rmarkdownEditor } from '../src/editor/index.js';

describe('the R Markdown shortcuts sheet', () => {
  it('has Markdown’s lines and its own chunk cue and key', () => {
    const help = rmarkdownEditor.help ?? [];
    expect(help.some((h) => h.type === '**bold**')).toBe(true);
    // One line: the cue and the key for a new chunk, listed with the keys that run chunks.
    expect(help.filter((h) => h.keys?.includes('Mod-Alt-i'))).toEqual([
      expect.objectContaining({ group: 'Code chunks', type: '```{r}', enter: true }),
    ]);
  });
});
