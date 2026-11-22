<script setup lang="ts">
// Inviting people to the workspace with an invite link: for one person (the
// first to use it) or anyone who has it, for a day, a week or with no expiry.
// Whoever joins reads and changes everything; they join as a member, or, if
// the dialog says so, as an admin, who may invite and remove others too
// (0066). Making one turns syncing on, if it was not. The links made here are
// listed, to revoke.
import { computed, onMounted, ref, shallowRef, useTemplateRef } from 'vue';
import type { HostApi, InviteLinkInfo } from './api.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi; workspace: string; syncing: boolean }>();
const emit = defineEmits<{ close: [] }>();
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

const forWhom = ref<'one' | 'anyone'>('one');
const EXPIRY = [
  { label: S.invite.inA(S.invite.day), hours: 24 },
  { label: S.invite.inA(S.invite.week), hours: 24 * 7 },
  { label: S.invite.never, hours: null },
] as const;
const expiry = ref(1);
const asAdmin = ref(false);
const forEmail = ref('');
/** Whether this workspace counts any server's email checks: only then is a place kept for an address (0066, step 6). */
const checksEmail = ref(false);
const made = shallowRef<{ code: string; once: boolean; expires: number } | null>(null);
const links = shallowRef<InviteLinkInfo[]>([]);
const busy = ref(false);
const copied = ref(false);
const error = shallowRef<unknown>(null);

async function loadLinks() {
  try {
    links.value = (await props.api.peerLinks()).slice().reverse();
  } catch (e) {
    error.value = e;
  }
}
onMounted(() => {
  void loadLinks();
  void props.api.rules().then((r) => (checksEmail.value = !!r.verifiers?.length), () => undefined);
});

async function create() {
  busy.value = true;
  error.value = null;
  copied.value = false;
  try {
    const r = await props.api.createLink({ hours: EXPIRY[expiry.value]!.hours, once: forWhom.value === 'one', role: asAdmin.value ? 'admin' : 'member', ...(forEmail.value.trim() ? { email: forEmail.value.trim() } : {}) });
    made.value = { code: r.link, once: r.once, expires: r.expires };
    await loadLinks();
  } catch (e) {
    error.value = e;
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
    error.value = e;
  }
}

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const until = computed(() => (made.value ? (made.value.expires ? S.invite.until(when(made.value.expires)) : S.invite.noExpiry) : ''));
const stateOf = (l: InviteLinkInfo) => (l.state === 'used' ? S.invite.used : l.state === 'revoked' ? S.invite.revoked : l.state === 'expired' ? S.invite.expired : l.expires ? S.invite.until(when(l.expires)) : S.invite.noExpiryShort);
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="modal naming invite" role="dialog" aria-modal="true" aria-labelledby="invite-title" data-testid="invite">
      <h2 id="invite-title">{{ S.invite.title(workspace) }}</h2>
      <p class="naming-hint">
        {{ S.invite.about }}<template v-if="!syncing && !made">{{ S.invite.turnsOn }}</template>
      </p>

      <template v-if="!made">
        <div class="segmented" role="group" :aria-label="S.invite.forWhom">
          <button type="button" :class="{ active: forWhom === 'one' }" :aria-pressed="forWhom === 'one'" data-testid="invite-once" @click="forWhom = 'one'">{{ S.invite.one }}</button>
          <button type="button" :class="{ active: forWhom === 'anyone' }" :aria-pressed="forWhom === 'anyone'" data-testid="invite-anyone" @click="forWhom = 'anyone'">{{ S.invite.anyone }}</button>
        </div>
        <label class="field">
          <span>{{ S.invite.expires }}</span>
          <select v-model="expiry" data-testid="invite-expiry">
            <option v-for="(e, i) in EXPIRY" :key="e.label" :value="i">{{ e.label }}</option>
          </select>
        </label>
        <label class="check">
          <input v-model="asAdmin" type="checkbox" data-testid="invite-admin">
          <span>{{ S.invite.asAdmin }}</span>
        </label>
        <p v-if="asAdmin" class="naming-hint">{{ S.invite.adminAbout }}</p>
        <label v-if="checksEmail" class="field">
          <span>{{ S.invite.forEmail }}</span>
          <input v-model="forEmail" type="email" placeholder="name@example.org" data-testid="invite-email">
        </label>
        <p v-if="checksEmail && forEmail.trim()" class="naming-hint">{{ S.invite.forEmailAbout }}</p>
        <p class="naming-hint">
          <template v-if="forWhom === 'one'">{{ S.invite.oneAbout }}</template>
          <template v-else>{{ S.invite.anyoneAbout }}</template>
          {{ S.invite.anyDevice }}
        </p>
      </template>

      <template v-else>
        <label class="field">
          <span>{{ S.invite.linkFor(made.once, until) }}</span>
          <textarea :value="made.code" readonly rows="4" spellcheck="false" data-testid="invite-code" @focus="($event.target as HTMLTextAreaElement).select()" />
        </label>
        <p class="naming-hint">{{ S.invite.howToUse }}</p>
      </template>

      <section v-if="links.length" class="invite-links" data-testid="invite-links">
        <h3>{{ S.invite.made }}</h3>
        <ul>
          <li v-for="l in links" :key="l.id" :data-testid="`link:${l.id}`">
            <span>{{ S.invite.linkRow(l.once, when(l.created)) }}<span :class="l.state">{{ stateOf(l) }}</span></span>
            <button v-if="l.state === 'active'" type="button" class="danger" :data-testid="`revoke:${l.id}`" @click="revoke(l.id)">{{ S.invite.revoke }}</button>
          </li>
        </ul>
      </section>

      <ErrorBanner v-if="error" :error="error" inline class="naming-error" />
      <div class="modal-actions">
        <template v-if="!made">
          <button type="button" @click="emit('close')">{{ S.common.cancel }}</button>
          <button type="button" class="primary" data-testid="invite-create" :disabled="busy" @click="create">{{ busy ? S.invite.making : S.invite.make }}</button>
        </template>
        <template v-else>
          <button type="button" @click="made = null">{{ S.invite.another }}</button>
          <button type="button" data-testid="invite-copy" @click="copy">{{ copied ? S.common.copied : S.common.copy }}</button>
          <button type="button" class="primary" @click="emit('close')">{{ S.common.done }}</button>
        </template>
      </div>
    </div>
  </div>
</template>
