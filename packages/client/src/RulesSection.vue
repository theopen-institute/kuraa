<script setup lang="ts">
// Settings › Workspace's groups and permissions (0066, 0069): its groups first
// (who is in each, as admin or member), then its permissions (a file or folder,
// and who may read and change it: people, groups, or its admins), which name
// the groups. Everyone sees them; admins change them. Where there is no policy
// yet (a workspace on this computer only), nothing is shown.
//
// Changes made at the same time that could not both count (0078): each said in
// words, the one giving less having counted. Everyone in the workspace sees
// them (every device holds the changes anyway, and a member whose place one
// decided should see why); admins, or whoever the change needs, have **Make it
// again**, which makes the losing change after both. A workspace from before
// 0066 says it must be founded again, with the button for whoever may.
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, PeopleInfo, RulesInfo } from './api.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi }>();
const emit = defineEmits<{ permissions: [path: string] }>();
const rules = shallowRef<RulesInfo | null>(null);
const people = shallowRef<PeopleInfo | null>(null);
const busy = ref(false);
const error = shallowRef<unknown>(null);

async function load() {
  try {
    const [r, p] = await Promise.all([props.api.rules(), props.api.peers()]);
    rules.value = r;
    people.value = p.enabled ? p.people ?? null : null;
  } catch {
    rules.value = null;
  }
}
onMounted(load);

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

/** Everyone a rule may name: the admins, each group, each person. */
const choices = computed(() => [
  { value: 'admins', label: S.rules.admins },
  ...(rules.value?.groups ?? []).map((g) => ({ value: `group:${g.name}`, label: g.name })),
  ...(people.value?.people ?? []).map((p) => ({ value: p.id, label: p.name ?? `${p.id.slice(0, 8)}…` })),
]);
const nameOf = (w: string) => choices.value.find((c) => c.value === w)?.label ?? (w.startsWith('group:') ? w.slice(6) : `${w.slice(0, 8)}…`);

const newPath = ref('');
/** The permissions to list: every file's and folder's, but the whole workspace's (its own row). */
const listed = computed(() => (rules.value?.permissions ?? []).filter((p) => p.path !== ''));
/** What the whole workspace's permission says (who may change anything; anyone, where it says nothing). */
const everythingWords = computed(() => {
  const own = rules.value?.permissions?.find((p) => p.path === '');
  return own?.write ? S.rules.says(null, own.write.map(nameOf)) : S.rules.anyone;
});

const refounded = ref(false);
function refound() {
  void act(async () => {
    await props.api.refound();
    refounded.value = true;
  });
}

const newGroup = ref('');
const groupPerson = ref<Record<string, string>>({ '': '' });
function addToGroup(group: string, who: string, role: 'admin' | 'member') {
  if (!who) return;
  void act(async () => {
    await props.api.setGroupRole(group, who, role);
    if (group === newGroup.value) newGroup.value = '';
  });
}
</script>

