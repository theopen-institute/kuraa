// R Markdown's shortcuts sheet: Markdown's lines, and its own chunk cue and key.
import { describe, expect, it } from 'vitest';
import { rmarkdownEditor } from '../src/editor/index.js';

describe('the R Markdown shortcuts sheet', () => {
  it('has Markdown’s lines and its own chunk cue and key', () => {
    const help = rmarkdownEditor.help ?? [];
    expect(help.some((h) => h.type === '**bold**')).toBe(true);
    expect(help.some((h) => h.keys?.includes('Mod-Alt-i'))).toBe(true);
    expect(help.some((h) => h.type?.startsWith('```{r}'))).toBe(true);
  });
});
