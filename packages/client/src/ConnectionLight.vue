<script setup lang="ts">
// Beside the workspace's name, in the sidebar's header: a light for the open
// document's connection (green when connected), saying in its tooltip how it is
// connected and who else is here. Settings is in the workspace's menu (and ⌘,).
import { computed } from 'vue';
import type { EditorStatus } from './types.js';
import { connectionLabel, S } from './strings.js';

const props = defineProps<{ status: EditorStatus | null; hasDocument: boolean }>();

const conn = computed(() => (props.hasDocument ? props.status?.connection ?? 'connecting' : 'none'));
const peers = computed(() => props.status?.peers ?? []);
const others = computed(() => peers.value.filter((p) => !p.self));
const label = computed(() => (props.hasDocument ? connectionLabel(conn.value) : S.connection.none));
const title = computed(() => (others.value.length
  ? `${label.value} · ${S.connection.here(others.value.length)}: ${others.value.map((p) => p.name || S.common.anonymous).join(', ')}`
  : label.value));
</script>

<template>
  <span class="connection-light" :title="title" role="status" data-testid="connection-light">
    <span :class="`dot conn-${conn}`" aria-hidden="true" />
    <!-- For screen readers and tests: the connection, and who is here, by name. -->
    <span class="sr-only" data-testid="status">{{ label }}</span>
    <span class="sr-only" data-testid="peers">{{ peers.map((p) => `${p.name || S.common.anonymous}${p.self ? S.common.you : ''}`).join(', ') }}</span>
  </span>
</template>
