<script setup lang="ts">
// The menu's Backups section: git servers this workspace is pushed to (GitHub,
// GitLab, any git host), and nothing more: they receive, they never send back.
// Everyone sees them and may ask for a push now; adding and removing them is for
// whoever runs the host (the desktop app, pnpm dev), with their git credentials.
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { BackupInfo, HostApi } from './api.js';
import { time } from './labels.js';

const props = defineProps<{ api: HostApi }>();
const backups = shallowRef<BackupInfo[]>([]);
const canManage = ref(false);
const known = ref(false);
const target = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function load() {
  try {
    const r = await props.api.backups();
    backups.value = r.backups;
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

async function act(fn: () => Promise<BackupInfo[]>) {
  busy.value = true;
  error.value = null;
  try {
    backups.value = await fn();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function add() {
  if (!target.value.trim()) return;
  await act(() => props.api.addBackup(target.value.trim()));
  if (!error.value) target.value = '';
}
</script>

<template>
  <section v-if="known && (backups.length || canManage)" class="menu-section" data-testid="backups">
    <h3>Backups</h3>
    <p class="menu-facts">Git servers this workspace is pushed to after each save, and nothing more: nothing comes back from them.</p>
    <ul v-if="backups.length" class="menu-devices">
      <li v-for="b in backups" :key="b.name" :data-testid="`backup:${b.name}`" :title="b.error ?? ''">
        <span :class="['device-dot', { online: !b.error && !!b.lastPush }]" aria-hidden="true" />
        <code>{{ b.url }}</code>
        <span class="device-state">{{ b.pushing ? 'pushing…' : b.error ? 'not backed up' : b.lastPush ? `backed up ${time(b.lastPush)}` : 'not yet' }}</span>
        <button v-if="canManage" type="button" :disabled="busy" @click="act(() => api.removeBackup(b.name))">Remove</button>
      </li>
    </ul>
    <p v-for="b in backups.filter((x) => x.error)" :key="`e-${b.name}`" class="menu-facts person-error">{{ b.name }}: {{ b.error }}</p>
    <form v-if="canManage" class="person-row" @submit.prevent="add">
      <input v-model="target" placeholder="git@github.com:you/notes.git" spellcheck="false" aria-label="A git repository to back up to" data-testid="backup-target">
      <button type="submit" :disabled="busy" data-testid="backup-add">Add</button>
    </form>
    <p v-if="canManage" class="menu-facts">An empty repository is best (make one on GitHub or GitLab first). It is pushed to with your own git credentials: an SSH key, or a credential helper for https.</p>
    <div v-if="backups.length" class="menu-actions"><button type="button" :disabled="busy" data-testid="backup-now" @click="act(() => api.backUpNow())">Back up now</button></div>
    <p v-if="error" class="banner warn">{{ error }}</p>
  </section>
</template>
