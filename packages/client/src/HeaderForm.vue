<script setup lang="ts">
// The header, in Document settings (the menu's panel for the open document): the
// document's YAML header as fields to fill in (a title, authors, a bibliography,
// …), or as YAML. Fields the format knows (Pandoc's own) are offered when adding
// one; any other can be added by name. Closing the panel without saving drops
// what was changed here.
//
// Saving from Fields writes only the fields changed here, onto the header as it
// is by then, so someone else's changes to other fields survive. Saving YAML
// writes the whole header.
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import type { HeaderField, HeaderSpec } from '@kuraa/editor-kit';
import type { EditorView } from 'prosemirror-view';
import { emptyRequired, entryFor, headerText, mergeHeader, readEntries, today, withRequired, writeHeader, yamlError, type Entry } from './header.js';
import { askConfirm } from './ask.js';
import { S } from './strings.js';
import { vFocus } from './vue.js';
import HeaderList from './HeaderList.vue';

const props = defineProps<{
  view: EditorView;
  spec: HeaderSpec;
  path: string;
  /** Goes up whenever the document changes, so the form can tell the header was changed meanwhile. */
  version: number;
}>();
const emit = defineEmits<{ saved: [] }>();

const name = computed(() => props.path.slice(props.path.lastIndexOf('/') + 1));
const live = () => headerText(props.view.state.doc, props.spec);

/** The header when the form opened. */
const opened = live();
/** What the fields were read from: the header as opened, or YAML typed here. */
let base = opened;
/** The fields were read from YAML typed here: saving writes the whole header. */
const whole = ref(false);

const mode = ref<'fields' | 'yaml'>('fields');
const entries = ref<Entry[]>([]);
const removed = ref<string[]>([]);
const yaml = ref(opened ?? '');
const yamlEdited = ref(false);
const problem = ref<string | null>(null);

const first = readEntries(opened, props.spec);
if ('error' in first) {
  mode.value = 'yaml';
  problem.value = first.error;
} else entries.value = withRequired(first.entries, props.spec);

const required = (key: string) => !!props.spec.required?.includes(key);
const needs = (keys: string[]) => (keys.length ? S.header.needs(keys.map((k) => props.spec.fields.find((f) => f.key === k)?.label.toLowerCase() ?? k)) : null);
const yamlProblem = computed(() => {
  if (mode.value !== 'yaml') return null;
  const bad = yamlError(yaml.value);
  if (bad) return bad;
  const read = readEntries(yaml.value, props.spec);
  return 'error' in read ? null : needs(emptyRequired(read.entries, props.spec));
});
const missing = computed(() => (mode.value === 'fields' ? emptyRequired(entries.value, props.spec) : []));
const changedMeanwhile = shallowRef(false);
watch(() => props.version, () => {
  changedMeanwhile.value = live() !== opened;
});

// Fields to add: the format's, grouped as it groups them, without those already here.
const adding = ref(false);
const search = ref('');
const present = computed(() => new Set(entries.value.map((e) => e.key)));
const groups = computed(() => {
  const q = search.value.trim().toLowerCase();
  const out = new Map<string, HeaderField[]>();
  for (const f of props.spec.fields) {
    if (present.value.has(f.key)) continue;
    if (q && ![f.label, f.key, f.description ?? '', f.group].some((s) => s.toLowerCase().includes(q))) continue;
    out.set(f.group, [...(out.get(f.group) ?? []), f]);
  }
  return [...out].map(([group, fields]) => ({ group, fields }));
});
/** The search, as a field of the document's own, if it can be one. */
const custom = computed(() => {
  const key = search.value.trim();
  return /^[A-Za-z_][\w.-]*$/.test(key) && !present.value.has(key) && !props.spec.fields.some((f) => f.key === key) ? key : null;
});

const fieldId = (key: string) => `header-${key.replace(/[^\w-]/g, '_')}`;

async function add(key: string, field?: HeaderField) {
  entries.value = [...entries.value, entryFor(key, undefined, field)];
  removed.value = removed.value.filter((k) => k !== key);
  adding.value = false;
  search.value = '';
  await nextTick();
  const el = document.getElementById(fieldId(key));
  el?.focus();
  el?.scrollIntoView({ block: 'nearest' });
}

/** Enter in the search: the first field that matches, or the name typed. */
function addFirst() {
  const f = groups.value[0]?.fields[0];
  if (f) void add(f.key, f);
  else if (custom.value) void add(custom.value);
}

function remove(i: number) {
  const [e] = entries.value.splice(i, 1);
  if (e && e.initial !== undefined) removed.value.push(e.key);
}

