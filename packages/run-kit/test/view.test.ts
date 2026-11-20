// How a process's paths map to the host's: the nearest folder wins, and a path
// cannot climb out of the folders the process was given.
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mappedView } from '../src/index.js';

const view = mappedView(
  { workspace: '/home/p/notes', scratch: '/home/p/notes/.git/kuraa/run/scratch/x', files: '/home/p/notes/.git/kuraa/run/engines/r' },
  { workspace: '/work', scratch: '/scratch', files: '/kuraa' },
  [{ host: '/data/libs/w', inside: '/rpkgs/libs/w', access: 'read-only' }],
);

describe('a mapped view', () => {
  it('maps each folder, the nearest one first', () => {
    expect(view.inside('/home/p/notes/reports')).toBe('/work/reports');
    expect(view.inside('/home/p/notes/.git/kuraa/run/scratch/x/a.png')).toBe('/scratch/a.png');
    expect(view.inside('/data/libs/w')).toBe('/rpkgs/libs/w');
    expect(view.outside('/scratch/a.png')).toBe('/home/p/notes/.git/kuraa/run/scratch/x/a.png');
    expect(view.outside('/work')).toBe('/home/p/notes');
  });

  it('refuses paths outside the folders, also by way of ..', () => {
    expect(() => view.outside('/scratch/../../etc/passwd')).toThrow('Not in a shared folder');
    expect(() => view.outside('/etc/passwd')).toThrow('Not in a shared folder');
    expect(() => view.inside('/home/p/notes/../secrets')).toThrow('Not in a shared folder');
    expect(() => view.outside('/scratchy/a')).toThrow('Not in a shared folder');
    expect(view.outside('/scratch/plots/../a.png')).toBe('/home/p/notes/.git/kuraa/run/scratch/x/a.png');
  });
});

describe('a mapped view on Windows', () => {
  const win = mappedView(
    { workspace: 'C:\\Users\\p\\notes', scratch: 'C:\\Users\\p\\notes\\.git\\kuraa\\run\\scratch\\x', files: 'C:/Users/p/notes/.git/kuraa/run/engines/r' },
    { workspace: '/work', scratch: '/scratch', files: '/kuraa' },
    [{ host: 'C:\\Users\\p\\AppData\\Local\\kuraa\\libs\\w', inside: '/rpkgs/libs/w', access: 'read-only' }],
    win32,
  );

  it('maps C:\\… paths, with backslashes, to POSIX paths inside and back', () => {
    expect(win.inside('C:\\Users\\p\\notes\\reports\\q1')).toBe('/work/reports/q1');
    expect(win.inside('C:\\Users\\p\\notes')).toBe('/work');
    expect(win.inside('C:\\Users\\p\\AppData\\Local\\kuraa\\libs\\w')).toBe('/rpkgs/libs/w');
    expect(win.outside('/scratch/a.png')).toBe('C:\\Users\\p\\notes\\.git\\kuraa\\run\\scratch\\x\\a.png');
    expect(win.outside('/kuraa/driver.R')).toBe('C:\\Users\\p\\notes\\.git\\kuraa\\run\\engines\\r\\driver.R');
  });

  it('refuses paths outside the folders', () => {
    expect(() => win.inside('C:\\Users\\p\\notes\\..\\secrets')).toThrow('Not in a shared folder');
    expect(() => win.inside('C:\\Users\\p\\notesy')).toThrow('Not in a shared folder');
    expect(() => win.outside('/scratch/../../etc/passwd')).toThrow('Not in a shared folder');
  });
});
