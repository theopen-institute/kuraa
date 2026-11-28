<script setup lang="ts">
// A person's or a server's own view (decision 0107), opened from Workspace
// settings' People in its place, with a way back: their role (a menu for whoever
// may change it), whether they are online, and each of their computers (a
// server: its device here), how each is connected; this computer renamed here.
// Each computer may be said to be lost or stolen, which blocks its key (0072),
// for good; and the person, or the server, removed from the workspace, which
// can be undone by inviting them again. Neither is offered in the list, where a
// click is easily made.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo } from './api.js';
import { askConfirm, askText } from './ask.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';
import {
  deviceState, kindWord, managesServers, mayBlock, mayManagePerson, memberDevices, memberName, members, memberState, nameOf, rolesFor,
  type Device, type Info, type Member, type RoleChoice, type Who,
} from './peopleView.js';

const props = defineProps<{ api: HostApi; who: Who }>();
const emit = defineEmits<{ back: [] }>();
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
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));

const i = computed<Info | null>(() => (info.value?.enabled ? info.value : null));
/** The one this view is of, as the workspace has them now; none once they are out. */
const m = computed<Member | null>(() => (i.value ? members(i.value).find((x) => x.kind === props.who.kind && x.id === props.who.id) ?? null : null));
const devices = computed<Device[]>(() => (i.value && m.value ? memberDevices(i.value, m.value) : []));
const you = computed(() => !!m.value && (m.value.kind === 'person' ? m.value.p.you : m.value.s.you));

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

/** A role chosen from the menu: made at once, but the owner's, which asks first (handing it over). */
async function chooseRole(e: Event) {
  if (m.value?.kind !== 'person') return;
  const p = m.value.p;
  const menu = e.target as HTMLSelectElement;
  const role = menu.value as RoleChoice;
  if (role === 'owner') {
    const ok = await askConfirm(S.people.makeOwnerAsk(nameOf(p)), S.people.makeOwner, true);
    if (ok) await act(() => props.api.makeOwner(p.id));
    else menu.value = p.role;
  } else if (role !== p.role) {
    await act(() => props.api.setRole(p.id, role));
  }
}

/** Whether this computer (or server's device) may be said to be lost or stolen here. */
const mayBlockDevice = (d: Device) => {
  if (!i.value || !m.value) return false;
  return m.value.kind === 'person' ? mayBlock(i.value, m.value.p, d) : managesServers(i.value) && !m.value.s.you;
};
async function lostOrStolen(d: Device) {
  if (!m.value) return;
  if (m.value.kind === 'server') {
    const s = m.value.s;
    if (await askConfirm(S.keys.blockServerAsk(s.name), S.keys.blockButton, true)) await act(() => props.api.removeServer(s.key, true));
    return;
  }
  const own = m.value.p.you;
  const ok = await askConfirm(own ? S.keys.blockOwnAsk(d.name) : S.keys.blockAsk(S.devices.on(nameOf(m.value.p), d.name)), S.keys.blockButton, true);
  if (!ok) return;
  note.value = null;
  await act(async () => {
    const r = await props.api.removeDevice(d.key);
    note.value = own ? (r.revoked ? S.keys.blockedRevoked(d.name) : S.keys.blockedNotRevoked(d.name)) : null;
  });
}

const mayRemove = computed(() => !!i.value && !!m.value && (m.value.kind === 'person' ? mayManagePerson(i.value, m.value.p) : managesServers(i.value) && !m.value.s.you));
async function remove() {
  if (!m.value) return;
  const target = m.value;
  const ok = await askConfirm(target.kind === 'person' ? S.people.removeAsk(nameOf(target.p)) : S.servers.removeAsk(target.s.name), S.common.remove, true);
  if (!ok) return;
  await act(() => (target.kind === 'person' ? props.api.removePerson(target.p.id) : props.api.removeServer(target.s.key, false)));
  if (!error.value) emit('back');
}

async function rename(current: string) {
  const name = (await askText(S.devices.renameAsk, current, S.common.rename))?.trim();
  if (name && name !== current) await act(() => props.api.renameDevice(name));
}
</script>

