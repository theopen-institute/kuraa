<script setup lang="ts">
// The workspace's packages for the open document's engine (0014), in a dialog
// (0092): what is installed (in the workspace's library, or used from the
// environment), and installing or removing. Installs run on the host, apart from
// the workspace; everyone sees the result. While one is under way, the dialog
// stays open.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { CodeSession, FeaturePanelContext, PackageInfo, PackageResult } from '@kuraa/feature-kit/client';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;

// The open document's session, followed as it changes, or as another document is opened.
const session = shallowRef<CodeSession | null>(ctx.host.code.session());
const tick = ref(0);
let offChange = session.value?.onChange(() => tick.value++);
const offSession = ctx.host.code.onSession(() => {
  offChange?.();
  session.value = ctx.host.code.session();
  offChange = session.value?.onChange(() => tick.value++);
  tick.value++;
});
onBeforeUnmount(() => {
  offChange?.();
  offSession();
});
const status = computed(() => (void tick.value, session.value?.status() ?? null));
const engine = computed(() => status.value?.packageEngine ?? null);

const list = shallowRef<PackageInfo[] | null>(null);
const refs = ref('');
const busy = ref(false);
const result = shallowRef<{ ok: boolean; message: string; log?: string } | null>(null);
watch(busy, (b) => ctx.holdOpen(b));

const label = computed(() => status.value?.engines.find((e) => e.id === engine.value)?.label ?? engine.value ?? '');
const news = computed(() => status.value?.packageNews ?? null);
const ours = computed(() => (list.value ?? []).filter((p) => p.source === 'workspace'));
const theirs = computed(() => (list.value ?? []).filter((p) => p.source === 'environment'));

function failed(e: unknown) {
  const x = ctx.explain(e);
  result.value = { ok: false, message: x.text, log: x.details ?? undefined };
}
function refresh() {
  const s = session.value;
  const e = engine.value;
  if (!s || !e) return;
  s.listPackages(e).then((l) => {
    list.value = l;
  }, failed);
}
// Again whenever the host says the packages changed (someone installed, or a chunk did).
watch([session, engine, () => news.value?.at], refresh, { immediate: true });

async function act(p: Promise<PackageResult>) {
  busy.value = true;
  result.value = null;
  try {
    result.value = await p;
  } catch (e) {
    failed(e);
  } finally {
    busy.value = false;
    refresh();
  }
}

function install() {
  const names = refs.value.split(/[\s,]+/).filter(Boolean);
  if (names.length && session.value && engine.value) void act(session.value.installPackages(engine.value, names)).then(() => {
    refs.value = '';
  });
}
function remove(name: string) {
  if (session.value && engine.value) void act(session.value.removePackages(engine.value, [name]));
}
function close() {
  if (!busy.value) ctx.close();
}

const field = useTemplateRef<HTMLInputElement>('field');
onMounted(() => field.value?.focus());
</script>

<template>
  <div class="packages" data-testid="packages">
    <h2>{{ S.packages.title(label) }}</h2>
    <form v-if="status?.allowInstalls" class="packages-install" @submit.prevent="install">
      <input ref="field" v-model="refs" :placeholder="S.packages.placeholder" :aria-label="S.packages.toInstall" :disabled="busy">
      <button type="submit" class="primary" :disabled="busy || !refs.trim()">{{ busy ? S.packages.installing : S.packages.install }}</button>
    </form>
    <p v-else class="muted">{{ S.packages.off }}</p>
    <p v-if="busy && news?.engine === engine" class="packages-progress muted">{{ news.message }}</p>
    <div v-if="result" :class="result.ok ? 'packages-result' : 'packages-result warn'">
      {{ result.message }}
      <details v-if="!result.ok && result.log"><summary>{{ S.common.details }}</summary><pre>{{ result.log.slice(-4000) }}</pre></details>
    </div>
    <p v-if="list === null" class="muted">{{ S.common.loading }}</p>
    <div v-else class="packages-list">
      <section>
        <h3>{{ S.packages.inWorkspace }}</h3>
        <p v-if="ours.length === 0" class="muted">{{ S.packages.noneYet }}</p>
        <table v-else>
          <tbody>
            <tr v-for="p in ours" :key="p.name">
              <td class="pkg-name">{{ p.name }}</td>
              <td class="pkg-version">{{ p.version }}</td>
              <td class="pkg-action">
                <button v-if="status?.allowInstalls" type="button" :disabled="busy" :title="S.packages.removeTitle(p.name)" @click="remove(p.name)">{{ S.common.remove }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <details v-if="theirs.length > 0">
        <summary>{{ S.packages.fromEnvironment(theirs.length) }}</summary>
        <p class="muted packages-env-note">{{ S.packages.environmentAbout }}</p>
        <ul class="pkg-chips">
          <li v-for="p in theirs" :key="p.name"><span class="pkg-name">{{ p.name }}</span> <span class="pkg-version">{{ p.version }}</span></li>
        </ul>
      </details>
    </div>
    <p class="muted packages-note">{{ S.packages.kept }}</p>
    <details class="packages-note">
      <summary>{{ S.common.details }}</summary>
      <span class="muted">{{ S.packages.keptDetails }}</span>
    </details>
    <div class="modal-actions"><button type="button" :disabled="busy" @click="close">{{ S.common.close }}</button></div>
  </div>
</template>

<style>
/* The Packages dialog: its own width, never taller than the window; the list scrolls. */
.packages {
  padding: 20px 22px; display: grid; gap: 12px;
  width: min(560px, 94vw); max-height: min(720px, 90vh);
  grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto;
}
.packages > * { min-width: 0; }
.packages h2 { margin: 0 0 4px; font-size: 17px; }
.packages-install { display: flex; gap: 8px; min-width: 0; }
.packages-install input { flex: 1; min-width: 0; font: 14px var(--font); color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.packages-result { font-size: 13px; overflow-wrap: anywhere; }
.packages-result.warn { color: var(--warn); }
.packages-result pre { font: 11px/1.4 var(--mono); max-height: 160px; overflow: auto; white-space: pre-wrap; }
.packages-progress { font: 12px var(--mono); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.packages-list { min-height: 0; overflow: auto; border-top: 1px solid var(--border); padding-top: 8px; display: grid; gap: 10px; align-content: start; }
.packages-list h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.packages-list p { margin: 0; font-size: 13px; }
.packages-list table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
.packages-list td { padding: 4px 6px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.packages-list td.pkg-version { width: 30%; }
.packages-list td.pkg-action { width: 84px; text-align: right; }
.packages-list summary { cursor: pointer; font-size: 13px; color: var(--muted); }
.packages-env-note { margin: 6px 0 !important; font-size: 12px !important; }
.pkg-chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12.5px; }
.pkg-name { font-family: var(--mono); }
.pkg-version { font-family: var(--mono); color: var(--muted); }
.packages-note { font-size: 12px; margin: 0; overflow-wrap: anywhere; }

/* The session's line in the document's menu: how it stands, coloured by its state. */
.r-state { color: var(--muted); }
.r-busy, .r-starting { color: var(--accent); }
.r-failed, .r-state.unavailable { color: var(--warn); }
.r-state.unsandboxed::after { content: ' · not sandboxed'; color: var(--warn); }
.run-unavailable { color: var(--warn); }
</style>
