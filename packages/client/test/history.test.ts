// The history panel's grouping of the host's saves into editing sessions.
import { describe, expect, it } from 'vitest';
import type { CommitInfo } from '../src/api.js';
import { groupHistory, partsOf } from '../src/history.js';

const at = (h: number) => new Date(Date.UTC(2026, 10, 18, h)).toISOString();
const c = (hash: string, hour: number, kind: CommitInfo['kind'], subject = 'Edit Notes: Methods (Ada)'): CommitInfo =>
  ({ hash, author: 'Ada', email: 'ada@example.org', date: at(hour), subject, coAuthors: [], path: 'n.md', kind });

describe('groupHistory', () => {
  it('folds consecutive saves close in time into sessions; versions and merges stand alone', () => {
    const commits = [c('a', 12, 'autosave'), c('b', 11, 'autosave'), c('v', 10, 'commit', 'Draft for Bo'), c('d', 9, 'autosave'), c('e', 3, 'autosave'), c('m', 2, 'merge')];
    expect(groupHistory(commits).map((e) => (e.kind === 'session' ? e.commits.map((x) => x.hash).join('') : e.commit.hash))).toEqual(['ab', 'v', 'd', 'e', 'm']);
  });

  it('reads the parts a session changed from its messages, oldest first', () => {
    expect(partsOf([c('a', 2, 'autosave', 'Edit Notes: Results, Methods (Ada, Bo)'), c('b', 1, 'autosave', 'Edit Notes: Methods and 2 more')])).toEqual(['Methods', 'Results']);
  });
});
