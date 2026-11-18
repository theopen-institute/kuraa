<script setup lang="ts">
// Inviting people to the workspace: a subscription link anyone may use until
// it expires or is revoked, or a one-time invitation for one device. Either
// lets whoever has it join as a full device, reading and changing everything,
// so the dialog says so. Making one turns syncing with devices on, if it was
// not. The links made here are listed, to revoke.
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, SubscriptionLinkInfo } from './api.js';
import { onEscape } from './vue.js';

const props = defineProps<{ api: HostApi; workspace: string; syncing: boolean }>();
const emit = defineEmits<{ close: [] }>();
onEscape(() => emit('close'));

const kind = ref<'link' | 'once'>('link');
const EXPIRY = [
  { label: 'a day', hours: 24 },
  { label: 'a week', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: 'no expiry', hours: null },
] as const;
const expiry = ref(1);
const made = shallowRef<{ code: string; kind: 'link' | 'once'; expires: number } | null>(null);
const links = shallowRef<SubscriptionLinkInfo[]>([]);
const busy = ref(false);
const copied = ref(false);
const error = ref<string | null>(null);

async function loadLinks() {
  try {
    links.value = (await props.api.peerLinks()).slice().reverse();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(loadLinks);

async function create() {
  busy.value = true;
  error.value = null;
  copied.value = false;
  try {
    if (kind.value === 'link') {
      const r = await props.api.createLink(EXPIRY[expiry.value]!.hours);
      made.value = { code: r.link, kind: 'link', expires: r.expires };
    } else {
      made.value = { code: await props.api.createInvitation(), kind: 'once', expires: Date.now() + 24 * 3600_000 };
    }
    await loadLinks();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function copy() {
  if (!made.value) return;
  try {
    await navigator.clipboard.writeText(made.value.code);
    copied.value = true;
  } catch {
    // No clipboard here: select the text, to copy by hand.
    (document.querySelector('[data-testid=invite-code]') as HTMLTextAreaElement | null)?.select();
  }
}

async function revoke(id: string) {
  error.value = null;
  try {
    await props.api.revokeLink(id);
    await loadLinks();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const until = computed(() => (made.value ? (made.value.expires ? `until ${when(made.value.expires)}` : 'with no expiry') : ''));
const stateOf = (l: SubscriptionLinkInfo) => (l.state === 'revoked' ? 'revoked' : l.state === 'expired' ? 'expired' : l.expires ? `until ${when(l.expires)}` : 'no expiry');
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal naming invite" role="dialog" aria-modal="true" aria-label="Invite people" data-testid="invite">
      <h2>Invite people to {{ workspace }}</h2>
      <p class="naming-hint">
        Whoever you invite gets a copy of this workspace that syncs with yours: they can read and change everything in it.
        Share an invitation only with people you trust with that.
        <template v-if="!syncing && !made"> Making one turns on syncing with other devices for this workspace.</template>
      </p>

      <template v-if="!made">
        <div class="segmented" aria-label="Kind">
          <button type="button" :class="{ active: kind === 'link' }" :aria-pressed="kind === 'link'" data-testid="invite-link" @click="kind = 'link'">A link for anyone</button>
          <button type="button" :class="{ active: kind === 'once' }" :aria-pressed="kind === 'once'" data-testid="invite-once" @click="kind = 'once'">A one-time invitation</button>
        </div>
        <label v-if="kind === 'link'" class="field">
          <span>Works for</span>
          <select v-model="expiry" data-testid="invite-expiry">
            <option v-for="(e, i) in EXPIRY" :key="e.label" :value="i">{{ e.label }}</option>
          </select>
        </label>
        <p class="naming-hint">
          <template v-if="kind === 'link'">Anyone with the link can join, as often as it is used, until it expires or you revoke it. Any device of the workspace that is running can let them in.</template>
          <template v-else>Good for one device, for a day. This device must be running when they join.</template>
        </p>
      </template>

      <template v-else>
        <label class="field">
          <span>{{ made.kind === 'link' ? `The link, ${until}` : `The invitation, good once, ${until}` }}</span>
          <textarea :value="made.code" readonly rows="4" spellcheck="false" data-testid="invite-code" @focus="($event.target as HTMLTextAreaElement).select()" />
        </label>
        <p class="naming-hint">They add it in kuraa: <strong>Add a workspace…</strong>, then <strong>Join from an invitation</strong>. Or with <code>kuraa-host join</code>.</p>
      </template>

      <section v-if="links.length" class="invite-links" data-testid="invite-links">
        <h3>Links made here</h3>
        <ul>
          <li v-for="l in links" :key="l.id" :data-testid="`link:${l.id}`">
            <span>Made {{ when(l.created) }}, <span :class="l.state">{{ stateOf(l) }}</span></span>
            <button v-if="l.state === 'active'" type="button" class="danger" :data-testid="`revoke:${l.id}`" @click="revoke(l.id)">Revoke</button>
          </li>
        </ul>
      </section>

      <p v-if="error" class="naming-error" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <template v-if="!made">
          <button type="button" @click="emit('close')">Cancel</button>
          <button type="button" class="primary" data-testid="invite-create" :disabled="busy" @click="create">{{ busy ? 'Making…' : kind === 'link' ? 'Make the link' : 'Make the invitation' }}</button>
        </template>
        <template v-else>
          <button type="button" @click="made = null">Make another</button>
          <button type="button" data-testid="invite-copy" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
          <button type="button" class="primary" @click="emit('close')">Done</button>
        </template>
      </div>
    </div>
  </div>
</template>
