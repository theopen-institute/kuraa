<script setup lang="ts">
// You on this computer, in the menu's Identity and access panel (0035), where the shell keeps
// your keys (the desktop app) or the host allows the app to (`pnpm dev`):
// - this computer's signing key, made here, which signs the commits made here;
// - your identity, which vouches for your signing keys so your work counts as
//   yours from each of your computers: made here, or brought from another;
// - your other keys the workspace knows of, to revoke a lost computer's.
import { onMounted, ref, shallowRef } from 'vue';
import type { PersonInfo, PersonShell } from './shell.js';

const props = defineProps<{ person: PersonShell; displayName: string }>();

const me = shallowRef<PersonInfo | null>(null);
const name = ref(props.displayName);
const line = ref('');
const message = ref<{ ok: boolean; text: string } | null>(null);

const load = async () => {
  me.value = await props.person.get();
};
onMounted(load);

async function done(error: string | null, what: string) {
  if (error) {
    message.value = { ok: false, text: error };
    return;
  }
  await load();
  message.value = { ok: true, text: what };
}

async function create() {
  if (name.value.trim()) await done(await props.person.create(name.value.trim()), `Made your identity. ${props.person.afterChange}`);
}

async function importIdentity() {
  if (line.value.trim()) await done(await props.person.import(line.value.trim()), `Your identity is here now. ${props.person.afterChange}`);
}

async function copy() {
  message.value = (await props.person.copy())
    ? { ok: true, text: 'Copied. Paste it into this section on your other computer. Anyone with it can vouch for keys as you: send it privately.' }
    : { ok: false, text: 'Nothing to copy.' };
}

async function revoke(key: string) {
  await done(await props.person.revoke(key), `${key.slice(0, 8)}… is no longer yours: what it signs stops counting as yours on each device as your workspaces tell it, as they next save (work a device already has stays yours).`);
}

const short = (k: string) => `${k.slice(0, 8)}…`;
</script>

<template>
  <div v-if="me" class="person-key" data-testid="person-key">
    <p class="menu-facts">This computer's key, for you: <code :title="me.signing" data-testid="signing-key">{{ short(me.signing) }}</code>. It was made here, never leaves, and signs what you save here.</p>
    <template v-if="me.identity">
      <p class="menu-facts" data-testid="identity">
        You are <strong>{{ me.identity.name }}</strong> <code :title="me.identity.key">{{ short(me.identity.key) }}</code>. Your identity vouches for your keys, so other devices' rules can name you, whichever computer you save from.
      </p>
      <ul v-if="me.keys.length > 1" class="person-keys">
        <li v-for="k in me.keys" :key="k.key" :data-testid="`key:${k.key.slice(0, 8)}`">
          <code :title="k.key">{{ short(k.key) }}</code>
          <span v-if="k.thisComputer" class="muted">this computer</span>
          <button v-else type="button" @click="revoke(k.key)">Revoke</button>
        </li>
      </ul>
      <p class="menu-facts">Keep a copy of your identity somewhere safe: a lost one cannot be recovered.</p>
      <div class="menu-actions"><button type="button" data-testid="person-copy" @click="copy">Copy identity</button></div>
    </template>
    <template v-else>
      <p class="menu-facts">You have no identity on this computer: what you save here is signed by this computer's key alone. Make one, so other devices' rules can name you from each of your computers, or bring the one from your other computer.</p>
      <form class="person-row" @submit.prevent="create">
        <input v-model="name" placeholder="Your name" aria-label="Your name, for your identity" data-testid="person-name">
        <button type="submit" data-testid="person-create">Create</button>
      </form>
      <form class="person-row" @submit.prevent="importIdentity">
        <input v-model="line" placeholder="kuraa-id:… (Copy identity on your other computer)" spellcheck="false" aria-label="Your identity, from another computer" data-testid="person-line">
        <button type="submit" data-testid="person-import">Import</button>
      </form>
    </template>
    <p v-if="message" :class="['menu-facts', message.ok ? '' : 'person-error']" data-testid="person-status" role="status">{{ message.text }}</p>
  </div>
</template>
