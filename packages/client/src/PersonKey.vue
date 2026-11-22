<script setup lang="ts">
// You on this computer, in the menu's You section (0035, 0038), where the shell
// keeps your keys (the desktop app) or the host allows the app to (`pnpm dev`).
// Your identity is made for you, from your name, the first time it is known
// (ensureIdentity), so what you save is marked as yours. The keys themselves,
// and linking a second computer (export, import) or revoking a lost one's key,
// are under Advanced. Its recovery key (0066) is shown until you say it is saved
// elsewhere, and recovering your identity with it is under Advanced too.
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

async function copyRecovery() {
  message.value = (await props.person.copyRecovery()) ? { ok: true, text: S.person.recoveryCopied } : { ok: false, text: S.person.nothing };
}

async function recoverySaved() {
  await done(await props.person.recoverySaved(), S.person.recoveryRemoved);
}

const recoveryLine = ref('');
/** The recovery key pasted, checked: whose, and which of their keys stay theirs (ticked). */
const recovering = shallowRef<{ name: string; keys: string[] } | null>(null);
const keepKeys = ref<string[]>([]);

async function checkRecovery() {
  const r = await props.person.previewRecovery(recoveryLine.value.trim());
  if (typeof r === 'string') {
    message.value = { ok: false, text: r };
    return;
  }
  message.value = null;
  recovering.value = r;
  keepKeys.value = [...r.keys];
}

async function recover() {
  const drop = recovering.value!.keys.filter((k) => !keepKeys.value.includes(k));
  const error = await props.person.recover(recoveryLine.value.trim(), drop);
  if (!error) {
    recovering.value = null;
    recoveryLine.value = '';
  }
  await done(error, S.person.recovered);
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
    <div v-if="me.identity?.recovery === 'here'" class="person-recovery" data-testid="person-recovery">
      <p class="menu-facts">{{ S.person.recoveryHere }}</p>
      <div class="menu-actions">
        <button type="button" data-testid="recovery-copy" @click="copyRecovery">{{ S.person.copyRecovery }}</button>
        <button type="button" data-testid="recovery-saved" @click="recoverySaved">{{ S.person.recoverySaved }}</button>
      </div>
    </div>
    <details class="person-advanced" data-testid="person-advanced">
      <summary>{{ S.person.advanced }}</summary>
      <p class="menu-facts">{{ S.person.signing }}<code :title="me.signing" data-testid="signing-key">{{ short(me.signing) }}</code>{{ S.person.signingAbout }}</p>
      <template v-if="me.identity">
        <p class="menu-facts" data-testid="identity">
          {{ S.person.identity }}<code :title="me.identity.id">{{ short(me.identity.id) }}</code>{{ S.person.identityAbout }}
        </p>
        <p v-if="me.identity.recovery === 'saved'" class="menu-facts">{{ S.person.recoveryFine }}</p>
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
      <p class="menu-facts">{{ S.person.recoverTitle }}</p>
      <form class="person-row" @submit.prevent="checkRecovery">
        <input v-model="recoveryLine" :placeholder="S.person.recoverPlaceholder" spellcheck="false" :aria-label="S.person.recoverLabel" data-testid="recover-line" @input="recovering = null">
        <button type="submit" data-testid="recover-check">{{ S.person.recoverCheck }}</button>
      </form>
      <div v-if="recovering" data-testid="recover-confirm">
        <p class="menu-facts">{{ recovering.keys.length ? S.person.recoverWhose(recovering.name) : S.person.recoverNoKeys }}</p>
        <ul v-if="recovering.keys.length" class="person-keys">
          <li v-for="k in recovering.keys" :key="k">
            <label><input v-model="keepKeys" type="checkbox" :value="k"> <code :title="k">{{ short(k) }}</code></label>
          </li>
        </ul>
        <div class="menu-actions"><button type="button" data-testid="recover" @click="recover">{{ S.person.recover }}</button></div>
      </div>
    </details>
    <p v-if="message" :class="['menu-facts', message.ok ? '' : 'person-error']" data-testid="person-status" role="status">{{ message.text }}</p>
  </div>
</template>
