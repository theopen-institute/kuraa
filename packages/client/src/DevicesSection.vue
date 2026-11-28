<script setup lang="ts">
// Settings › Workspace's People (decisions 0064, 0068, 0111): everyone in the
// workspace, by kind (the owner, admins, members, then servers), each on a line
// with whether they are online (from their computers). A line opens their own
// view (MemberView: their role, their computers, removing them, a computer lost
// or stolen); nothing on the list itself changes anything, so nothing is done
// by a click gone astray. Admins invite people; the owner adds a server (an
// invite link for one server, to give to kuraa-server join). With no policy yet,
// everyone has the same say (0038), there are no people to list, and the
// computers are listed instead.
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo } from './api.js';
import { askConfirm, askText } from './ask.js';
import { time } from './labels.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';
import { deviceState, isAdmin, kindWord, kuraaOf, label, managesServers, memberDevices, memberName, members, memberState, others, serverHolds, type Info, type Member, type Who } from './peopleView.js';

const props = defineProps<{ api: HostApi }>();
const emit = defineEmits<{ invite: []; open: [who: Who] }>();
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

/** A server taken out before, blocked (0115): its key shut out of the workspace for good. */
async function blockFormer(f: { key: string; name: string }) {
  if (await askConfirm(S.keys.blockServerAsk(f.name), S.servers.blockButton, true)) await act(() => props.api.removeServer(f.key, true));
}

/** Where there is no policy yet, this computer is renamed from the list of computers (else from your own view). */
async function rename(current: string) {
  const name = (await askText(S.devices.renameAsk, current, S.common.rename))?.trim();
  if (name && name !== current) await act(() => props.api.renameDevice(name));
}

const testid = (m: Member) => `${m.kind}:${memberName(m)}`;
/** A server that has not held this device's work for long (0112): flagged in the list. */
const behindLong = (i: Info, m: Member) => {
  const h = serverHolds(memberDevices(i, m));
  return h?.state === 'behind' && h.long;
};
/** How long no other device may be connected before the section says this device may have been removed. */
const NO_CONTACT_MS = 30 * 60_000;
/** Since when no device has connected, as words, once that is long enough to mention (and the network is not the reason). */
const noContact = (i: Info) =>
  !i.removed && i.noContactSince && Date.now() - i.noContactSince >= NO_CONTACT_MS && i.network?.kind !== 'unreachable'
    ? S.devices.noContact(time(new Date(i.noContactSince).toISOString()))
    : null;
</script>

