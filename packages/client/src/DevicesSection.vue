<script setup lang="ts">
// The menu's Devices section, when the host is one of the workspace's devices:
// which devices are paired and which are connected, on which branches only some
// devices' work comes in on its own, and other devices' work that waits here to
// be accepted. Removing devices and setting those rules are the operator's,
// with kuraa-host. Inviting people (invitations, subscription links) is here
// where the operator allows it. Accepting work is an edit like any other.
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo } from './api.js';

const props = defineProps<{ api: HostApi }>();
const emit = defineEmits<{ accepted: []; invite: [] }>();
const info = shallowRef<PeersInfo | null>(null);
const busy = ref<string | null>(null);
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

async function accept(device: string, branch: string) {
  busy.value = `${device}/${branch}`;
  error.value = null;
  try {
    await props.api.acceptProposal(device, branch);
    emit('accepted');
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

async function take(device: string, branch: string, path: string) {
  busy.value = `${device}/${branch}/${path}`;
  error.value = null;
  try {
    await props.api.takeVersion(device, branch, path);
    emit('accepted');
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

const online = (i: Extract<PeersInfo, { enabled: true }>) => i.devices.filter((d) => d.online && !d.related).length;
</script>

<template>
  <section v-if="info && !info.enabled && info.canInvite" class="menu-section" data-testid="devices">
    <h3>Devices</h3>
    <p class="menu-facts">This workspace is on this device only. Invite people to work on it with you, from their own devices.</p>
    <div class="menu-actions"><button type="button" data-testid="invite-button" @click="emit('invite')">Invite people…</button></div>
  </section>
  <section v-if="info?.enabled" class="menu-section" data-testid="devices">
    <h3>Devices</h3>
    <p class="menu-facts">
      This is {{ info.device.name }}.
      <template v-if="info.devices.length">{{ online(info) }} of {{ info.devices.length }} other device{{ info.devices.length === 1 ? '' : 's' }} connected.</template>
      <template v-else>No other device is paired yet.</template>
    </p>
    <ul v-if="info.devices.length" class="menu-devices">
      <li v-for="d in info.devices" :key="d.key" :title="d.key" :data-testid="`device:${d.name}`">
        <span :class="['device-dot', { online: d.online }]" aria-hidden="true" />
        {{ d.name }}
        <span v-if="d.related" class="device-tag">fork</span>
        <span v-if="d.otherVersion" class="device-tag" title="It runs another version of kuraa, which merges differently. Work done apart still comes together: one of the two devices makes the merges, and the other takes them.">other version</span>
        <span class="device-state">{{ d.online ? 'connected' : 'away' }}</span>
      </li>
    </ul>
    <p v-for="r in info.rules" :key="`${r.branch}/${r.path}`" class="menu-facts" :data-testid="`rule:${r.branch}:${r.path}`">
      <template v-if="r.path">In <code>{{ r.path }}</code> on <code>{{ r.branch }}</code>, changes come in on its own only from {{ r.from.join(', ') || 'no one' }}; this device keeps its own version against others'.</template>
      <template v-else>On <code>{{ r.branch }}</code>, work comes in on its own only from {{ r.from.join(', ') || 'no one' }}; other devices' waits to be accepted.</template>
    </p>
    <template v-if="info.declined.length">
      <p class="menu-facts">Kept this device's version, where another's differs:</p>
      <ul class="menu-proposals">
        <li v-for="d in info.declined" :key="`${d.device}/${d.branch}/${d.path}`" :data-testid="`declined:${d.device}/${d.path}`">
          <span class="proposal-what"><code>{{ d.path }}</code>: <strong>{{ d.device }}</strong>'s version</span>
          <button type="button" :disabled="busy !== null" @click="take(d.device, d.branch, d.path)">{{ busy === `${d.device}/${d.branch}/${d.path}` ? 'Taking…' : 'Take theirs' }}</button>
        </li>
      </ul>
    </template>
    <template v-if="info.proposals.length">
      <p class="menu-facts">Waiting to be accepted:</p>
      <ul class="menu-proposals">
        <li v-for="p in info.proposals" :key="`${p.device}/${p.branch}`" :data-testid="`proposal:${p.device}/${p.branch}`">
          <span class="proposal-what"><strong>{{ p.device }}</strong> on <code>{{ p.branch }}</code>: {{ p.subject }}<template v-if="p.commits > 1"> and {{ p.commits - 1 }} more</template></span>
          <button type="button" :disabled="busy !== null" @click="accept(p.device, p.branch)">{{ busy === `${p.device}/${p.branch}` ? 'Accepting…' : 'Accept' }}</button>
        </li>
      </ul>
    </template>
    <div v-if="info.canInvite" class="menu-actions"><button type="button" data-testid="invite-button" @click="emit('invite')">Invite people…</button></div>
    <p v-if="error" class="banner warn">{{ error }}</p>
  </section>
</template>
