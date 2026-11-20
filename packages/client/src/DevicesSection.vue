<script setup lang="ts">
// The menu's Devices section: who is in the workspace, by person and computer,
// and who is online. Every member has the same say (0038): where the operator
// allows it, anyone here may invite people, remove a device (for good; it keeps
// its copy) and rename this one.
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo } from './api.js';
import { askConfirm, askText } from './ask.js';

const props = defineProps<{ api: HostApi }>();
const emit = defineEmits<{ invite: [] }>();
const info = shallowRef<PeersInfo | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

async function load() {
  try {
    info.value = await props.api.peers();
  } catch {
    info.value = null;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));

type Device = Extract<PeersInfo, { enabled: true }>['devices'][number];
/** A device as people know it: whose it is, and which computer. */
const label = (d: { name: string; person: string | null }) => (d.person ? `${d.person} on ${d.name}` : d.name);

async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = null;
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function remove(d: Device) {
  const ok = await askConfirm(
    `Remove ${label(d)} from this workspace? This is permanent: it will no longer sync with anyone here, and cannot join again with an old link. Whoever uses it keeps their copy of everything up to now.`,
    'Remove',
    true,
  );
  if (ok) await act(() => props.api.removeDevice(d.key));
}

async function rename(current: string) {
  const name = (await askText('What should this computer be called here?', current, 'Rename'))?.trim();
  if (name && name !== current) await act(() => props.api.renameDevice(name));
}

const online = (i: Extract<PeersInfo, { enabled: true }>) => i.devices.filter((d) => d.online && !d.related).length;
</script>

<template>
  <section v-if="info && !info.enabled && info.canInvite" class="menu-section" data-testid="devices">
    <h3>Devices</h3>
    <p class="menu-facts">This workspace is on this computer only. Invite people to work on it with you, from their own computers.</p>
    <div class="menu-actions"><button type="button" data-testid="invite-button" @click="emit('invite')">Invite people…</button></div>
  </section>
  <section v-if="info?.enabled" class="menu-section" data-testid="devices">
    <h3>Devices</h3>
    <p class="menu-facts" data-testid="this-device">
      You are on {{ info.device.name }}.
      <template v-if="info.devices.length">{{ online(info) }} of {{ info.devices.length }} other device{{ info.devices.length === 1 ? '' : 's' }} online.</template>
      <template v-else>No one else has joined yet.</template>
    </p>
    <ul v-if="info.devices.length" class="menu-devices">
      <li v-for="d in info.devices" :key="d.key" :data-testid="`device:${d.name}`">
        <span :class="['device-dot', { online: d.online }]" aria-hidden="true" />
        <span class="device-who">{{ label(d) }}</span>
        <span v-if="d.related" class="device-tag" title="A separate copy made from this workspace: its work does not come in on its own.">separate copy</span>
        <span v-if="d.otherVersion" class="device-tag" title="It runs another version of kuraa, which merges differently. Work done apart still comes together: one of the two makes the merges, and the other takes them.">other version</span>
        <span class="device-state">{{ d.online ? 'online' : 'offline' }}</span>
        <button v-if="info.canInvite" type="button" :disabled="busy" :data-testid="`remove:${d.name}`" @click="remove(d)">Remove…</button>
      </li>
    </ul>
    <div v-if="info.canInvite" class="menu-actions">
      <button type="button" data-testid="invite-button" @click="emit('invite')">Invite people…</button>
      <button type="button" :disabled="busy" data-testid="rename-device" @click="rename(info.device.name)">Rename this computer…</button>
    </div>
    <p v-if="error" class="banner warn">{{ error }}</p>
  </section>
</template>
