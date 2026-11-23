<script setup lang="ts">
// A sync's settings, in its subpanel under Settings › Server's components (decisions 0059, 0064): places this workspace keeps a
// copy on and syncs with, beyond its own devices, each from a component the host
// loads. The online copy (@kuraa/sync-git) is the one that ships: a git server
// (GitHub, GitLab, any) each save is pushed to, which every few minutes
// brings in what others pushed there, so people whose computers cannot reach
// each other directly still meet through it. Everyone sees them; adding and
// removing them is for whoever runs the host (the desktop app, pnpm dev), with
// their own git credentials. Each leads with one target; any more added are
// listed the same way. Its name and its words come from the component.
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, SyncInfo, SyncTargetInfo } from './api.js';
import { time } from './labels.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi; /** Only this sync (its subpanel, under Server's components). */ only?: string }>();
const syncs = shallowRef<SyncInfo[]>([]);
const canManage = ref(false);
const target = ref<Record<string, string>>({});
const busy = ref(false);
const error = shallowRef<{ id: string; error: unknown } | null>(null);

async function load() {
  try {
    const r = await props.api.syncs();
    syncs.value = r.syncs;
    canManage.value = r.canManage;
  } catch { /* not reachable now: read again on the next round */ }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));

async function act(id: string, fn: () => Promise<SyncInfo>) {
  busy.value = true;
  error.value = null;
  try {
    const next = await fn();
    syncs.value = syncs.value.map((s) => (s.id === next.id ? next : s));
  } catch (e) {
    error.value = { id, error: e };
  } finally {
    busy.value = false;
  }
}

async function add(s: SyncInfo) {
  const t = target.value[s.id]?.trim();
  if (!t) return;
  await act(s.id, () => props.api.addSyncTarget(s.id, t));
  if (!error.value) target.value = { ...target.value, [s.id]: '' };
}

const state = (c: SyncTargetInfo) => (c.busy ? S.online.syncing : c.error ? S.online.behind : c.lastSync ? S.online.upToDate(time(c.lastSync)) : S.online.notYet);
</script>

<template>
  <section v-for="s in syncs.filter((x) => !only || x.id === only)" :key="s.id" class="components-group" :data-testid="`sync:${s.id}`">
    <h3 v-if="!only">{{ s.label }}</h3>
    <p v-if="s.description" class="muted components-note">{{ s.description }}</p>
    <ul v-if="s.targets.length" class="menu-devices">
      <li v-for="c in s.targets" :key="c.name" :data-testid="`sync-target:${c.name}`">
        <span :class="['device-dot', { online: !c.error && !!c.lastSync }]" aria-hidden="true" />
        <code class="device-who">{{ c.url }}</code>
        <span class="device-state">{{ state(c) }}</span>
        <button v-if="canManage" type="button" :disabled="busy" @click="act(s.id, () => api.removeSyncTarget(s.id, c.name))">{{ S.common.remove }}</button>
      </li>
    </ul>
    <ErrorBanner v-for="c in s.targets.filter((x) => x.error)" :key="`e-${c.name}`" :error="c.error" inline />
    <template v-if="canManage && !s.targets.length">
      <form class="person-row" @submit.prevent="add(s)">
        <input v-model="target[s.id]" :placeholder="s.placeholder" spellcheck="false" :aria-label="S.online.address(s.label)" data-testid="sync-address">
        <button type="submit" :disabled="busy" data-testid="sync-add">{{ S.online.add }}</button>
      </form>
      <p v-if="s.help" class="muted components-note">{{ s.help }}</p>
    </template>
    <p v-if="!canManage" class="muted components-note">{{ s.targets.length ? S.online.setUpThere : `${S.online.none} ${S.online.setUpThere}` }}</p>
    <ErrorBanner v-if="error?.id === s.id" :error="error.error" inline />
  </section>
</template>
