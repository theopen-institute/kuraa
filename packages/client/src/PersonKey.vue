<script setup lang="ts">
// You on this computer, in the menu's You section (0035, 0038), where the shell
// keeps your keys (the desktop app) or the host allows the app to (`pnpm dev`).
// Your identity is made for you, from your name, the first time it is known
// (ensureIdentity), so what you save is marked as yours. The keys themselves,
// and linking a second computer (export, import) or revoking a lost one's key,
// are under Advanced.
import { onMounted, ref, shallowRef } from 'vue';
import type { PersonInfo, PersonShell } from './shell.js';
import { ensureIdentity } from './hostPerson.js';

const props = defineProps<{ person: PersonShell; displayName: string }>();

const me = shallowRef<PersonInfo | null>(null);
const line = ref('');
const message = ref<{ ok: boolean; text: string } | null>(null);

const load = async () => {
  me.value = await props.person.get();
};
onMounted(async () => {
  await ensureIdentity(props.person, props.displayName).catch(() => undefined);
  await load();
});

async function done(error: string | null, what: string) {
  if (error) {
    message.value = { ok: false, text: error };
    return;
  }
  await load();
  message.value = { ok: true, text: what };
}

async function importIdentity() {
  if (line.value.trim()) await done(await props.person.import(line.value.trim()), `Your identity is here now. ${props.person.afterChange}`);
}

async function copy() {
  message.value = (await props.person.copy())
    ? { ok: true, text: 'Copied. Paste it under Advanced on your other computer. Anyone with it can vouch for keys as you: send it privately.' }
    : { ok: false, text: 'Nothing to copy.' };
}

async function revoke(key: string) {
  await done(await props.person.revoke(key), `${key.slice(0, 8)}… is no longer yours: what it signs stops counting as yours on each device as your workspaces tell it, as they next save (work a device already has stays yours).`);
}

const short = (k: string) => `${k.slice(0, 8)}…`;
</script>

<template>
  <div v-if="me" class="person-key" data-testid="person-key">
    <p class="menu-facts" data-testid="you-here">
      <template v-if="me.identity">You on this computer: <strong>{{ me.identity.name }}</strong>. What you save here is marked as yours.</template>
      <template v-else>Set your name above, and what you save here is marked as yours.</template>
    </p>
    <details class="person-advanced" data-testid="person-advanced">
      <summary>Advanced</summary>
      <p class="menu-facts">This computer's signing key, for you: <code :title="me.signing" data-testid="signing-key">{{ short(me.signing) }}</code>. It was made here, never leaves, and signs what you save here.</p>
      <template v-if="me.identity">
        <p class="menu-facts" data-testid="identity">
          Your identity <code :title="me.identity.key">{{ short(me.identity.key) }}</code> vouches for your signing keys, so your work counts as yours from each of your computers.
        </p>
        <ul v-if="me.keys.length > 1" class="person-keys">
          <li v-for="k in me.keys" :key="k.key" :data-testid="`key:${k.key.slice(0, 8)}`">
            <code :title="k.key">{{ short(k.key) }}</code>
            <span v-if="k.thisComputer" class="muted">this computer</span>
            <button v-else type="button" @click="revoke(k.key)">Revoke</button>
          </li>
        </ul>
        <p class="menu-facts">To use another computer as you, copy your identity here and import it there. Keep a copy somewhere safe: a lost one cannot be recovered.</p>
        <div class="menu-actions"><button type="button" data-testid="person-copy" @click="copy">Copy identity</button></div>
      </template>
      <form v-else class="person-row" @submit.prevent="importIdentity">
        <input v-model="line" placeholder="kuraa-id:… (Copy identity on your other computer)" spellcheck="false" aria-label="Your identity, from another computer" data-testid="person-line">
        <button type="submit" data-testid="person-import">Import</button>
      </form>
    </details>
    <p v-if="message" :class="['menu-facts', message.ok ? '' : 'person-error']" data-testid="person-status" role="status">{{ message.text }}</p>
  </div>
</template>
