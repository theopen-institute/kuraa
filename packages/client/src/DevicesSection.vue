<script setup lang="ts">
// The menu's Devices section: who is in the workspace, by person and computer,
// and who is online. Every member has the same say (0038): where the operator
// allows it, anyone here may invite people, remove a device (for good; it keeps
// its copy) and rename this one.
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo } from './api.js';
import { askConfirm, askText } from './ask.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi }>();
const emit = defineEmits<{ invite: [] }>();
const info = shallowRef<PeersInfo | null>(null);
const busy = ref(false);
const error = shallowRef<unknown>(null);

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
const label = (d: { name: string; person: string | null }) => (d.person ? S.devices.on(d.person, d.name) : d.name);

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

async function remove(d: Device) {
  const ok = await askConfirm(S.devices.removeAsk(label(d)), S.common.remove, true);
  if (ok) await act(() => props.api.removeDevice(d.key));
}

async function rename(current: string) {
  const name = (await askText(S.devices.renameAsk, current, S.common.rename))?.trim();
  if (name && name !== current) await act(() => props.api.renameDevice(name));
}

const online = (i: Extract<PeersInfo, { enabled: true }>) => i.devices.filter((d) => d.online && !d.related).length;
</script>

<template>
  <section v-if="info && !info.enabled && info.canInvite" class="menu-section" data-testid="devices">
    <h3>{{ S.devices.title }}</h3>
    <p class="menu-facts">{{ S.devices.alone }}</p>
    <div class="menu-actions"><button type="button" data-testid="invite-button" @click="emit('invite')">{{ S.devices.invite }}</button></div>
  </section>
  <section v-if="info?.enabled" class="menu-section" data-testid="devices">
    <h3>{{ S.devices.title }}</h3>
    <p class="menu-facts" data-testid="this-device">
      {{ S.devices.youAreOn(info.device.name) }}
      <template v-if="info.devices.length">{{ S.devices.online(online(info), info.devices.length) }}</template>
      <template v-else>{{ S.devices.nobody }}</template>
    </p>
    <ul v-if="info.devices.length" class="menu-devices">
      <li v-for="d in info.devices" :key="d.key" :data-testid="`device:${d.name}`">
        <span :class="['device-dot', { online: d.online }]" aria-hidden="true" />
        <span class="device-who">{{ label(d) }}</span>
        <span v-if="d.related" class="device-tag" :title="S.devices.separateTitle">{{ S.devices.separate }}</span>
        <span v-if="d.otherVersion" class="device-tag" :title="S.devices.otherVersionTitle">{{ S.devices.otherVersion }}</span>
        <span class="device-state">{{ d.online ? S.devices.isOnline : S.devices.isOffline }}</span>
        <button v-if="info.canInvite" type="button" :disabled="busy" :data-testid="`remove:${d.name}`" @click="remove(d)">{{ S.common.removeEllipsis }}</button>
      </li>
    </ul>
    <div v-if="info.canInvite" class="menu-actions">
      <button type="button" data-testid="invite-button" @click="emit('invite')">{{ S.devices.invite }}</button>
      <button type="button" :disabled="busy" data-testid="rename-device" @click="rename(info.device.name)">{{ S.devices.rename }}</button>
    </div>
    <ErrorBanner v-if="error" :error="error" inline />
  </section>
</template>
