<script setup lang="ts">
// Inviting people to the workspace with an invite link: for one person (the
// first to use it) or anyone who has it, for a day, a week or with no expiry.
// Whoever joins is a full member, with the same say as everyone else: they
// read and change everything, and may invite and remove others; the dialog
// says so. Making one turns syncing on, if it was not. The links made here are
// listed, to revoke.
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, InviteLinkInfo } from './api.js';
import { onEscape } from './vue.js';

const props = defineProps<{ api: HostApi; workspace: string; syncing: boolean }>();
const emit = defineEmits<{ close: [] }>();
onEscape(() => emit('close'));

const forWhom = ref<'one' | 'anyone'>('one');
const EXPIRY = [
  { label: 'a day', hours: 24 },
  { label: 'a week', hours: 24 * 7 },
  { label: 'never', hours: null },
] as const;
const expiry = ref(1);
const made = shallowRef<{ code: string; once: boolean; expires: number } | null>(null);
const links = shallowRef<InviteLinkInfo[]>([]);
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
    const r = await props.api.createLink({ hours: EXPIRY[expiry.value]!.hours, once: forWhom.value === 'one' });
    made.value = { code: r.link, once: r.once, expires: r.expires };
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
const stateOf = (l: InviteLinkInfo) => (l.state === 'used' ? 'used' : l.state === 'revoked' ? 'revoked' : l.state === 'expired' ? 'expired' : l.expires ? `until ${when(l.expires)}` : 'no expiry');
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal naming invite" role="dialog" aria-modal="true" aria-label="Invite people" data-testid="invite">
      <h2>Invite people to {{ workspace }}</h2>
      <p class="naming-hint">
        Whoever joins gets a copy of this workspace that syncs with yours, and the same say as you: they can read and change everything,
        invite others, and remove anyone. Share a link only with people you trust with that.
        <template v-if="!syncing && !made"> Making one turns on syncing for this workspace.</template>
      </p>

      <template v-if="!made">
        <div class="segmented" aria-label="Who it is for">
          <button type="button" :class="{ active: forWhom === 'one' }" :aria-pressed="forWhom === 'one'" data-testid="invite-once" @click="forWhom = 'one'">One person</button>
          <button type="button" :class="{ active: forWhom === 'anyone' }" :aria-pressed="forWhom === 'anyone'" data-testid="invite-anyone" @click="forWhom = 'anyone'">Anyone with the link</button>
        </div>
        <label class="field">
          <span>Expires</span>
          <select v-model="expiry" data-testid="invite-expiry">
            <option v-for="(e, i) in EXPIRY" :key="e.label" :value="i">{{ e.label === 'never' ? 'never' : `in ${e.label}` }}</option>
          </select>
        </label>
        <p class="naming-hint">
          <template v-if="forWhom === 'one'">The first person to use it joins; after that it lets no one else in.</template>
          <template v-else>Anyone with the link can join, as often as it is used, until it expires or you revoke it.</template>
          Any of the workspace’s devices that is running can let them in.
        </p>
      </template>

      <template v-else>
        <label class="field">
          <span>{{ made.once ? `The link, for one person, ${until}` : `The link, for anyone with it, ${until}` }}</span>
          <textarea :value="made.code" readonly rows="4" spellcheck="false" data-testid="invite-code" @focus="($event.target as HTMLTextAreaElement).select()" />
        </label>
        <p class="naming-hint">They add it in kuraa: <strong>Add a workspace…</strong>, then <strong>Join from an invite link</strong>.</p>
      </template>

      <section v-if="links.length" class="invite-links" data-testid="invite-links">
        <h3>Links made here</h3>
        <ul>
          <li v-for="l in links" :key="l.id" :data-testid="`link:${l.id}`">
            <span>{{ l.once ? 'For one person' : 'For anyone' }}, made {{ when(l.created) }}, <span :class="l.state">{{ stateOf(l) }}</span></span>
            <button v-if="l.state === 'active'" type="button" class="danger" :data-testid="`revoke:${l.id}`" @click="revoke(l.id)">Revoke</button>
          </li>
        </ul>
      </section>

      <p v-if="error" class="naming-error" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <template v-if="!made">
          <button type="button" @click="emit('close')">Cancel</button>
          <button type="button" class="primary" data-testid="invite-create" :disabled="busy" @click="create">{{ busy ? 'Making…' : 'Make the link' }}</button>
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
