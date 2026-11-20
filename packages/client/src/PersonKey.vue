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
import { S } from './strings.js';

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
  if (line.value.trim()) await done(await props.person.import(line.value.trim()), S.person.imported(props.person.afterChange));
}

async function copy() {
  message.value = (await props.person.copy()) ? { ok: true, text: S.person.copied } : { ok: false, text: S.person.nothing };
}

async function revoke(key: string) {
  await done(await props.person.revoke(key), S.person.revoked(`${key.slice(0, 8)}…`));
}

const short = (k: string) => `${k.slice(0, 8)}…`;
</script>

<template>
  <div v-if="me" class="person-key" data-testid="person-key">
    <p class="menu-facts" data-testid="you-here">
      <template v-if="me.identity">{{ S.person.here }}<strong>{{ me.identity.name }}</strong>{{ S.person.marked }}</template>
      <template v-else>{{ S.person.setName }}</template>
    </p>
    <details class="person-advanced" data-testid="person-advanced">
      <summary>{{ S.person.advanced }}</summary>
      <p class="menu-facts">{{ S.person.signing }}<code :title="me.signing" data-testid="signing-key">{{ short(me.signing) }}</code>{{ S.person.signingAbout }}</p>
      <template v-if="me.identity">
        <p class="menu-facts" data-testid="identity">
          {{ S.person.identity }}<code :title="me.identity.key">{{ short(me.identity.key) }}</code>{{ S.person.identityAbout }}
        </p>
        <ul v-if="me.keys.length > 1" class="person-keys">
          <li v-for="k in me.keys" :key="k.key" :data-testid="`key:${k.key.slice(0, 8)}`">
            <code :title="k.key">{{ short(k.key) }}</code>
            <span v-if="k.thisComputer" class="muted">{{ S.person.thisComputer }}</span>
            <button v-else type="button" @click="revoke(k.key)">{{ S.person.revoke }}</button>
          </li>
        </ul>
        <p class="menu-facts">{{ S.person.toUseAnother }}</p>
        <div class="menu-actions"><button type="button" data-testid="person-copy" @click="copy">{{ S.person.copy }}</button></div>
      </template>
      <p class="menu-facts">{{ S.person.second }}</p>
      <form class="person-row" @submit.prevent="importIdentity">
        <input v-model="line" :placeholder="S.person.linePlaceholder" spellcheck="false" :aria-label="S.person.lineLabel" data-testid="person-line">
        <button type="submit" data-testid="person-import">{{ S.person.import }}</button>
      </form>
    </details>
    <p v-if="message" :class="['menu-facts', message.ok ? '' : 'person-error']" data-testid="person-status" role="status">{{ message.text }}</p>
  </div>
</template>
