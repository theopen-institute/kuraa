// Addresses in documents reach the page only if they cannot run code or reach local files.
import { describe, expect, it } from 'vitest';
import { safeUrl } from '../src/index.js';
import { imageSource } from '../src/editor/images.js';

describe('safeUrl', () => {
  it('keeps web, mail and relative addresses', () => {
    for (const u of ['https://example.org/a?b#c', 'http://x.test', 'mailto:a@b.org', 'notes.md', './img/plot.png', '../up.md', '#day-one', 'folder/data.md']) {
      expect(safeUrl(u, 'link')).toBe(u);
    }
    expect(safeUrl('figures/plot.png', 'image')).toBe('figures/plot.png');
    expect(safeUrl('data:image/png;base64,AAAA', 'image')).toBe('data:image/png;base64,AAAA');
  });

  it('drops scripts, local files, other schemes, and their disguises', () => {
    for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:x', '\u0001javascript:x',
      'vbscript:x', 'file:///etc/passwd', 'data:text/html,<script>x</script>', '//evil.example/x', 'blob:https://x/y', 'kuraa:x']) {
      expect(safeUrl(u, 'link')).toBeNull();
    }
    expect(safeUrl('data:image/svg+xml;base64,AAAA', 'image')).toBeNull();
    expect(safeUrl('mailto:a@b.org', 'image')).toBeNull();
    expect(safeUrl('', 'link')).toBeNull();
  });
});

describe('where an image shows from', () => {
  it('loads the workspace’s images and data at once, and asks before a web address (its server would learn who opened the document)', () => {
    expect(imageSource('notes/report.md', 'images/plot.png')).toEqual({ kind: 'workspace', path: 'notes/images/plot.png' });
    expect(imageSource('report.md', 'data:image/png;base64,AAAA')).toEqual({ kind: 'data', url: 'data:image/png;base64,AAAA' });
    expect(imageSource('report.md', 'https://tracker.example/pixel.png?who=you')).toEqual({ kind: 'remote', url: 'https://tracker.example/pixel.png?who=you' });
    expect(imageSource('report.md', 'http://tracker.example/p.gif')).toMatchObject({ kind: 'remote' });
    for (const src of ['//tracker.example/p.png', 'file:///etc/passwd', '../../outside.png', '']) expect(imageSource('report.md', src)).toEqual({ kind: 'none' });
  });
});
