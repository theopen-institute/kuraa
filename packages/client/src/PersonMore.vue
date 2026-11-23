<script setup lang="ts">
// Settings › You, more of your identity (0066, step 6), shown one way at a time
// (`view`): on You itself (email), your email addresses, as a verifier checked
// them (a code sent there); in Account recovery (recovery), your recovery key
// kept by a verifier, locked with a passphrase it never sees, and had back; and
// your trustees, who together may give your identity back if both its keys are
// lost (naming them takes the recovery key; asking them, a line to send each;
// vouching for someone, as their trustee, a line to send back). Email and the
// recovery key kept by a verifier show once a workspace names a verifier.
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, PeopleInfo } from './api.js';
import type { PersonInfo } from './shell.js';
import { S } from './strings.js';

const props = defineProps<{ api: HostApi; view: 'email' | 'recovery' }>();
const me = shallowRef<PersonInfo | null>(null);
const people = shallowRef<PeopleInfo['people']>([]);
const verifiers = shallowRef<{ key: string; url: string }[]>([]);
const message = ref<{ ok: boolean; text: string } | null>(null);
const busy = ref(false);

async function load() {
  me.value = await props.api.person().catch(() => null);
  const [peers, rules] = await Promise.all([props.api.peers().catch(() => null), props.api.rules().catch(() => null)]);
  people.value = peers?.enabled ? peers.people?.people ?? [] : [];
  verifiers.value = rules?.verifiers ?? [];
  if (!verifier.value && verifiers.value[0]) verifier.value = verifiers.value[0].url;
}
onMounted(load);

async function act(fn: () => Promise<unknown>, done: string | ((r: never) => string)) {
  busy.value = true;
  message.value = null;
  try {
    const r = await fn();
    message.value = { ok: true, text: typeof done === 'string' ? done : done(r as never) };
    await load();
    return true;
  } catch (e) {
    message.value = { ok: false, text: (e as Error).message };
    return false;
  } finally {
    busy.value = false;
  }
}

/** Email and escrow are shown once there is a server to check addresses (the workspace names one), or you have an address checked. */
const checking = computed(() => verifiers.value.length > 0 || !!me.value?.identity?.emails?.length);
const nameOf = (id: string) => people.value.find((p) => p.id === id)?.name ?? `${id.slice(0, 8)}…`;
const verifierLabel = (key: string) => verifiers.value.find((v) => v.key === key)?.url ?? `${key.slice(0, 8)}…`;

// Email.
const verifier = ref('');
const email = ref('');
const code = ref('');
const codeSent = ref(false);
async function sendCode() {
  codeSent.value = await act(() => props.api.emailStart(verifier.value, email.value), S.more.codeSent(email.value));
}
async function verify() {
  if (await act(() => props.api.emailFinish(verifier.value, email.value, code.value), S.more.verified(email.value))) {
    codeSent.value = false;
    code.value = '';
  }
}

// Escrow.
const passphrase = ref('');
const again = ref('');
async function keep() {
  if (passphrase.value !== again.value) {
    message.value = { ok: false, text: S.more.mismatch };
    return;
  }
  if (await act(() => props.api.escrowPut(verifier.value, passphrase.value), S.more.kept)) passphrase.value = again.value = '';
}
const back = ref({ email: '', code: '', passphrase: '', sent: false, line: '' });
async function backCode() {
  back.value.sent = await act(() => props.api.escrowStart(verifier.value, back.value.email), S.more.codeSent(back.value.email));
}
async function getBack() {
  await act(async () => {
    const r = await props.api.escrowGet(verifier.value, back.value.email, back.value.code, back.value.passphrase);
    back.value.line = r.line;
    return r;
  }, S.more.gotBack);
}

