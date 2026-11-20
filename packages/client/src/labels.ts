// Times shown in the menu and panels. (The words are in strings.ts.)
import { S } from './strings.js';

/** A time: hours and minutes if today, the date and time otherwise; a dash if none. */
export const time = (iso: string | null) => {
  if (!iso) return S.common.none;
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString();
};

/** A size people read: '54 MB' (never less than 1 MB, for something to download). */
export const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6)).toLocaleString()} MB`;

/** A commit's time, with seconds. */
export const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
};
