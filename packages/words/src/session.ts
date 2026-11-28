// Words written by day (0094), as its host half reads them from the history (every
// commit but merges, credited to everyone credited on it, on its own day; and
// what is typed and not committed yet): yours, today and the days before, and
// everyone's today. Asked again a few seconds after typing, and every minute.
// A target for a day is yours, kept in this browser.
import { ref, shallowRef } from 'vue';
import type { FeatureClientContext } from '@kuraa/feature-kit/client';
import type { WordsDay } from './wordlog.js';

const TARGET_KEY = 'kuraa:words:day-target';
/** How many days back the panel shows. */
export const DAYS = 7;

export const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The days asked of the host, newest first; null until known. */
export const days = shallowRef<WordsDay[] | null>(null);
/** The day's target: yours, in this browser. */
export const dayTarget = ref<number | null>(readTarget());

function readTarget(): number | null {
  try {
    const n = Number(localStorage.getItem(TARGET_KEY));
    return Number.isFinite(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
}

export function setDayTarget(target: number | null): void {
  dayTarget.value = target;
  try {
    if (target) localStorage.setItem(TARGET_KEY, String(target));
    else localStorage.removeItem(TARGET_KEY);
  } catch { /* storage unavailable: for this page only */ }
}

/** Whether a person credited is you: by email, else by name. */
export function isYou(ctx: FeatureClientContext, p: { name: string; email: string }): boolean {
  const me = ctx.person();
  return me.email ? p.email.toLowerCase() === me.email.toLowerCase() : p.name === me.name;
}

/** A day's words for you (nought where none). */
export function yours(ctx: FeatureClientContext, date: string): { net: number; added: number } {
  const p = days.value?.find((d) => d.date === date)?.people.find((x) => isYou(ctx, x));
  return { net: p?.net ?? 0, added: p?.added ?? 0 };
}

let asked = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let every: ReturnType<typeof setInterval> | undefined;

/** Ask the host for the days again. */
export async function load(ctx: FeatureClientContext): Promise<void> {
  const n = ++asked;
  const since = new Date();
  since.setDate(since.getDate() - (DAYS - 1));
  try {
    const r = ((await ctx.request('GET', `days?since=${day(since)}`)) as unknown as { days: WordsDay[] }).days;
    if (n === asked) days.value = r;
  } catch {
    // The host away, or older: what was known stays.
  }
}

/** Asked again a few seconds after a change (typing), not at every keystroke. */
export function soon(ctx: FeatureClientContext): void {
  clearTimeout(timer);
  timer = setTimeout(() => void load(ctx), 3000);
}

/** In use: asked now and every minute; returns how to stop. */
export function follow(ctx: FeatureClientContext): () => void {
  void load(ctx);
  clearInterval(every);
  every = setInterval(() => void load(ctx), 60_000);
  return () => {
    clearInterval(every);
    clearTimeout(timer);
    asked++;
    days.value = null;
  };
}
