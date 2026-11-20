<script setup lang="ts">
// At the bottom of the sidebar: the connection, who is here, and the way into the menu.
import { computed } from 'vue';
import type { EditorStatus } from './types.js';
import { APP_KEYS, keyLabel } from './keys.js';
import { connectionLabel, S } from './strings.js';

const props = defineProps<{ status: EditorStatus | null; hasDocument: boolean }>();
defineEmits<{ open: [] }>();

const conn = computed(() => (props.hasDocument ? props.status?.connection ?? 'connecting' : 'none'));
const peers = computed(() => props.status?.peers ?? []);
const others = computed(() => peers.value.filter((p) => !p.self));
</script>

<template>
  <button type="button" class="menu-button" :title="S.menu.button(keyLabel(APP_KEYS.menu))" data-testid="menu-button" aria-haspopup="dialog" @click="$emit('open')">
    <span :class="`dot conn-${conn}`" aria-hidden="true" />
    <span class="menu-button-text" data-testid="status">{{ hasDocument ? connectionLabel(conn) : S.connection.none }}</span>
    <span v-if="others.length > 0" class="menu-people" :title="others.map((p) => p.name || S.common.anonymous).join(', ')">
      <span v-for="p in others.slice(0, 3)" :key="p.clientId" class="menu-person" :style="{ background: p.color }" />
      {{ S.connection.here(others.length) }}
    </span>
    <!-- For screen readers and tests: who is here, by name. -->
    <span class="sr-only" data-testid="peers">{{ peers.map((p) => `${p.name || S.common.anonymous}${p.self ? S.common.you : ''}`).join(', ') }}</span>
    <span class="menu-gear" aria-hidden="true">⚙</span>
  </button>
</template>
