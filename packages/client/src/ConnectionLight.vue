<script setup lang="ts">
// Beside the workspace's name, in the sidebar's header: a light for the open
// document's connection (green when connected), saying in its tooltip how it is
// connected and who else is here. With no document open it is the host's: green
// while the host answers (it goes on syncing with the other devices and the
// online copy then too), red when it does not. Either way the tooltip says how
// the workspace syncs. Settings is in the workspace's menu (and ⌘,).
import { computed } from 'vue';
import type { EditorStatus, WorkspaceLink } from './types.js';
import { connectionLabel, S } from './strings.js';

const props = defineProps<{ status: EditorStatus | null; hasDocument: boolean; link: WorkspaceLink | null }>();

const conn = computed(() => {
  if (props.hasDocument) return props.status?.connection ?? 'connecting';
  if (!props.link) return 'connecting';
  return props.link.reachable ? 'connected' : 'disconnected';
});
const peers = computed(() => (props.hasDocument ? props.status?.peers ?? [] : []));
const others = computed(() => peers.value.filter((p) => !p.self));
const label = computed(() => {
  if (props.hasDocument) return connectionLabel(conn.value);
  if (!props.link) return connectionLabel('connecting');
  return props.link.reachable ? S.connection.host : S.connection.noHost;
});
/** How the workspace syncs beyond this computer, in words, if the host said. */
const syncing = computed(() => {
  const l = props.link;
  if (!l?.reachable) return [];
  const words = [l.devices ? S.connection.devices(l.devices.online, l.devices.total) : S.connection.alone];
  const o = l.online;
  if (o) words.push(o.busy ? S.connection.onlineSyncing : o.failed ? S.connection.onlineFailed : o.pending ? S.connection.onlinePending(o.pending) : S.connection.onlineUpToDate);
  return words;
});
const title = computed(() => [
  others.value.length ? `${label.value} · ${S.connection.here(others.value.length)}: ${others.value.map((p) => p.name || S.common.anonymous).join(', ')}` : label.value,
  ...syncing.value,
].join('\n'));
</script>

<template>
  <span class="connection-light" :title="title" role="status" data-testid="connection-light">
    <span :class="`dot conn-${conn}`" aria-hidden="true" />
    <!-- For screen readers and tests: the connection, and who is here, by name. -->
    <span class="sr-only" data-testid="status">{{ label }}</span>
    <span class="sr-only" data-testid="workspace-link">{{ syncing.join('. ') }}</span>
    <span class="sr-only" data-testid="peers">{{ peers.map((p) => `${p.name || S.common.anonymous}${p.self ? S.common.you : ''}`).join(', ') }}</span>
  </span>
</template>
