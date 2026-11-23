<script setup lang="ts">
// The document menu's code items (DocumentMenu): the document's session, said
// above them, and running everything, stopping, starting again, its packages.
import type { ChunkRunner } from './runs.js';
import { S } from './strings.js';
import { useLive } from './vue.js';

const props = defineProps<{ runner: ChunkRunner }>();
const emit = defineEmits<{ packages: [engine: string]; /** An item was chosen: the menu closes. */ done: [] }>();
const live = useLive(() => props.runner);
const swallow = (x: Promise<unknown>) => void x.catch(() => undefined);
function choose(fn: () => Promise<unknown>) {
  emit('done');
  swallow(fn());
}
</script>

<template>
  <template v-if="live.hasRunnableChunks">
    <div class="menu-divider" role="separator" />
    <p class="menu-note" role="none">
      <span
        :class="['r-state', `r-${live.session.state}`, { unsandboxed: live.info.environment && !live.info.environment.sandboxed, unavailable: live.info.environment && !live.info.environment.available }]"
        data-testid="r-state"
        :title="live.info.environment?.message ?? ''"
      >{{ live.engineLabel }} {{ S.session[live.session.state] ?? live.session.state }}{{ live.session.state === 'starting' && live.session.message ? ` · ${live.session.message}` : '' }}{{ live.info.environment ? ` · ${live.info.environment.available ? live.info.environment.label : S.code.notAvailable(live.info.environment.label)}` : '' }}</span>
    </p>
    <!-- Where code cannot run now (Podman missing, say): why, and what to do, instead of a Run that fails. -->
    <p v-if="live.unavailable" class="menu-note run-unavailable" role="none" data-testid="run-unavailable">{{ live.unavailable }}</p>
    <button type="button" role="menuitem" class="menu-item" :disabled="!!live.unavailable" :title="S.code.runAllTitle" data-testid="menu-run-all" @click="choose(() => live.runAll())">
      <span class="menu-check" aria-hidden="true" /><span class="menu-label">{{ S.code.runAll }}</span>
    </button>
    <button v-if="live.busy" type="button" role="menuitem" class="menu-item" :title="S.code.interruptTitle" data-testid="menu-interrupt" @click="choose(() => live.interrupt())">
      <span class="menu-check" aria-hidden="true" /><span class="menu-label">{{ S.code.interrupt }}</span>
    </button>
    <button v-if="live.session.state !== 'none'" type="button" role="menuitem" class="menu-item" :title="S.code.restartTitle" data-testid="menu-restart" @click="choose(() => live.restart())">
      <span class="menu-check" aria-hidden="true" /><span class="menu-label">{{ S.code.restart }}</span>
    </button>
    <button v-if="live.packageEngine" type="button" role="menuitem" class="menu-item" data-testid="menu-packages" @click="emit('packages', live.packageEngine)">
      <span class="menu-check" aria-hidden="true" /><span class="menu-label">{{ S.code.packages }}</span>
    </button>
  </template>
</template>
