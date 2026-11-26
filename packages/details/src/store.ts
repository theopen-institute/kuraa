// What the client half knows of the workspace's documents' details (0094):
// asked of the host half as it comes into use, and again when that says one
// changed; for the file tree's marks and the panel's suggestions.
import { shallowRef } from 'vue';
import type { FeatureClientContext } from '@kuraa/feature-kit/client';
import { DEFAULT_STATUSES, type Details } from './details.js';

export const known = shallowRef<Record<string, Details>>({});
let asked = 0;

export async function load(ctx: FeatureClientContext): Promise<void> {
  const n = ++asked;
  try {
    const r = (await ctx.request('GET', 'documents')) as unknown as { documents: Record<string, Details> };
    if (n !== asked) return;
    known.value = r.documents;
    ctx.marksChanged();
  } catch {
    // Off, or the host away: what was known stays.
  }
}

export function forget(): void {
  asked++;
  known.value = {};
}

/** A document's details as just set here, before the host has them. */
export function remember(ctx: FeatureClientContext, path: string, d: Details): void {
  known.value = { ...known.value, [path]: d };
  ctx.marksChanged();
}

/** Values used in the workspace, most used first: for suggestions. */
export function used(pick: (d: Details) => (string | null)[]): string[] {
  const counts = new Map<string, number>();
  for (const d of Object.values(known.value)) for (const v of pick(d)) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

/** The statuses offered: the workspace's, else Scrivener's. */
export function statusesOf(ctx: FeatureClientContext): string[] {
  try {
    const s = ctx.status().settings.statuses;
    if (Array.isArray(s)) {
      const list = s.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
      if (list.length) return list;
    }
  } catch { /* not known yet */ }
  return DEFAULT_STATUSES;
}
