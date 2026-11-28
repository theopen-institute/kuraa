// The host's settings as its owner changes them in Settings (decisions 0047,
// 0063, 0084): one copy, made by the window and shared by its Host and
// Components sections, so a format switched in one and a limit changed in the
// other are applied together, once, as the window closes.
import { computed, reactive, ref, shallowRef } from 'vue';
import type { HubApi, HubSettings, SettingsView } from './api.js';
import { S } from './strings.js';

/** The flag that sets each setting, said where a flag overrides it. */
export const FLAGS: Partial<Record<keyof HubSettings, string>> = {
  bootstrap: '--bootstrap', relays: '--relay', formats: '--format', features: '--feature', runCode: '--engine', environment: '--env',
  allowInstalls: '--allow-installs', memory: '--memory', cpus: '--cpus', disk: '--disk', allowWrite: '--allow-write',
  allowNetwork: '--allow-network', renderWhereCodeRuns: '--render-where-code-runs', rImages: '--r-image', dataDir: '--data-dir', workspaces: '--workspaces',
  saveSeconds: '--flush-ms', versionSeconds: '--commit-ms',
};

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const empty = (s: string) => (s.trim() === '' ? null : s.trim());

/** Load the host's settings (only where they may be changed here) and keep them as a form. */
export function useHostSettings(hub: HubApi, canChange: boolean, onSaved: () => void) {
  const view = shallowRef<SettingsView | null>(null);
  const loadError = shallowRef<unknown>(null);
  /** Why applying them was refused, if it was. */
  const error = ref('');
  const busy = ref(false);
  const f = reactive({
    bootstrap: '', relays: '', runCode: true, environment: '', allowInstalls: true,
    memory: '', cpus: '', disk: '', allowWrite: false, allowNetwork: false, renderWhereCodeRuns: false, rImages: '',
    dataDir: null as string | null, workspaces: null as string | null, saveSeconds: '', versionSeconds: '',
    formats: [] as string[],
    features: [] as string[],
  });
  /** The settings as loaded: changed since, they are applied as the window closes. */
  let loaded = '';

  if (canChange) hub.settings().then((v) => {
    const p = v.settings;
    Object.assign(f, {
      bootstrap: p.bootstrap.join('\n'), relays: p.relays.join('\n'), runCode: p.runCode, environment: p.environment ?? '',
      allowInstalls: p.allowInstalls, memory: p.memory ?? '', cpus: p.cpus === null ? '' : String(p.cpus), disk: p.disk ?? '',
      allowWrite: p.allowWrite, allowNetwork: p.allowNetwork, renderWhereCodeRuns: p.renderWhereCodeRuns, rImages: p.rImages.join('\n'), dataDir: p.dataDir, workspaces: p.workspaces,
      saveSeconds: p.saveSeconds === null ? '' : String(p.saveSeconds), versionSeconds: p.versionSeconds === null ? '' : String(p.versionSeconds),
      // Kinds of documents: each one the app has, on unless the settings name others.
      formats: v.formats.filter((x) => !p.formats || p.formats.includes(x.id)).map((x) => x.id),
      // Features (0082): each one the host has, on unless the settings name others.
      features: (v.features ?? []).filter((x) => !p.features || p.features.includes(x.id)).map((x) => x.id),
    });
    loaded = JSON.stringify(f);
    view.value = v;
  }, (e: unknown) => {
    loadError.value = e;
  });

  const changed = computed(() => !!view.value && JSON.stringify(f) !== loaded);
  /** Loaded, and its owner's to change here. */
  const editable = computed(() => canChange && !!view.value);
  const flagged = (key: keyof HubSettings) => !!view.value?.fromFlags.includes(key);

  /** Apply the settings (reopening every workspace, and reloading the page); false if refused. */
  async function save(): Promise<boolean> {
    const v = view.value;
    if (!v || busy.value) return false;
    error.value = '';
    busy.value = true;
    try {
      await hub.saveSettings({
        bootstrap: lines(f.bootstrap),
        relays: lines(f.relays),
        runCode: f.runCode,
        environment: f.environment || null,
        rImages: lines(f.rImages),
        memory: empty(f.memory),
        cpus: empty(f.cpus) as unknown as number | null,
        disk: empty(f.disk),
        allowWrite: f.allowWrite,
        allowNetwork: f.allowNetwork,
        allowInstalls: f.allowInstalls,
        renderWhereCodeRuns: f.renderWhereCodeRuns,
        dataDir: f.dataDir,
        // All on is the default: kept as such, so kinds added later are on too.
        formats: f.formats.length === v.formats.length ? null : v.formats.filter((x) => f.formats.includes(x.id)).map((x) => x.id),
        features: f.features.length === (v.features ?? []).length ? null : (v.features ?? []).filter((x) => f.features.includes(x.id)).map((x) => x.id),
        saveSeconds: empty(f.saveSeconds) as unknown as number | null,
        versionSeconds: empty(f.versionSeconds) as unknown as number | null,
        workspaces: f.workspaces,
      });
      onSaved();
      return true;
    } catch (e) {
      error.value = S.preferences.couldNotSave((e as Error).message);
      busy.value = false;
      return false;
    }
  }

  return { view, loadError, error, busy, f, changed, editable, flagged, save };
}

export type HostSettingsForm = ReturnType<typeof useHostSettings>;
