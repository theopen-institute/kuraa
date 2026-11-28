<script setup lang="ts">
// Settings › Workspace's People (decisions 0064, 0068, 0107): who is in the
// workspace, each person on a line with their role and whether they are online
// (from their computers); admins invite people, make others admins or members,
// and remove them (they can be invited back). Servers (0099), in as themselves,
// are beneath the people: the owner adds one (an invite link for one server, to
// give to kuraa-server join) and removes one (it can be invited back). Each
// person's computers are in a disclosure beneath (Computers), with this one,
// renamed there. Blocking a lost or stolen computer's or server's key is set
// apart, at the end of Workspace settings (KeysSection). With no policy yet,
// everyone has the same say (0038), and the computers are all there is: shown.
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

type Info = Extract<PeersInfo, { enabled: true }>;
type Device = Info['devices'][number];
type Someone = NonNullable<Info['people']>['people'][number];
type Server = NonNullable<Info['people']>['servers'] extends (infer T)[] | undefined ? T : never;

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

/** A person's computers, but this one (shown apart, as this computer). */
const devicesOf = (i: Info, p: Someone) => i.devices.filter((d) => p.devices.includes(d.key));
/** The people with a computer to list: you (this one), and anyone with one known here. */
const withComputers = (i: Info) => (i.people?.people ?? []).filter((p) => p.you || devicesOf(i, p).length);
/** Computers no person here is known to be, nor a server: listed apart (all of them, where there is no policy). */
const others = (i: Info) => i.devices.filter((d) => !d.server && !(i.people?.founded && i.people.people.some((p) => p.devices.includes(d.key))));

/**
 * Whether someone is online, and how that is said, from their computers: this
 * one, any online (or reached through another), else the latest seen.
 */
function stateOf(i: Info, p: Someone): { dot: 'online' | 'through' | null; text: string } {
  if (p.you) return { dot: 'online', text: S.devices.isOnline };
  const ds = devicesOf(i, p);
  if (ds.some((d) => d.online)) return { dot: 'online', text: S.devices.isOnline };
  if (ds.some((d) => d.through.length)) return { dot: 'through', text: S.devices.isOnline };
  const seen = Math.max(0, ...ds.map((d) => d.lastSeen ?? 0));
  return { dot: null, text: seen ? S.devices.lastSeen(time(new Date(seen).toISOString())) : S.devices.isOffline };
}
/** A computer of someone's running another Kuraa, that does not sync with this one: said on their line. */
const kuraaOf = (i: Info, p: Someone) => devicesOf(i, p).find((d) => d.kuraa)?.kuraa ?? null;

/** Each server, with its device here (the server's for this workspace; of several, one online first), if this device knows it. */
const serverRows = (i: Info) => (i.people?.servers ?? []).map((s) => {
  const ds = i.devices.filter((d) => s.devices.includes(d.key));
  return { s, d: ds.find((d) => d.online) ?? ds.find((d) => d.through.length) ?? ds[0] };
});
/** Whether you add and remove servers: the owner (0099), on a device still in. */
const managesServers = (i: Info) => !!i.people?.managesServers && i.canInvite && !i.removed;

/** An invite link for a server just made (0099), to give to kuraa-server join. */
const serverLink = ref<string | null>(null);
const copiedLink = ref(false);
async function addServer() {
  copiedLink.value = false;
  await act(async () => {
    serverLink.value = (await props.api.createLink({ hours: 24 * 7, once: true, role: 'server' })).link;
  });
}
async function copyServerLink() {
  if (!serverLink.value) return;
  try {
    await navigator.clipboard.writeText(serverLink.value);
    copiedLink.value = true;
  } catch {
    // No clipboard here: select the text, to copy by hand.
    (document.querySelector('[data-testid=server-link]') as HTMLTextAreaElement | null)?.select();
  }
}
async function removeServer(s: Server) {
  const ok = await askConfirm(S.servers.removeAsk(s.name), S.common.remove, true);
  if (ok) await act(() => props.api.removeServer(s.key, false));
}