<template>
  <!-- A workspace from before 0066 (0078): founded again by its owner (or, with none, an admin). -->
  <section v-if="rules?.refound || refounded" class="menu-section" data-testid="refound">
    <h3>{{ S.rules.refound }}</h3>
    <p v-if="refounded" class="menu-facts" role="status">{{ S.rules.refoundDone }}</p>
    <template v-else-if="rules?.refound">
      <p class="menu-facts warn">{{ S.rules.refoundAbout(rules.refound.owner) }}</p>
      <template v-if="rules.refound.may">
        <p class="menu-facts">{{ S.rules.refoundYou }}</p>
        <div class="menu-actions">
          <button type="button" :disabled="busy" data-testid="refound-button" @click="refound">{{ S.rules.refound }}</button>
        </div>
      </template>
    </template>
  </section>
  <section v-if="rules && people?.founded" class="menu-section" data-testid="rules">
    <h3>{{ S.rules.groups }}</h3>
    <p class="menu-facts">{{ S.rules.groupsAbout }}</p>
    <p v-if="!rules.groups.length" class="menu-facts">{{ S.rules.noGroups }}</p>
    <div v-for="g in rules.groups" :key="g.name" class="rule-group" :data-testid="`group:${g.name}`">
      <strong>{{ g.name }}</strong>
      <ul class="menu-devices">
        <li v-for="e in g.entries" :key="e.who">
          <span class="device-who">{{ e.name ?? nameOf(e.who) }}</span>
          <span class="device-tag">{{ e.role === 'admin' ? S.rules.admin : S.rules.member }}</span>
          <button v-if="rules.admin" type="button" :disabled="busy" @click="act(() => api.setGroupRole(g.name, e.who, null))">{{ S.rules.takeOut }}</button>
        </li>
      </ul>
      <div v-if="rules.admin" class="person-row">
        <select v-model="groupPerson[g.name]" :data-testid="`group-person:${g.name}`">
          <option v-for="p in people.people" :key="p.id" :value="p.id">{{ p.name ?? `${p.id.slice(0, 8)}…` }}</option>
        </select>
        <button type="button" :disabled="busy" :data-testid="`group-add:${g.name}`" @click="addToGroup(g.name, groupPerson[g.name] ?? '', 'member')">{{ S.rules.addTo }}</button>
      </div>
    </div>
    <form v-if="rules.admin" class="person-row rule-new-group" @submit.prevent="addToGroup(newGroup.trim(), groupPerson[''] ?? '', 'admin')">
      <input v-model="newGroup" :placeholder="S.rules.newGroup" spellcheck="false" data-testid="new-group">
      <select v-model="groupPerson['']" :aria-label="S.rules.newGroupWho" :title="S.rules.newGroupWho" data-testid="new-group-person">
        <option value="" disabled>{{ S.rules.newGroupWho }}</option>
        <option v-for="p in people.people" :key="p.id" :value="p.id">{{ p.name ?? `${p.id.slice(0, 8)}…` }}</option>
      </select>
      <button type="submit" :disabled="busy || !newGroup.trim()" data-testid="new-group-add">{{ S.rules.addTo }}</button>
    </form>


    <h3>{{ S.rules.title }}</h3>
    <p class="menu-facts">{{ S.rules.about }}</p>
    <!-- Every permission (0069): the whole workspace's first, then by path; each changed in its Permissions… -->
    <ul class="menu-devices permissions-list" data-testid="permission-list">
      <li data-testid="permission:*">
        <span class="device-who">{{ S.rules.everything }}</span>
        <span class="device-state">{{ everythingWords }}</span>
        <button type="button" data-testid="change:*" @click="emit('permissions', '')">{{ S.rules.change }}</button>
      </li>
      <li v-for="(p, i) in listed" :key="p.path ?? `private-${i}`" :data-testid="`permission:${p.path ?? 'private'}`">
        <code v-if="p.path" class="device-who">{{ p.path }}</code>
        <span v-else class="device-who muted">{{ S.rules.private }}</span>
        <span class="device-state">{{ S.rules.says(p.read?.map(nameOf) ?? null, p.write?.map(nameOf) ?? null) }}</span>
        <button v-if="p.path" type="button" :data-testid="`change:${p.path}`" @click="emit('permissions', p.path)">{{ S.rules.change }}</button>
      </li>
    </ul>
    <p v-if="!listed.length" class="menu-facts" data-testid="no-rules">{{ S.rules.none }}</p>
    <form v-if="rules.admin" class="person-row rule-new-group" @submit.prevent="emit('permissions', newPath.trim())">
      <input v-model="newPath" :placeholder="S.rules.pathHint" spellcheck="false" data-testid="rule-path">
      <button type="submit" :disabled="!newPath.trim()" data-testid="rule-open">{{ S.rules.setFor }}</button>
    </form>

    <!-- Clashes (0078): shown, never settled silently; the one that lost made again on purpose. -->
    <template v-if="rules.clashes?.length">
      <h3>{{ S.rules.clashes }}</h3>
      <p class="menu-facts">{{ rules.clashes.some((c) => c.redo) ? S.rules.clashesAboutAdmin : S.rules.clashesAbout }}</p>
      <ul class="menu-devices" data-testid="clashes">
        <li v-for="c in rules.clashes" :key="c.lost" :data-testid="`clash:${c.lost}`">
          <span class="device-who">{{ c.words }}</span>
          <button v-if="c.redo" type="button" :disabled="busy" :title="S.rules.redoTitle" :data-testid="`redo:${c.lost}`" @click="act(() => api.redoClash(c.lost))">{{ S.rules.redo }}</button>
        </li>
      </ul>
    </template>
    <ErrorBanner v-if="error" :error="error" inline />
  </section>
</template>
