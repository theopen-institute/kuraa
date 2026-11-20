<script setup lang="ts">
// The history sidebar: the open file's commits; one can be viewed, read only.
// The host's own saves are grouped into editing sessions, opened to see each
// save; named versions and merges stand on their own.
import { computed, ref, shallowRef, watch } from 'vue';
import type { CommitInfo, HostApi } from './api.js';
import { groupHistory, partsOf, peopleOf } from './history.js';
import ErrorBanner from './ErrorBanner.vue';
import { when } from './labels.js';
import { S } from './strings.js';

const props = defineProps<{ api: HostApi; path: string | null; refreshKey: number; viewing: string | null }>();
const emit = defineEmits<{ view: [commit: CommitInfo | null] }>();

const commits = shallowRef<CommitInfo[]>([]);
const error = shallowRef<unknown>(null);

watch([() => props.api, () => props.path, () => props.refreshKey], ([api, path], prev, onCleanup) => {
  // Another file's commits are not offered while this one's load: choosing one would show that file.
  if (!path || api !== prev?.[0] || path !== prev?.[1]) commits.value = [];
  if (!path) return;
  let cancelled = false;
  onCleanup(() => {
    cancelled = true;
  });
  api.history(path).then(
    (c) => {
      if (cancelled) return;
      commits.value = c;
      error.value = null;
    },
    (e: unknown) => {
      if (!cancelled) error.value = e;
    },
  );
}, { immediate: true });

const people = (c: CommitInfo) => peopleOf([c]);
/**
 * What a commit is called in the list: a named version by its name; a merge, or
 * a save the host made, by what happened, in words rather than its message.
 */
const title = (c: CommitInfo) => {
  if (c.kind === 'merge') return S.history.merged;
  if (c.kind === 'autosave') {
    const parts = partsOf([c]);
    return parts.length ? S.history.savedParts(parts.join(', ')) : S.history.saved;
  }
  return c.subject;
};
const entries = computed(() => groupHistory(commits.value));
const open = ref(new Set<string>());
function toggle(id: string) {
  const next = new Set(open.value);
  if (!next.delete(id)) next.add(id);
  open.value = next;
}
const latest = computed(() => commits.value[0]?.hash);
const summary = (cs: CommitInfo[]) => {
  const parts = partsOf(cs);
  const shown = parts.length > 3 ? S.history.more(parts.slice(0, 3).join(', '), parts.length - 3) : parts.join(', ');
  return S.history.saves(cs.length, shown);
};
</script>

<template>
  <aside class="pane pane-right" :aria-label="S.history.title">
    <div class="pane-header"><span>{{ S.history.title }}</span></div>
    <p v-if="!path" class="muted pad">{{ S.history.openFile }}</p>
    <ErrorBanner v-if="error" :error="error" />
    <ol class="history" data-testid="history">
      <template v-for="e in entries" :key="e.kind === 'session' ? e.id : e.commit.hash">
        <li v-if="e.kind === 'commit'" :class="['history-' + e.commit.kind, { selected: viewing === e.commit.hash }]">
          <button type="button" @click="emit('view', viewing === e.commit.hash ? null : e.commit)">
            <span class="history-subject">{{ title(e.commit) }}</span>
            <span class="history-meta">{{ when(e.commit.date) }}{{ e.commit.hash === latest ? S.history.latest : '' }}</span>
            <span class="history-people">{{ people(e.commit) }}</span>
          </button>
        </li>
        <li v-else class="history-session" data-testid="history-session">
          <button type="button" :aria-expanded="open.has(e.id)" @click="toggle(e.id)">
            <span class="history-subject"><span class="history-caret" aria-hidden="true">{{ open.has(e.id) ? '▾' : '▸' }}</span> {{ summary(e.commits) }}</span>
            <span class="history-meta">{{ when(e.commits[e.commits.length - 1]!.date) }} – {{ when(e.commits[0]!.date) }}{{ e.commits[0]!.hash === latest ? S.history.latest : '' }}</span>
            <span class="history-people">{{ peopleOf(e.commits) }}</span>
          </button>
          <ol v-if="open.has(e.id)" class="history-saves">
            <li v-for="c in e.commits" :key="c.hash" :class="{ selected: viewing === c.hash }">
              <button type="button" @click="emit('view', viewing === c.hash ? null : c)">
                <span class="history-subject">{{ when(c.date) }}</span>
                <span class="history-meta">{{ people(c) }}{{ partsOf([c]).length ? ` · ${partsOf([c]).join(', ')}` : '' }}</span>
              </button>
            </li>
          </ol>
        </li>
      </template>
    </ol>
  </aside>
</template>
