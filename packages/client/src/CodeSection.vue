<script setup lang="ts">
// The menu's Code section: the document's session, and running everything.
import type { ChunkRunner } from './runs.js';
import { SESSION } from './labels.js';
import { useLive } from './vue.js';

const props = defineProps<{ runner: ChunkRunner }>();
const emit = defineEmits<{ packages: [engine: string] }>();
const live = useLive(() => props.runner);
const swallow = (x: Promise<unknown>) => void x.catch(() => undefined);
</script>

<template>
  <section v-if="live.hasRunnableChunks" class="menu-section">
    <h3>Code</h3>
    <p class="menu-facts">
      <span
        :class="['r-state', `r-${live.session.state}`, { unsandboxed: live.info.environment && !live.info.environment.sandboxed, unavailable: live.info.environment && !live.info.environment.available }]"
        data-testid="r-state"
        :title="live.info.environment?.message ?? ''"
      >{{ live.engineLabel }} {{ SESSION[live.session.state] ?? live.session.state }}{{ live.session.state === 'starting' && live.session.message ? ` · ${live.session.message}` : '' }}{{ live.info.environment ? ` · ${live.info.environment.available ? live.info.environment.label : `${live.info.environment.label}: not available`}` : '' }}</span>
    </p>
    <div class="menu-actions">
      <button type="button" title="Run every chunk, top to bottom" @click="swallow(live.runAll())">Run all</button>
      <button v-if="live.busy" type="button" title="Interrupt, and drop queued runs" @click="swallow(live.interrupt())">Interrupt</button>
      <button v-if="live.session.state !== 'none'" type="button" title="A fresh session: everything defined so far is gone" @click="swallow(live.restart())">Restart</button>
      <button v-if="live.packageEngine" type="button" @click="emit('packages', live.packageEngine)">Packages…</button>
    </div>
  </section>
</template>
