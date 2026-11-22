// What the updates window shows (update-window.ts), from how updating stands
// (updates.ts): a pure function, so the words and the bar are worked out in one
// place, tested without Electron, and the window's page only draws them.
import { D } from './strings.js';

/** How far a download has come (electron-updater's ProgressInfo). */
export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/** How updating stands. */
export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'downloading'; version: string; progress: UpdateProgress | null }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; message: string }
  /** This copy does not update itself, and why. */
  | { kind: 'off'; why: string };

/** A button of the window, by what it does. */
export type UpdateChoice = 'restart' | 'later' | 'hide' | 'ok';

export interface UpdateView {
  message: string;
  detail: string;
  /** The bar: how far, 0 to 1; null: going, how far not known yet; absent: no bar. */
  progress?: number | null;
  tone: 'info' | 'warning';
  /** The first is the default (Return). */
  buttons: { choice: UpdateChoice; label: string }[];
}

/** A number of bytes as people read it: 840 KB, 12.4 MB. */
export function bytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function updateView(s: UpdateStatus, current: string): UpdateView {
  const ok = [{ choice: 'ok' as const, label: D.updates.ok }];
  switch (s.kind) {
    case 'checking':
      return { message: D.updates.checking, detail: '', progress: null, tone: 'info', buttons: [{ choice: 'hide', label: D.updates.hide }] };
    case 'none':
      return { message: D.updates.latest(current), detail: '', tone: 'info', buttons: ok };
    case 'downloading': {
      const p = s.progress;
      return {
        message: D.updates.downloading(s.version),
        detail: p && p.total > 0 ? D.updates.progress(bytes(p.transferred), bytes(p.total), p.bytesPerSecond > 0 ? bytes(p.bytesPerSecond) : null) : D.updates.starting,
        progress: p && p.total > 0 ? Math.min(1, Math.max(0, p.percent / 100)) : null,
        tone: 'info',
        buttons: [{ choice: 'hide', label: D.updates.hide }],
      };
    }
    case 'ready':
      return { message: D.updates.ready(s.version), detail: D.updates.readyDetail, progress: 1, tone: 'info', buttons: [{ choice: 'restart', label: D.updates.restart }, { choice: 'later', label: D.updates.later }] };
    case 'failed':
      return { message: D.updates.failedTitle, detail: s.message, tone: 'warning', buttons: ok };
    case 'off':
      return { message: D.updates.off(s.why), detail: '', tone: 'info', buttons: ok };
  }
}
