<script setup lang="ts">
// The menu's Code section: the document's session, and running everything.
import type { ChunkRunner } from './runs.js';
import { S } from './strings.js';
import { useLive } from './vue.js';

const props = defineProps<{ runner: ChunkRunner }>();
const emit = defineEmits<{ packages: [engine: string] }>();
const live = useLive(() => props.runner);
const swallow = (x: Promise<unknown>) => void x.catch(() => undefined);
</script>

<template>
  <section v-if="live.hasRunnableChunks" class="menu-section">
    <h3>{{ S.code.title }}</h3>
    <p class="menu-facts">
      <span
        :class="['r-state', `r-${live.session.state}`, { unsandboxed: live.info.environment && !live.info.environment.sandboxed, unavailable: live.info.environment && !live.info.environment.available }]"
        data-testid="r-state"
        :title="live.info.environment?.message ?? ''"
      >{{ live.engineLabel }} {{ S.session[live.session.state] ?? live.session.state }}{{ live.session.state === 'starting' && live.session.message ? ` · ${live.session.message}` : '' }}{{ live.info.environment ? ` · ${live.info.environment.available ? live.info.environment.label : S.code.notAvailable(live.info.environment.label)}` : '' }}</span>
    </p>
    <!-- Where code cannot run now (Podman missing, say): why, and what to do, instead of a Run that fails. -->
    <p v-if="live.unavailable" class="menu-facts run-unavailable" data-testid="run-unavailable">{{ live.unavailable }}</p>
    <div class="menu-actions">
      <button type="button" :disabled="!!live.unavailable" :title="S.code.runAllTitle" @click="swallow(live.runAll())">{{ S.code.runAll }}</button>
      <button v-if="live.busy" type="button" :title="S.code.interruptTitle" @click="swallow(live.interrupt())">{{ S.code.interrupt }}</button>
      <button v-if="live.session.state !== 'none'" type="button" :title="S.code.restartTitle" @click="swallow(live.restart())">{{ S.code.restart }}</button>
      <button v-if="live.packageEngine" type="button" @click="emit('packages', live.packageEngine)">{{ S.code.packages }}</button>
    </div>
  </section>
</template>
