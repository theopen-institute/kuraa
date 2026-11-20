<script setup lang="ts">
// The menu's Online copy section: a git server (GitHub, GitLab, any) this
// workspace keeps a copy on. Each save is pushed to it, and Sync (and every few
// minutes) brings in what others pushed there, so people whose computers
// cannot reach each other directly still meet through it. Everyone sees it;
// adding and removing it is for whoever runs the host (the desktop app,
// pnpm dev), with their own git credentials. It leads with one; any more
// added are listed the same way.
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, OnlineCopyInfo } from './api.js';
import { time } from './labels.js';

const props = defineProps<{ api: HostApi }>();
const copies = shallowRef<OnlineCopyInfo[]>([]);
const canManage = ref(false);
const known = ref(false);
const target = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function load() {
  try {
    const r = await props.api.online();
    copies.value = r.copies;
    canManage.value = r.canManage;
  } catch { /* not reachable now: read again on the next round */ }
  known.value = true;
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));

async function act(fn: () => Promise<OnlineCopyInfo[]>) {
  busy.value = true;
  error.value = null;
  try {
    copies.value = await fn();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function add() {
  if (!target.value.trim()) return;
  await act(() => props.api.addOnline(target.value.trim()));
  if (!error.value) target.value = '';
}

const state = (c: OnlineCopyInfo) => (c.busy ? 'syncing…' : c.error ? 'not up to date' : c.lastSync ? `up to date ${time(c.lastSync)}` : 'not yet');
</script>

<template>
  <section v-if="known && (copies.length || canManage)" class="menu-section" data-testid="online-copy">
    <h3>Online copy</h3>
    <p class="menu-facts">A copy of this workspace on GitHub, GitLab or any git server. Each save goes there, and Sync brings in what others put there, so you meet even when your computers cannot reach each other.</p>
    <ul v-if="copies.length" class="menu-devices">
      <li v-for="c in copies" :key="c.name" :data-testid="`online:${c.name}`" :title="c.error ?? ''">
        <span :class="['device-dot', { online: !c.error && !!c.lastSync }]" aria-hidden="true" />
        <code class="device-who">{{ c.url }}</code>
        <span class="device-state">{{ state(c) }}</span>
        <button v-if="canManage" type="button" :disabled="busy" @click="act(() => api.removeOnline(c.name))">Remove</button>
      </li>
    </ul>
    <p v-for="c in copies.filter((x) => x.error)" :key="`e-${c.name}`" class="menu-facts person-error">{{ c.error }}</p>
    <template v-if="canManage && !copies.length">
      <form class="person-row" @submit.prevent="add">
        <input v-model="target" placeholder="git@github.com:you/notes.git" spellcheck="false" aria-label="The address of a git repository for the online copy" data-testid="online-target">
        <button type="submit" :disabled="busy" data-testid="online-add">Add</button>
      </form>
      <p class="menu-facts">Make an empty repository on GitHub or GitLab first, and paste its address. Your own git sign-in is used (an SSH key, or a credential helper for https).</p>
    </template>
    <p v-if="error" class="banner warn">{{ error }}</p>
  </section>
</template>