// Trustees.
const trustees = computed(() => me.value?.identity?.trustees ?? null);
const others = computed(() => people.value.filter((p) => !p.you));
const naming = ref({ line: '', ids: [] as string[], threshold: 2 });
async function nameThem() {
  if (await act(() => props.api.trusteesName(naming.value.line.trim(), naming.value.threshold, naming.value.ids), S.more.named)) naming.value = { line: '', ids: [], threshold: 2 };
}
const asking = ref({ whose: '', line: '', answers: '' });
async function ask() {
  await act(async () => {
    asking.value.line = (await props.api.trusteesAsk(asking.value.whose)).line;
  }, S.more.asked);
}
async function complete() {
  await act(() => props.api.trusteesComplete(asking.value.answers.split(/\s+/).filter(Boolean)), S.more.completed);
}
const vouching = ref({ line: '', who: '', answer: '' });
async function readAsk() {
  await act(async () => {
    vouching.value.who = (await props.api.trusteesPreview(vouching.value.line.trim())).name;
  }, S.more.readAsk);
}
async function vouch() {
  await act(async () => {
    vouching.value.answer = (await props.api.trusteesVouch(vouching.value.line.trim())).line;
  }, S.more.vouched);
}
const copy = (text: string) => navigator.clipboard.writeText(text).then(() => (message.value = { ok: true, text: S.common.copied }), () => undefined);
</script>