<template>
  <div class="member-view" :data-testid="`member-view:${m ? memberName(m) : who.id}`">
    <div class="subpanel-head">
      <button type="button" class="subpanel-back" data-testid="member-back" @click="emit('back')">{{ S.person.back(S.sections.workspace) }}</button>
      <h4 data-testid="member-title">{{ m ? memberName(m) : '' }}<template v-if="m?.kind === 'person' && m.p.you">{{ S.people.you }}</template></h4>
    </div>
    <section v-if="i && m" class="settings-part member-part">
      <div class="member-facts">
        <span class="member-label">{{ S.people.role }}</span>
        <!-- Their role: a menu for whoever may change it, else said (0070). -->
        <select
          v-if="m.kind === 'person' && rolesFor(i, m.p).length"
          class="role-menu"
          :value="m.p.role"
          :disabled="busy"
          :aria-label="S.people.roleOf(nameOf(m.p))"
          data-testid="member-role"
          @change="chooseRole"
        >
          <option v-for="r in rolesFor(i, m.p)" :key="r" :value="r">{{ S.people.roleChoice[r] }}</option>
        </select>
        <span v-else class="device-tag" data-testid="member-role">{{ kindWord(m) }}</span>
        <span :class="['device-dot', 'member-dot', memberState(i, m).dot]" aria-hidden="true" />
        <span class="member-state" data-testid="member-state">{{ memberState(i, m).text }}</span>
      </div>
      <p class="menu-facts">{{ m.kind === 'server' ? S.servers.about : m.p.role === 'owner' ? S.people.ownerTitle : m.p.role === 'admin' ? S.people.adminTitle : S.people.memberTitle }}</p>

      <h4 class="menu-subhead">{{ m.kind === 'server' ? S.people.serverDevices : S.people.computersOf }}</h4>
      <ul class="menu-devices" data-testid="member-devices">
        <li v-if="you && m.kind === 'person'" data-testid="device-self">
          <span class="device-dot online" aria-hidden="true" />
          <span class="device-who">{{ i.device.name }}</span>
          <span class="device-state">{{ S.devices.thisComputer }}</span>
          <button v-if="i.canInvite && !i.removed" type="button" :disabled="busy" data-testid="rename-device" @click="rename(i.device.name)">{{ S.devices.renameShort }}</button>
        </li>
        <li v-if="you && m.kind === 'server'">
          <span class="device-dot online" aria-hidden="true" />
          <span class="device-who">{{ i.device.name }}</span>
          <span class="device-state">{{ S.devices.thisComputer }}</span>
        </li>
        <li v-for="d in devices" :key="d.key" :data-testid="`device:${d.name}`">
          <span :class="['device-dot', { online: d.online, through: !d.online && d.through.length }]" aria-hidden="true" />
          <span class="device-who">{{ d.name }}</span>
          <span v-if="d.related" class="device-tag" :title="S.devices.separateTitle">{{ S.devices.separate }}</span>
          <span v-if="d.otherVersion" class="device-tag" :title="S.devices.otherVersionTitle">{{ S.devices.otherVersion }}</span>
          <span v-if="d.kuraa" class="device-tag warn" :title="d.kuraa === 'newer' ? S.devices.newerTitle : S.devices.olderTitle" :data-testid="`kuraa:${d.name}`">{{ d.kuraa === 'newer' ? S.devices.newer : S.devices.older }}</span>
          <span class="device-state" :title="deviceState(i, d).title" :data-testid="`state:${d.name}`">{{ deviceState(i, d).text }}</span>
          <button v-if="mayBlockDevice(d)" type="button" class="lost" :disabled="busy" :title="S.keys.lostTitle" :data-testid="`lost:${d.name}`" @click="lostOrStolen(d)">{{ S.keys.lost }}</button>
        </li>
        <li v-if="!devices.length && !you" class="muted">{{ S.people.noComputers }}</li>
      </ul>
      <p v-if="note" class="menu-facts" role="status" data-testid="device-note">{{ note }}</p>

      <div v-if="mayRemove" class="member-remove">
        <button type="button" class="danger" :disabled="busy" data-testid="member-remove" @click="remove">{{ m.kind === 'server' ? S.servers.removeFromWorkspace : S.people.removeFromWorkspace }}</button>
        <span class="menu-facts">{{ m.kind === 'server' ? S.servers.removeAbout : S.people.removeAbout }}</span>
      </div>
      <ErrorBanner v-if="error" :error="error" inline />
    </section>
    <p v-else-if="info" class="menu-facts" data-testid="member-gone">{{ S.people.gone }}</p>
  </div>
</template>

<style scoped>
.member-part { gap: 10px; }
.member-facts { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.member-label { color: var(--muted); }
.member-dot { margin-left: 12px; }
.member-state { color: var(--muted); }
.member-view .menu-devices .device-state { margin-left: auto; }
.member-view .menu-devices button.lost { color: var(--warn); }
.member-remove { display: grid; gap: 4px; justify-items: start; padding-top: 10px; border-top: 1px solid var(--border); }
.member-remove button.danger { color: var(--warn); }
</style>
