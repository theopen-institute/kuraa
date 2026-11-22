<script setup lang="ts">
// Settings › Workspace's Devices (decision 0064): who is in the workspace, by person and computer,
// and who is online. Its people, as the workspace's policy says (0066), with
// their role: admins invite people, remove a device (for good; it keeps its
// copy), and make others admins or members or take them out. Anyone renames
// this device. With no policy yet, everyone has the same say (0038).
import { computed, onMounted, onBeforeUnmount, ref, shallowRef } from 'vue';
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

/** Whether you may invite and remove here: an admin, or anyone where there is no policy yet. */
const admin = computed(() => (info.value?.enabled ? info.value.people?.admin ?? true : true));
type Someone = NonNullable<Extract<PeersInfo, { enabled: true }>['people']>['people'][number];
const nameOf = (p: Someone) => p.name ?? S.people.unknown;

async function setRole(p: Someone, role: 'admin' | 'member') {
  await act(() => props.api.setRole(p.id, role));
}

async function removePerson(p: Someone) {
  const ok = await askConfirm(S.people.removeAsk(nameOf(p)), S.common.remove, true);
  if (ok) await act(() => props.api.removePerson(p.id));
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
/** How long no other device may be connected before the section says this device may have been removed. */
const NO_CONTACT_MS = 30 * 60_000;
/** Since when no device has connected, as words, once that is long enough to mention (and the network is not the reason). */
const noContact = (i: Extract<PeersInfo, { enabled: true }>) =>
  !i.removed && i.noContactSince && Date.now() - i.noContactSince >= NO_CONTACT_MS && i.network?.kind !== 'unreachable'
    ? S.devices.noContact(time(new Date(i.noContactSince).toISOString()))
    : null;
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
      <template v-if="!info.removed">{{ info.devices.length ? S.devices.online(online(info), info.devices.length) : S.devices.nobody }}</template>
    </p>
    <p v-if="info.removed" class="menu-facts warn" role="status" data-testid="device-removed">{{ S.devices.removed }}</p>
    <p v-else-if="noContact(info)" class="menu-facts warn" data-testid="no-contact">{{ noContact(info) }}</p>
    <p v-if="!info.removed && info.network && S.devices.network[info.network.kind]" class="menu-facts warn" data-testid="this-network">{{ S.devices.network[info.network.kind] }}</p>
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
        <button v-if="info.canInvite && !info.removed && admin" type="button" :disabled="busy" :data-testid="`remove:${d.name}`" @click="remove(d)">{{ S.common.removeEllipsis }}</button>
      </li>
    </ul>
    <template v-if="info.people?.founded && info.people.people.length">
      <h3>{{ S.people.title }}</h3>
      <ul class="menu-devices" data-testid="people">
        <li v-for="p in info.people.people" :key="p.id" :data-testid="`person:${nameOf(p)}`">
          <span class="device-who">{{ nameOf(p) }}<template v-if="p.you">{{ S.people.you }}</template></span>
          <span class="device-tag" :title="p.role === 'admin' ? S.people.adminTitle : undefined" :data-testid="`role:${nameOf(p)}`">{{ p.role === 'admin' ? S.people.admin : S.people.member }}</span>
          <template v-if="admin && info.canInvite && !info.removed && !p.you">
            <button type="button" :disabled="busy" :data-testid="`make-${p.role === 'admin' ? 'member' : 'admin'}:${nameOf(p)}`" @click="setRole(p, p.role === 'admin' ? 'member' : 'admin')">{{ p.role === 'admin' ? S.people.makeMember : S.people.makeAdmin }}</button>
            <button type="button" :disabled="busy" :data-testid="`remove-person:${nameOf(p)}`" @click="removePerson(p)">{{ S.common.removeEllipsis }}</button>
          </template>
        </li>
      </ul>
    </template>
    <p v-for="(d, i) in info.people?.disputes ?? []" :key="i" class="menu-facts warn" :data-testid="`dispute:${i}`">{{ S.people.dispute(d) }}</p>
    <p v-if="!admin && !info.removed" class="menu-facts" data-testid="not-admin">{{ S.devices.notAdmin }}</p>
    <!-- A removed device's invitations and removals are refused by the others: none offered. -->
    <div v-if="info.canInvite && !info.removed" class="menu-actions">
      <button v-if="admin" type="button" data-testid="invite-button" @click="emit('invite')">{{ S.devices.invite }}</button>
      <button type="button" :disabled="busy" data-testid="rename-device" @click="rename(info.device.name)">{{ S.devices.rename }}</button>
    </div>
    <ErrorBanner v-if="error" :error="error" inline />
  </section>
</template>
