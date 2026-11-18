<script setup lang="ts">
// The history sidebar: the open file's commits; one can be viewed, read only.
import { ref, shallowRef, watch } from 'vue';
import type { CommitInfo, HostApi } from './api.js';
import { when } from './labels.js';

const props = defineProps<{ api: HostApi; path: string | null; refreshKey: number; viewing: string | null }>();
const emit = defineEmits<{ view: [commit: CommitInfo | null] }>();

const commits = shallowRef<CommitInfo[]>([]);
const error = ref<string | null>(null);

watch([() => props.api, () => props.path, () => props.refreshKey], ([api, path], _prev, onCleanup) => {
  if (!path) {
    commits.value = [];
    return;
  }
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
    (e: Error) => {
      if (!cancelled) error.value = e.message;
    },
  );
}, { immediate: true });

const people = (c: CommitInfo) => [c.author, ...c.coAuthors.map((a) => a.name)].filter((n, j, all) => all.indexOf(n) === j).join(', ');
</script>

<template>
  <aside class="pane pane-right" aria-label="History">
    <div class="pane-header"><span>History</span></div>
    <p v-if="!path" class="muted pad">Open a file to see its history.</p>
    <p v-if="error" class="banner warn">{{ error }}</p>
    <ol class="history" data-testid="history">
      <li v-for="(c, i) in commits" :key="c.hash" :class="{ selected: viewing === c.hash }">
        <button type="button" @click="emit('view', viewing === c.hash ? null : c)">
          <span class="history-subject">{{ c.subject }}</span>
          <span class="history-meta"><code>{{ c.hash.slice(0, 7) }}</code> · {{ when(c.date) }}{{ i === 0 ? ' · latest' : '' }}</span>
          <span class="history-people">{{ people(c) }}</span>
        </button>
      </li>
    </ol>
  </aside>
</template>
