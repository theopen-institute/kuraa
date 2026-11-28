<script setup lang="ts">
// Settings › Workspace's Lost or stolen computers and servers (decision 0107):
// blocking a computer's or a server's key, for good, set apart at the end of
// Workspace settings and closed, since it is for a key someone else may have,
// not for taking someone out (People's Remove…, which can be undone). A
// computer's key, or a server's, is one for all its workspaces: blocked here, it
// never syncs with this one again, and using it here again takes a new key. Who
// may block: a computer's own person (whose identity, kept here, also revokes
// its key everywhere), or an admin (the owner, for an admin's computer); a
// server, the owner (0099).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo } from './api.js';
import { askConfirm } from './ask.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi }>();
const info = shallowRef<PeersInfo | null>(null);
const busy = ref(false);
const error = shallowRef<unknown>(null);
/** What was done last, to say (a computer blocked, and whether its key was revoked everywhere). */
const note = ref<string | null>(null);

async function load() {
  try {
    info.value = await props.api.peers();
  } catch {
    info.value = null;
  }
}
// Again every few seconds, as People does: who may block what changes as roles do.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));

type Info = Extract<PeersInfo, { enabled: true }>;
type Device = Info['devices'][number];
type Someone = NonNullable<Info['people']>['people'][number];

const enabled = computed(() => (info.value?.enabled ? info.value : null));
/** The person a computer is, as the workspace's people list them. */
const whose = (i: Info, d: Device): Someone | undefined => i.people?.people.find((p) => p.devices.includes(d.key));
/** Whether you may block a computer: an admin (the owner, for an admin's), or it is yours (0068, 0070). */
function mayBlock(i: Info, d: Device): boolean {
  if (!i.canInvite || i.removed || d.server) return false;
  const p = whose(i, d);
  if (p?.you) return true;
  const admin = i.people?.admin ?? true;
  return admin && (!p || p.role === 'member' || !!i.people?.assignsAdmins);
}
/** The computers you may block, each with whose it is. */
const computers = computed(() => {
  const i = enabled.value;
  if (!i?.people?.founded) return [];
  return i.devices.filter((d) => mayBlock(i, d)).map((d) => ({ d, p: whose(i, d) }))
    .sort((a, b) => (a.p?.name ?? '').localeCompare(b.p?.name ?? '') || a.d.name.localeCompare(b.d.name));
});
/** The servers you may block: the owner's (0099). */
const servers = computed(() => {
  const i = enabled.value;
  if (!i?.people?.founded || !i.people.managesServers || !i.canInvite || i.removed) return [];
  return (i.people.servers ?? []).filter((s) => !s.you);
});
const shown = computed(() => !!enabled.value?.people?.founded && (computers.value.length > 0 || servers.value.length > 0 || !!note.value));

async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = null;
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = e;
  } finally {
    busy.value = false;
  }
}

async function blockComputer(d: Device, p: Someone | undefined) {
  const own = p?.you ?? false;
  const ok = await askConfirm(own ? S.keys.blockOwnAsk(d.name) : S.keys.blockAsk(p ? S.devices.on(p.name ?? S.people.unknown, d.name) : d.name), S.keys.blockButton, true);
  if (!ok) return;
  note.value = null;
  await act(async () => {
    const r = await props.api.removeDevice(d.key);
    note.value = own ? (r.revoked ? S.keys.blockedRevoked(d.name) : S.keys.blockedNotRevoked(d.name)) : null;
  });
}

async function blockServer(s: { key: string; name: string }) {
  const ok = await askConfirm(S.keys.blockServerAsk(s.name), S.keys.blockButton, true);
  if (ok) await act(() => props.api.removeServer(s.key, true));
}
</script>

<template>
  <details v-if="shown" class="settings-part menu-details keys-section" data-testid="keys" @toggle="($event.target as HTMLDetailsElement).open && load()">
    <summary data-testid="keys-summary">{{ S.keys.title }}</summary>
    <div class="keys-body">
      <p class="menu-facts">{{ S.keys.about }}</p>
      <ul v-if="computers.length || servers.length" class="menu-devices" data-testid="keys-list">
        <li v-for="{ d, p } in computers" :key="d.key" :data-testid="`key:${d.name}`">
          <span class="device-who">{{ p ? S.devices.on(p.name ?? S.people.unknown, d.name) : d.name }}</span>
          <button type="button" class="danger" :disabled="busy" :data-testid="`block:${d.name}`" @click="blockComputer(d, p)">{{ S.keys.block }}</button>
        </li>
        <li v-for="s in servers" :key="s.key" :data-testid="`key-server:${s.name}`">
          <span class="device-who">{{ s.name }}</span>
          <span class="device-tag">{{ S.keys.server }}</span>
          <button type="button" class="danger" :disabled="busy" :data-testid="`block-server:${s.name}`" @click="blockServer(s)">{{ S.keys.block }}</button>
        </li>
      </ul>
      <p v-else class="menu-facts">{{ S.keys.none }}</p>
      <p v-if="note" class="menu-facts" role="status" data-testid="device-note">{{ note }}</p>
      <ErrorBanner v-if="error" :error="error" inline />
    </div>
  </details>
</template>

<style scoped>
.keys-section summary { font-size: 13px; }
.keys-body { display: grid; gap: 8px; color: var(--text); }
.keys-body .menu-devices button { margin-left: auto; }
.keys-body button.danger { color: var(--warn); }
</style>