/** Whether you may invite here: an admin, or anyone where there is no policy yet. */
const admin = computed(() => (info.value?.enabled ? info.value.people?.admin ?? true : true));
const nameOf = (p: Someone) => p.name ?? S.people.unknown;

/** Whether you may change this person's role, or take them out: admins are the owner's to make and unmake (0070); the owner is no one's. */
const mayManagePerson = (i: Info, p: Someone) => admin.value && i.canInvite && !i.removed && !p.you && p.role !== 'owner' && (p.role === 'member' || !!i.people?.assignsAdmins);

async function makeOwner(p: Someone): Promise<boolean> {
  const ok = await askConfirm(S.people.makeOwnerAsk(nameOf(p)), S.people.makeOwner, true);
  if (ok) await act(() => props.api.makeOwner(p.id));
  return ok;
}

type RoleChoice = 'member' | 'admin' | 'owner';
/**
 * The roles you may choose for this person from their role's menu: admins are
 * the owner's to make and unmake (0070), and the owner hands over theirs. None:
 * their role is shown, not offered.
 */
function rolesFor(i: Info, p: Someone): RoleChoice[] {
  if (p.you || p.role === 'owner' || i.removed || !i.canInvite) return [];
  const mine = i.people?.owner && i.people.owner === i.people.people.find((x) => x.you)?.id;
  const out: RoleChoice[] = [];
  if (admin.value && i.people?.assignsAdmins) out.push('member', 'admin');
  if (mine) out.push('owner');
  return out;
}

