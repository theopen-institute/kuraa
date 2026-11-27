// What Compile's client half knows of the open workspace (0093): each folder's
// settings, asked of its host half as it comes into use and again whenever
// that says one changed; and the folder the panel is to compile.
import { ref, shallowRef } from 'vue';
import type { FeatureClientContext } from '@kuraa/feature-kit/client';
import type { FolderCompile } from './settings.js';

/** Each folder's settings that say anything. */
export const known = shallowRef<FolderCompile[]>([]);
/** The folder to compile ('' the top level), as last chosen; null: none yet. */
export const target = ref<string | null>(null);

let asked = 0;

export async function load(ctx: FeatureClientContext): Promise<void> {
  const n = ++asked;
  try {
    const r = (await ctx.request('GET', 'folders')) as unknown as { folders: FolderCompile[] };
    if (n !== asked) return;
    known.value = r.folders;
    ctx.marksChanged();
  } catch {
    // Off, or the host away: what was known stays.
  }
}

/** Another workspace, or none: nothing known. */
export function forget(): void {
  asked++;
  known.value = [];
  target.value = null;
}

export const settingsOf = (folder: string): FolderCompile | undefined => known.value.find((c) => c.folder === folder);
