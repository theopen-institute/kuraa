<script setup lang="ts">
// Beside the workspace's name, in the sidebar's header: a light for the open
// document's connection (green when connected), saying in its tooltip how it is
// connected and who else is here. With no document open it is the host's: green
// while the host answers (it goes on syncing with the other devices and the
// online copy then too), red when it does not. Either way the tooltip says how
// the workspace syncs. The words are the core's (ConnectionInfo); this draws them.
import type { ConnectionInfo } from '@kuraa/feature-kit/client';

defineProps<{ info: ConnectionInfo }>();
</script>

<template>
  <span class="connection-light" :title="info.title" role="status" data-testid="connection-light">
    <span :class="`dot conn-${info.state}`" aria-hidden="true" />
    <!-- For screen readers and tests: the connection, and who is here, by name. -->
    <span class="sr-only" data-testid="status">{{ info.label }}</span>
    <span class="sr-only" data-testid="workspace-link">{{ info.syncing.join('. ') }}</span>
    <span class="sr-only" data-testid="peers">{{ info.peers.join(', ') }}</span>
  </span>
</template>