/** A role chosen from the menu: made at once, but the owner's, which asks first (handing it over). */
async function chooseRole(p: Someone, e: Event) {
  const menu = e.target as HTMLSelectElement;
  const role = menu.value as RoleChoice;
  if (role === 'owner') {
    if (!(await makeOwner(p))) menu.value = p.role;
  } else if (role !== p.role) {
    await act(() => props.api.setRole(p.id, role));
  }
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
const online = (i: Info) => i.devices.filter((d) => (d.online || d.through.length) && !d.related).length;
/** How a device online is connected, in words (0053). */
const viaText = (d: Device) => (d.via === 'lan' ? S.devices.viaLan : d.via === 'tcp' ? S.devices.viaTcp : d.via === 'tunnel' ? S.devices.viaTunnel : S.devices.isOnline);
const viaTitle = (d: Device) => (d.via === 'lan' ? S.devices.viaLanTitle : d.via === 'tcp' ? S.devices.viaTcpTitle : d.via === 'tunnel' ? S.devices.viaTunnelTitle : undefined);
/** How long no other device may be connected before the section says this device may have been removed. */
const NO_CONTACT_MS = 30 * 60_000;
/** Since when no device has connected, as words, once that is long enough to mention (and the network is not the reason). */
const noContact = (i: Info) =>
  !i.removed && i.noContactSince && Date.now() - i.noContactSince >= NO_CONTACT_MS && i.network?.kind !== 'unreachable'
    ? S.devices.noContact(time(new Date(i.noContactSince).toISOString()))
    : null;
/** The devices a device not connected here is reached through, by name. */
const via = (i: Info, d: Device) => d.through.map((k) => i.devices.find((x) => x.key === k)).filter((x) => !!x).map(label).join(', ');
</script>

<template>
  <section v-if="info && !info.enabled && info.canInvite" class="menu-section" data-testid="devices">
    <h3>{{ S.people.title }}</h3>
    <p class="menu-facts">{{ S.devices.alone }}</p>
    <div class="menu-actions"><button type="button" data-testid="invite-button" @click="emit('invite')">{{ S.devices.invite }}</button></div>
  </section>
  <section v-if="info?.enabled" class="menu-section" data-testid="devices">
    <h3>{{ info.people?.founded ? S.people.title : S.devices.computers }}</h3>
    <p v-if="info.removed" class="menu-facts warn" role="status" data-testid="device-removed">{{ S.devices.removed }}</p>
    <p v-else-if="noContact(info)" class="menu-facts warn" data-testid="no-contact">{{ noContact(info) }}</p>
    <p v-if="!info.removed && info.network && S.devices.network[info.network.kind]" class="menu-facts warn" data-testid="this-network">{{ S.devices.network[info.network.kind] }}</p>

    <!-- The people (0107): one line each, with their role and whether they are online. -->
    <ul v-if="info.people?.founded" class="menu-devices people-list" data-testid="people">
      <li v-for="p in info.people.people" :key="p.id" :data-testid="`person:${nameOf(p)}`">
        <span :class="['device-dot', stateOf(info, p).dot]" aria-hidden="true" />
        <span class="device-who">{{ nameOf(p) }}<template v-if="p.you">{{ S.people.you }}</template></span>
        <!-- Their role: a menu for whoever may change it, else said (0070). -->
        <select
          v-if="rolesFor(info, p).length"
          class="role-menu"
          :value="p.role"
          :disabled="busy"
          :aria-label="S.people.roleOf(nameOf(p))"
          :title="S.people.roleOf(nameOf(p))"
          :data-testid="`role:${nameOf(p)}`"
          @change="chooseRole(p, $event)"
        >
          <option v-for="r in rolesFor(info, p)" :key="r" :value="r">{{ S.people.roleChoice[r] }}</option>
        </select>
        <span v-else class="device-tag" :title="p.role === 'owner' ? S.people.ownerTitle : p.role === 'admin' ? S.people.adminTitle : undefined" :data-testid="`role:${nameOf(p)}`">{{ p.role === 'owner' ? S.people.owner : p.role === 'admin' ? S.people.admin : S.people.member }}</span>
        <span v-if="kuraaOf(info, p)" class="device-tag warn" :title="kuraaOf(info, p) === 'newer' ? S.devices.newerTitle : S.devices.olderTitle">{{ kuraaOf(info, p) === 'newer' ? S.devices.newer : S.devices.older }}</span>
        <span class="device-state" :data-testid="`person-state:${nameOf(p)}`">{{ stateOf(info, p).text }}</span>
        <button v-if="mayManagePerson(info, p)" type="button" :disabled="busy" :data-testid="`remove-person:${nameOf(p)}`" @click="removePerson(p)">{{ S.people.removeEllipsis }}</button>
      </li>
    </ul>

    <!-- Servers (0099): in as themselves, beneath the people. -->
    <template v-if="info.people?.founded && (info.people.servers?.length || managesServers(info))">
      <h4 class="menu-subhead" :title="S.servers.about">{{ S.servers.title }}</h4>
      <p v-if="info.people.servers?.some((s) => s.you)" class="menu-facts" data-testid="this-is-a-server">{{ S.servers.youAre }}</p>
      <ul v-if="info.people.servers?.length" class="menu-devices" data-testid="servers">
        <li v-for="{ s, d } in serverRows(info)" :key="s.key" :data-testid="`server:${s.name}`">
          <span :class="['device-dot', { online: s.you || d?.online, through: d && !d.online && d.through.length }]" aria-hidden="true" />
          <span class="device-who" :title="S.servers.about">{{ s.name }}</span>
          <span v-if="s.you" class="device-state">{{ S.devices.thisComputer }}</span>
          <template v-else-if="d">
            <span v-if="d.kuraa" class="device-tag warn" :title="d.kuraa === 'newer' ? S.devices.newerTitle : S.devices.olderTitle">{{ d.kuraa === 'newer' ? S.devices.newer : S.devices.older }}</span>
            <span v-if="d.online" class="device-state" :title="viaTitle(d)" :data-testid="`server-state:${s.name}`">{{ viaText(d) }}</span>
            <span v-else-if="d.through.length" class="device-state" :data-testid="`server-state:${s.name}`">{{ S.devices.through(via(info, d)) }}</span>
            <span v-else class="device-state" :data-testid="`server-state:${s.name}`">{{ d.lastSeen ? S.devices.lastSeen(time(new Date(d.lastSeen).toISOString())) : S.devices.isOffline }}</span>
          </template>
          <span v-else class="device-state" :data-testid="`server-state:${s.name}`">{{ S.devices.isOffline }}</span>
          <button v-if="managesServers(info) && !s.you" type="button" :disabled="busy" :data-testid="`remove-server:${s.name}`" @click="removeServer(s)">{{ S.servers.remove }}</button>
        </li>
      </ul>
      <div v-if="serverLink" class="server-link" data-testid="server-link-box">
        <label class="field">
          <span>{{ S.servers.linkFor }}</span>
          <textarea :value="serverLink" readonly rows="3" spellcheck="false" data-testid="server-link" @focus="($event.target as HTMLTextAreaElement).select()" />
        </label>
        <p class="menu-facts">{{ S.servers.howToUse }}</p>
        <div class="menu-actions">
          <button type="button" data-testid="copy-server-link" @click="copyServerLink">{{ copiedLink ? S.servers.copied : S.servers.copy }}</button>
          <button type="button" @click="serverLink = null">{{ S.servers.done }}</button>
        </div>
      </div>
    </template>

    <p v-if="info.people?.founded && !admin && !info.removed && !info.people?.servers?.some((s) => s.you)" class="menu-facts" data-testid="not-admin">{{ S.devices.notAdmin }}</p>
    <!-- A removed device's invitations are refused by the others: none offered. -->
    <div v-if="info.canInvite && !info.removed && (admin || (info.people?.founded && managesServers(info) && !serverLink))" class="menu-actions">
      <button v-if="admin" type="button" data-testid="invite-button" @click="emit('invite')">{{ S.devices.invite }}</button>
      <button v-if="info.people?.founded && managesServers(info) && !serverLink" type="button" :disabled="busy" data-testid="add-server" @click="addServer">{{ S.servers.add }}</button>
    </div>

    <!-- Everyone's computers (0107): beneath the people, closed; open where there is no policy, and they are all there is. -->
    <details class="menu-details people-computers" :open="!info.people?.founded" data-testid="computers">
      <summary data-testid="computers-summary">{{ info.devices.length && !info.removed ? S.devices.computersSummary(online(info), info.devices.length) : S.devices.computers }}</summary>
      <div class="people-computers-body">
        <p class="menu-facts" data-testid="this-device">
          {{ S.devices.youAreOn(info.device.name) }}
          <template v-if="!info.removed && !info.devices.length">{{ S.devices.nobody }}</template>
        </p>
        <ul v-if="info.people?.founded" class="menu-people">
          <li v-for="p in withComputers(info)" :key="p.id" class="person-block" :data-testid="`computers-of:${nameOf(p)}`">
            <span class="device-who">{{ nameOf(p) }}<template v-if="p.you">{{ S.people.you }}</template></span>
            <ul class="menu-devices person-devices">
              <li v-if="p.you" data-testid="device-self">
                <span class="device-dot online" aria-hidden="true" />
                <span class="device-who">{{ info.device.name }}</span>
                <span class="device-state">{{ S.devices.thisComputer }}</span>
              </li>
              <li v-for="d in devicesOf(info, p)" :key="d.key" :data-testid="`device:${d.name}`">
                <span :class="['device-dot', { online: d.online, through: !d.online && d.through.length }]" aria-hidden="true" />
                <span class="device-who">{{ d.name }}</span>
                <span v-if="d.related" class="device-tag" :title="S.devices.separateTitle">{{ S.devices.separate }}</span>
                <span v-if="d.otherVersion" class="device-tag" :title="S.devices.otherVersionTitle">{{ S.devices.otherVersion }}</span>
                <span v-if="d.kuraa" class="device-tag warn" :title="d.kuraa === 'newer' ? S.devices.newerTitle : S.devices.olderTitle" :data-testid="`kuraa:${d.name}`">{{ d.kuraa === 'newer' ? S.devices.newer : S.devices.older }}</span>
                <span v-if="d.online" class="device-state" :title="viaTitle(d)" :data-testid="`state:${d.name}`">{{ viaText(d) }}</span>
                <span v-else-if="d.through.length" class="device-state" :title="S.devices.throughTitle(via(info, d))" :data-testid="`through:${d.name}`">{{ S.devices.through(via(info, d)) }}</span>
                <span v-else class="device-state" :data-testid="`state:${d.name}`">{{ d.lastSeen ? S.devices.lastSeen(time(new Date(d.lastSeen).toISOString())) : S.devices.isOffline }}</span>
              </li>
            </ul>
          </li>
        </ul>
        <!-- Computers no identity here says whose (all of them, with no policy yet). -->
        <template v-if="others(info).length">
          <h4 v-if="info.people?.founded" class="menu-subhead">{{ S.devices.others }}</h4>
          <ul class="menu-devices">
            <li v-for="d in others(info)" :key="d.key" :data-testid="`device:${d.name}`">
              <span :class="['device-dot', { online: d.online, through: !d.online && d.through.length }]" aria-hidden="true" />
              <span class="device-who">{{ label(d) }}</span>
              <span v-if="d.related" class="device-tag" :title="S.devices.separateTitle">{{ S.devices.separate }}</span>
              <span v-if="d.otherVersion" class="device-tag" :title="S.devices.otherVersionTitle">{{ S.devices.otherVersion }}</span>
              <span v-if="d.kuraa" class="device-tag warn" :title="d.kuraa === 'newer' ? S.devices.newerTitle : S.devices.olderTitle" :data-testid="`kuraa:${d.name}`">{{ d.kuraa === 'newer' ? S.devices.newer : S.devices.older }}</span>
              <span v-if="d.online" class="device-state" :title="viaTitle(d)" :data-testid="`state:${d.name}`">{{ viaText(d) }}</span>
              <span v-else-if="d.through.length" class="device-state" :title="S.devices.throughTitle(via(info, d))" :data-testid="`through:${d.name}`">{{ S.devices.through(via(info, d)) }}</span>
              <span v-else class="device-state" :data-testid="`state:${d.name}`">{{ d.lastSeen ? S.devices.lastSeen(time(new Date(d.lastSeen).toISOString())) : S.devices.isOffline }}</span>
            </li>
          </ul>
        </template>
        <div v-if="info.canInvite && !info.removed" class="menu-actions">
          <button type="button" :disabled="busy" data-testid="rename-device" @click="rename(info.device.name)">{{ S.devices.rename }}</button>
        </div>
      </div>
    </details>

    <!-- Removals not yet heard everywhere (0072): closed, beneath. -->
    <details v-if="info.people?.removals?.length" class="menu-details people-computers" data-testid="removals-details">
      <summary :title="S.people.removalsAbout">{{ S.people.removals }} ({{ info.people.removals.length }})</summary>
      <div class="people-computers-body">
        <p class="menu-facts">{{ S.people.removalsAbout }}</p>
        <ul class="menu-devices" data-testid="removals">
          <li v-for="(r, i) in info.people.removals" :key="i" :data-testid="`removal:${i}`">
            <span class="device-who">{{ S.people.removal(r.kind, r.who, r.by) }}</span>
            <span :class="['device-state', { warn: !r.confirmedBy.length }]">{{ S.people.confirmed(r.confirmedBy) }}</span>
          </li>
        </ul>
      </div>
    </details>
    <ErrorBanner v-if="error" :error="error" inline />
  </section>
</template>

<style scoped>
.server-link .menu-facts { margin-top: 6px; }
.people-list { gap: 6px; }
.people-list .device-state { white-space: nowrap; }
.people-computers summary { font-size: 13px; }
.people-computers-body { display: grid; gap: 8px; margin: 8px 0 0 14px; color: var(--text); }
</style>
