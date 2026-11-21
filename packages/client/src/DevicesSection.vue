<script setup lang="ts">
// The menu's Devices section: who is in the workspace, by person and computer,
// and who is online. Every member has the same say (0038): on every hub (0047),
// anyone here may invite people, remove a device (for good; it keeps its copy)
// and rename this one.
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo } from './api.js';
import { askConfirm, askText } from './ask.js';
import { time } from './labels.js';
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

/** Online: connected here, or to a device connected here that says so. */
const online = (i: Extract<PeersInfo, { enabled: true }>) => i.devices.filter((d) => (d.online || d.through.length) && !d.related).length;
/** How a device online is connected, in words (0053). */
const viaText = (d: Device) => (d.via === 'lan' ? S.devices.viaLan : d.via === 'tcp' ? S.devices.viaTcp : d.via === 'tunnel' ? S.devices.viaTunnel : S.devices.isOnline);
const viaTitle = (d: Device) => (d.via === 'lan' ? S.devices.viaLanTitle : d.via === 'tcp' ? S.devices.viaTcpTitle : d.via === 'tunnel' ? S.devices.viaTunnelTitle : undefined);
/** The devices a device not connected here is reached through, by name. */
const via = (i: Extract<PeersInfo, { enabled: true }>, d: Device) => d.through.map((k) => i.devices.find((x) => x.key === k)).filter((x) => !!x).map(label).join(', ');
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
    <p v-if="info.network && S.devices.network[info.network.kind]" class="menu-facts warn" data-testid="this-network">{{ S.devices.network[info.network.kind] }}</p>
    <ul v-if="info.devices.length" class="menu-devices">
      <li v-for="d in info.devices" :key="d.key" :data-testid="`device:${d.name}`">
        <span :class="['device-dot', { online: d.online, through: !d.online && d.through.length }]" aria-hidden="true" />
        <span class="device-who">{{ label(d) }}</span>
        <span v-if="d.related" class="device-tag" :title="S.devices.separateTitle">{{ S.devices.separate }}</span>
        <span v-if="d.otherVersion" class="device-tag" :title="S.devices.otherVersionTitle">{{ S.devices.otherVersion }}</span>
        <span v-if="d.kuraa" class="device-tag warn" :title="d.kuraa === 'newer' ? S.devices.newerTitle : S.devices.olderTitle" :data-testid="`kuraa:${d.name}`">{{ d.kuraa === 'newer' ? S.devices.newer : S.devices.older }}</span>
        <span v-if="d.online" class="device-state" :title="viaTitle(d)" :data-testid="`state:${d.name}`">{{ viaText(d) }}</span>
        <span v-else-if="d.through.length" class="device-state" :title="S.devices.throughTitle(via(info, d))" :data-testid="`through:${d.name}`">{{ S.devices.through(via(info, d)) }}</span>
        <span v-else class="device-state" :data-testid="`state:${d.name}`">{{ d.lastSeen ? S.devices.lastSeen(time(new Date(d.lastSeen).toISOString())) : S.devices.isOffline }}</span>
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