<template>
  <section v-if="info && !info.enabled && info.canInvite" class="menu-section" data-testid="devices">
    <h3>{{ S.people.title }}</h3>
    <p class="menu-facts">{{ S.devices.alone }}</p>
    <div class="menu-actions"><button type="button" data-testid="invite-button" @click="emit('invite')">{{ S.devices.invite }}</button></div>
  </section>
  <section v-if="info?.enabled" class="menu-section" data-testid="devices">
    <h3>{{ S.people.title }}</h3>
    <p v-if="info.removed" class="menu-facts warn" role="status" data-testid="device-removed">{{ S.devices.removed }}</p>
    <p v-else-if="noContact(info)" class="menu-facts warn" data-testid="no-contact">{{ noContact(info) }}</p>
    <p v-if="!info.removed && info.network && S.devices.network[info.network.kind]" class="menu-facts warn" data-testid="this-network">{{ S.devices.network[info.network.kind] }}</p>

    <!-- Everyone (0111): by kind; a line opens their own view, where anything is changed. -->
    <ul v-if="info.people?.founded" class="member-list" data-testid="people">
      <li v-for="m in members(info)" :key="`${m.kind}:${m.id}`">
        <button type="button" class="member-row" :data-testid="testid(m)" @click="emit('open', { kind: m.kind, id: m.id })">
          <span :class="['device-dot', memberState(info, m).dot]" aria-hidden="true" />
          <span class="device-who">{{ memberName(m) }}<template v-if="m.kind === 'person' && m.p.you">{{ S.people.you }}</template></span>
          <span class="device-tag" :data-testid="`role:${memberName(m)}`">{{ kindWord(m) }}</span>
          <span v-if="kuraaOf(memberDevices(info, m))" class="device-tag warn" :title="kuraaOf(memberDevices(info, m)) === 'newer' ? S.devices.newerTitle : S.devices.olderTitle">{{ kuraaOf(memberDevices(info, m)) === 'newer' ? S.devices.newer : S.devices.older }}</span>
          <span v-if="m.kind === 'server' && behindLong(info, m)" class="device-tag warn" :title="S.servers.behindTitle" :data-testid="`behind:${memberName(m)}`">{{ S.servers.behindTag }}</span>
          <span class="device-state" :data-testid="`state-of:${memberName(m)}`">{{ memberState(info, m).text }}</span>
          <span class="member-go" aria-hidden="true">›</span>
        </button>
      </li>
    </ul>
    <p v-if="info.people?.servers?.some((s) => s.you)" class="menu-facts" data-testid="this-is-a-server">{{ S.servers.youAre }}</p>

    <!-- Computers no identity here says whose (all of them, with no policy yet: there are no people to list). -->
    <template v-if="others(info).length || !info.people?.founded">
      <h4 v-if="info.people?.founded" class="menu-subhead">{{ S.devices.others }}</h4>
      <ul class="menu-devices">
        <li v-if="!info.people?.founded" data-testid="device-self">
          <span class="device-dot online" aria-hidden="true" />
          <span class="device-who">{{ info.device.name }}</span>
          <span class="device-state">{{ S.devices.thisComputer }}</span>
        </li>
        <li v-for="d in others(info)" :key="d.key" :data-testid="`device:${d.name}`">
          <span :class="['device-dot', { online: d.online, through: !d.online && d.through.length }]" aria-hidden="true" />
          <span class="device-who">{{ label(d) }}</span>
          <span v-if="d.kuraa" class="device-tag warn" :title="d.kuraa === 'newer' ? S.devices.newerTitle : S.devices.olderTitle" :data-testid="`kuraa:${d.name}`">{{ d.kuraa === 'newer' ? S.devices.newer : S.devices.older }}</span>
          <span class="device-state" :title="deviceState(info, d).title" :data-testid="`state:${d.name}`">{{ deviceState(info, d).text }}</span>
        </li>
      </ul>
    </template>

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

    <p v-if="info.people?.founded && !isAdmin(info) && !info.removed && !info.people?.servers?.some((s) => s.you)" class="menu-facts" data-testid="not-admin">{{ S.devices.notAdmin }}</p>
    <!-- A removed device's invitations are refused by the others: none offered. -->
    <div v-if="info.canInvite && !info.removed" class="menu-actions">
      <button v-if="isAdmin(info)" type="button" data-testid="invite-button" @click="emit('invite')">{{ S.devices.invite }}</button>
      <button v-if="info.people?.founded && managesServers(info) && !serverLink" type="button" :disabled="busy" data-testid="add-server" @click="addServer">{{ S.servers.add }}</button>
      <button v-if="!info.people?.founded" type="button" :disabled="busy" data-testid="rename-device" @click="rename(info.device.name)">{{ S.devices.rename }}</button>
    </div>

    <!-- Servers taken out before (0115): the owner may still block one whose key went astray since. Closed, beneath. -->
    <details v-if="info.people?.formerServers?.length && managesServers(info)" class="menu-details removals-details" data-testid="former-servers">
      <summary>{{ S.servers.former }} ({{ info.people.formerServers.length }})</summary>
      <div class="removals-body">
        <p class="menu-facts">{{ S.servers.formerAbout }}</p>
        <ul class="menu-devices">
          <li v-for="f in info.people.formerServers" :key="f.key" :data-testid="`former-server:${f.name}`">
            <span class="device-who">{{ f.name }}</span>
            <button type="button" class="danger" :disabled="busy" :data-testid="`block-former:${f.name}`" @click="blockFormer(f)">{{ S.servers.block }}</button>
          </li>
        </ul>
      </div>
    </details>

    <!-- Removals not yet heard everywhere (0072): closed, beneath. -->
    <details v-if="info.people?.removals?.length" class="menu-details removals-details" data-testid="removals-details">
      <summary :title="S.people.removalsAbout">{{ S.people.removals }} ({{ info.people.removals.length }})</summary>
      <div class="removals-body">
        <p class="menu-facts">{{ S.people.removalsAbout }}</p>
        <ul class="menu-devices" data-testid="removals">
          <li v-for="(r, n) in info.people.removals" :key="n" :data-testid="`removal:${n}`">
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
.member-list { list-style: none; margin: 0; padding: 0; display: grid; font-size: 13px; }
.member-row {
  display: flex; align-items: center; gap: 6px; width: calc(100% + 16px); text-align: left; padding: 6px 8px; margin: 0 -8px;
  box-sizing: border-box; border: 0; border-radius: 6px; background: none; color: var(--text); font: inherit; cursor: pointer;
}
.member-row:hover, .member-row:focus-visible { background: var(--selected); }
.member-row .device-state { white-space: nowrap; }
.member-go { color: var(--muted); font-size: 16px; line-height: 1; }
.removals-details summary { font-size: 13px; }
.removals-body { display: grid; gap: 8px; margin: 8px 0 0 14px; color: var(--text); }
</style>