function checkYaml(e: Entry) {
  e.error = yamlError(e.value as string) ?? undefined;
}

function toYaml() {
  if (mode.value === 'yaml') return;
  yaml.value = mergeHeader(whole.value ? base : opened, entries.value, removed.value) ?? '';
  yamlEdited.value = false;
  mode.value = 'yaml';
}

function toFields() {
  if (mode.value === 'fields' || yamlError(yaml.value)) return;
  if (yamlEdited.value || problem.value) {
    const read = readEntries(yaml.value, props.spec);
    if ('error' in read) {
      problem.value = read.error;
      return;
    }
    base = yaml.value;
    whole.value = true;
    entries.value = withRequired(read.entries, props.spec);
    removed.value = [];
    problem.value = null;
  }
  mode.value = 'fields';
}

const label = (e: Entry) => e.field?.label ?? e.key;
const canSave = computed(() => (mode.value === 'yaml' ? !yamlProblem.value : !entries.value.some((e) => e.error) && !missing.value.length));

/** Write the whole header, asking first if that would undo someone else's change. */
async function replace(text: string | null) {
  if (live() !== opened && !(await askConfirm(S.header.overwriteAsk, S.header.saveMine))) return;
  finish(text);
}

function finish(text: string | null) {
  if (text !== live()) writeHeader(props.view, props.spec, text);
  emit('saved');
}

function save() {
  if (!canSave.value) return;
  if (mode.value === 'yaml') {
    if (!yamlEdited.value && !whole.value && !problem.value) return finish(mergeHeader(live(), entries.value, removed.value));
    return void replace(yaml.value.trim() ? yaml.value.replace(/\n+$/, '') : null);
  }
  try {
    if (whole.value) void replace(mergeHeader(base, entries.value, removed.value));
    else finish(mergeHeader(live(), entries.value, removed.value));
  } catch (e) {
    problem.value = (e as Error).message;
  }
}

/** Escape: out of adding a field, if it is adding one (true: it was). */
function escape(): boolean {
  if (!adding.value) return false;
  adding.value = false;
  search.value = '';
  return true;
}
defineExpose({ escape });

const asString = (e: Entry) => e.value as string;
const setString = (e: Entry, ev: Event) => {
  e.value = (ev.target as HTMLInputElement | HTMLTextAreaElement).value;
};
const setNumber = (e: Entry, ev: Event) => {
  const v = (ev.target as HTMLInputElement).valueAsNumber;
  e.value = Number.isNaN(v) ? null : v;
};
const rows = (text: string) => Math.min(12, Math.max(2, text.split('\n').length));
</script>