<template>
  <div v-if="me?.identity && (view === 'recovery' || checking)" class="person-more" data-testid="person-more">
    <div v-if="view === 'email'" class="pref-group subpanel-group">
    <h4>{{ S.more.email }}</h4>
    <ul v-if="me.identity.emails?.length" class="person-keys" data-testid="emails">
      <li v-for="e in me.identity.emails" :key="e.email + e.verifier">{{ e.email }} <span class="muted">{{ S.more.checkedBy(verifierLabel(e.verifier)) }}</span></li>
    </ul>
    <p v-else class="menu-facts">{{ S.more.noEmail }}</p>
    <label class="field">
      <span>{{ S.more.verifier }}</span>
      <input v-model="verifier" list="kuraa-verifiers" :placeholder="S.more.verifierPlaceholder" spellcheck="false" data-testid="verifier-url">
      <datalist id="kuraa-verifiers"><option v-for="v in verifiers" :key="v.key" :value="v.url" /></datalist>
    </label>
    <form class="person-row" @submit.prevent="sendCode">
      <input v-model="email" type="email" :placeholder="S.more.emailPlaceholder" data-testid="email-address">
      <button type="submit" :disabled="busy || !email || !verifier" data-testid="email-send">{{ S.more.sendCode }}</button>
    </form>
    <form v-if="codeSent" class="person-row" @submit.prevent="verify">
      <input v-model="code" inputmode="numeric" autocomplete="one-time-code" :placeholder="S.more.code" data-testid="email-code">
      <button type="submit" :disabled="busy || !code" data-testid="email-verify">{{ S.more.verify }}</button>
    </form>

    </div>

    <div v-if="view === 'recovery' && checking" class="pref-group subpanel-group">
    <h4>{{ S.more.escrow }}</h4>
    <template v-if="me.identity.recovery === 'here'">
      <p class="menu-facts">{{ S.more.escrowAbout }}</p>
      <form class="person-row" @submit.prevent="keep">
        <input v-model="passphrase" type="password" :placeholder="S.more.passphrase" autocomplete="new-password" data-testid="escrow-passphrase">
        <input v-model="again" type="password" :placeholder="S.more.again" autocomplete="new-password" data-testid="escrow-again">
        <button type="submit" :disabled="busy || !passphrase || !verifier" data-testid="escrow-keep">{{ S.more.keep }}</button>
      </form>
    </template>
    <p class="menu-facts">{{ S.more.backAbout }}</p>
    <form class="person-row" @submit.prevent="backCode">
      <input v-model="back.email" type="email" :placeholder="S.more.emailPlaceholder" data-testid="back-email">
      <button type="submit" :disabled="busy || !back.email || !verifier" data-testid="back-send">{{ S.more.sendCode }}</button>
    </form>
    <form v-if="back.sent" class="person-row" @submit.prevent="getBack">
      <input v-model="back.code" inputmode="numeric" :placeholder="S.more.code" data-testid="back-code">
      <input v-model="back.passphrase" type="password" :placeholder="S.more.passphrase" data-testid="back-passphrase">
      <button type="submit" :disabled="busy" data-testid="back-get">{{ S.more.getBack }}</button>
    </form>
    <div v-if="back.line" class="person-row">
      <input :value="back.line" readonly data-testid="back-line">
      <button type="button" @click="copy(back.line)">{{ S.common.copy }}</button>
    </div>
    </div>

    <div v-if="view === 'recovery'" class="pref-group subpanel-group">
    <h4>{{ S.more.trustees }}</h4>
    <p class="menu-facts" data-testid="trustees">{{ trustees ? S.more.yourTrustees(trustees.ids.map(nameOf), trustees.threshold) : S.more.noTrustees }}</p>
    <form class="rule-form" @submit.prevent="nameThem">
      <p class="menu-facts">{{ S.more.nameAbout }}</p>
      <div class="rule-who">
        <label v-for="p in others" :key="p.id"><input v-model="naming.ids" type="checkbox" :value="p.id" :data-testid="`trustee:${p.name}`"> {{ p.name ?? `${p.id.slice(0, 8)}…` }}</label>
      </div>
      <div class="person-row">
        <label class="muted">{{ S.more.howMany }} <input v-model.number="naming.threshold" type="number" min="1" :max="Math.max(1, naming.ids.length)" class="small-number" data-testid="trustee-threshold"></label>
        <input v-model="naming.line" :placeholder="S.person.recoverPlaceholder" spellcheck="false" data-testid="trustee-recovery">
        <button type="submit" :disabled="busy || !naming.ids.length || !naming.line" data-testid="trustees-name">{{ S.more.name }}</button>
      </div>
    </form>
    <p class="menu-facts">{{ S.more.askAbout }}</p>
    <form class="person-row" @submit.prevent="ask">
      <select v-model="asking.whose" data-testid="ask-whose"><option v-for="p in people" :key="p.id" :value="p.id">{{ p.name ?? `${p.id.slice(0, 8)}…` }}</option></select>
      <button type="submit" :disabled="busy || !asking.whose" data-testid="ask-make">{{ S.more.ask }}</button>
    </form>
    <template v-if="asking.line">
      <div class="person-row"><input :value="asking.line" readonly data-testid="ask-line"><button type="button" @click="copy(asking.line)">{{ S.common.copy }}</button></div>
      <textarea v-model="asking.answers" rows="3" :placeholder="S.more.answers" spellcheck="false" data-testid="ask-answers" />
      <div class="menu-actions"><button type="button" :disabled="busy || !asking.answers.trim()" data-testid="ask-complete" @click="complete">{{ S.more.complete }}</button></div>
    </template>
    <p class="menu-facts">{{ S.more.vouchAbout }}</p>
    <form class="person-row" @submit.prevent="readAsk">
      <input v-model="vouching.line" :placeholder="S.more.askPlaceholder" spellcheck="false" data-testid="vouch-line">
      <button type="submit" :disabled="busy || !vouching.line" data-testid="vouch-read">{{ S.more.read }}</button>
    </form>
    <template v-if="vouching.who">
      <p class="menu-facts warn" data-testid="vouch-who">{{ S.more.vouchWarn(vouching.who) }}</p>
      <div class="menu-actions"><button type="button" :disabled="busy" data-testid="vouch-yes" @click="vouch">{{ S.more.vouch(vouching.who) }}</button></div>
      <div v-if="vouching.answer" class="person-row"><input :value="vouching.answer" readonly data-testid="vouch-answer"><button type="button" @click="copy(vouching.answer)">{{ S.common.copy }}</button></div>
    </template>

    </div>

    <p v-if="message" :class="['menu-facts', message.ok ? '' : 'person-error']" role="status" data-testid="more-status">{{ message.text }}</p>
  </div>
</template>