<template>
  <form class="header-form" aria-labelledby="header-form-title" data-testid="header" @submit.prevent="save">
    <div class="header-top">
      <div class="header-heading">
        <h3 id="header-form-title">{{ adding ? S.header.add : S.header.title }}</h3>
        <p class="muted">{{ S.header.about(name) }}</p>
      </div>
      <div v-if="!adding" class="segmented" role="tablist" :aria-label="S.header.editAs">
        <button type="button" role="tab" :aria-selected="mode === 'fields'" :class="{ active: mode === 'fields' }" :disabled="!!yamlError(yaml)" data-testid="header-fields-tab" @click="toFields">{{ S.header.fields }}</button>
        <button type="button" role="tab" :aria-selected="mode === 'yaml'" :class="{ active: mode === 'yaml' }" data-testid="header-yaml-tab" @click="toYaml">{{ S.header.yaml }}</button>
      </div>
    </div>

    <p v-if="changedMeanwhile" class="header-note" data-testid="header-changed">
      {{ S.header.changedMeanwhile }}
    </p>
    <p v-if="problem" class="header-error" role="alert">{{ problem }}</p>

    <!-- Adding a field: Pandoc's, by group, or one of your own. -->
    <div v-if="adding" class="header-body header-picker" data-testid="header-picker">
      <input v-model="search" v-focus class="header-search" type="search" :placeholder="S.header.search" :aria-label="S.header.searchLabel" @keydown.enter.prevent="addFirst">
      <button v-if="custom" type="button" class="header-option" data-testid="header-custom" @click="add(custom)">
        <span class="header-option-name">{{ S.header.addCustom(custom) }}</span>
        <span class="header-option-about">{{ S.header.customAbout }}</span>
      </button>
      <section v-for="g in groups" :key="g.group" class="header-group">
        <h3>{{ g.group }}</h3>
        <button v-for="f in g.fields" :key="f.key" type="button" class="header-option" :data-testid="`header-add:${f.key}`" @click="add(f.key, f)">
          <span class="header-option-name">{{ f.label }} <code>{{ f.key }}</code></span>
          <span v-if="f.description" class="header-option-about">{{ f.description }}</span>
        </button>
      </section>
      <p v-if="!groups.length && !custom" class="muted">{{ S.header.noMatch }}</p>
    </div>

    <!-- The fields. -->
    <div v-else-if="mode === 'fields'" class="header-body">
      <div v-if="!entries.length" class="header-empty">
        <p>{{ S.header.empty }}</p>
        <p class="muted">{{ S.header.emptyAbout }}</p>
      </div>
      <div v-for="(e, i) in entries" :key="e.key" class="header-row" :data-testid="`header-field:${e.key}`">
        <label class="header-label" :for="fieldId(e.key)">
          <span class="header-label-name">{{ label(e) }}</span>
          <code v-if="e.field" aria-hidden="true">{{ e.key }}</code>
        </label>
        <div class="header-value">
          <template v-if="e.kind === 'text'">
            <input :id="fieldId(e.key)" :value="asString(e)" :list="e.field?.choices ? `${fieldId(e.key)}-choices` : undefined" @input="setString(e, $event)">
            <datalist v-if="e.field?.choices" :id="`${fieldId(e.key)}-choices`">
              <option v-for="c in e.field.choices" :key="c" :value="c" />
            </datalist>
          </template>
          <textarea v-else-if="e.kind === 'paragraph'" :id="fieldId(e.key)" :value="asString(e)" rows="3" @input="setString(e, $event)" />
          <div v-else-if="e.kind === 'date'" class="header-inline">
            <input :id="fieldId(e.key)" :value="asString(e)" :placeholder="S.header.datePlaceholder" @input="setString(e, $event)">
            <button type="button" @click="e.value = today()">{{ S.header.today }}</button>
          </div>
          <label v-else-if="e.kind === 'boolean'" class="header-switch">
            <input :id="fieldId(e.key)" type="checkbox" :checked="e.value === true" @change="e.value = ($event.target as HTMLInputElement).checked">
            <span>{{ e.value ? S.header.yes : S.header.no }}</span>
          </label>
          <input v-else-if="e.kind === 'number'" :id="fieldId(e.key)" type="number" step="any" :value="e.value ?? ''" class="header-number" @input="setNumber(e, $event)">
          <HeaderList v-else-if="e.kind === 'list'" :model-value="(e.value as string[])" @update:model-value="(v) => (e.value = v)" :id-base="fieldId(e.key)" :choices="e.field?.choices" :label="label(e)" />
          <template v-else>
            <textarea
              :id="fieldId(e.key)"
              :value="asString(e)"
              class="header-yaml"
              spellcheck="false"
              :rows="rows(asString(e))"
              @input="setString(e, $event); checkYaml(e)"
            />
          </template>
          <p v-if="e.error" class="header-error">{{ e.error }}</p>
          <p v-else-if="missing.includes(e.key)" class="header-error" data-testid="header-required">{{ needs([e.key]) }}</p>
          <p v-else-if="e.kind === 'yaml' && e.field && e.field.kind !== 'yaml'" class="header-help">{{ S.header.asYaml(e.field.kind === 'list') }}</p>
          <p v-else-if="e.field?.description" class="header-help">{{ e.field.description }}</p>
          <p v-else-if="!e.field" class="header-help">{{ S.header.own }}</p>
        </div>
        <span v-if="required(e.key)" class="header-remove-placeholder" />
        <button v-else type="button" class="header-remove" :title="S.header.removeField(label(e))" :aria-label="S.header.removeField(label(e))" @click="remove(i)">✕</button>
      </div>
    </div>

    <!-- The header as YAML. -->
    <div v-else class="header-body header-yaml-body">
      <textarea
        v-model="yaml"
        v-focus
        class="header-yaml header-yaml-all"
        spellcheck="false"
        :aria-label="S.header.yamlLabel"
        data-testid="header-yaml"
        placeholder="title: My document&#10;author:&#10;  - Jane Doe"
        @input="yamlEdited = true; problem = null"
      />
      <p v-if="yamlProblem" class="header-error" role="alert">{{ yamlProblem }}</p>
    </div>

    <div class="modal-actions header-actions">
      <template v-if="adding">
        <button type="button" @click="adding = false; search = ''">{{ S.common.back }}</button>
      </template>
      <template v-else>
        <button v-if="mode === 'fields'" type="button" class="header-add" data-testid="header-add" @click="adding = true">{{ S.header.addField }}</button>
        <span class="toolbar-spacer" />
        <button type="submit" class="primary" :disabled="!canSave" data-testid="header-save">{{ S.header.save }}</button>
      </template>
    </div>
  </form>
</template>
