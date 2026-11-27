// Which host the client talks to and which of its workspaces is open.
//
// Every host is a hub (see the host's hub.ts): its workspaces at <hub>/w/<id>,
// with a list of them, and whether people may add more. A host that answers
// as a host of its own (one started by itself) is shown the
// same way, as a list of one that nothing is added to, so the app looks the same
// whatever it talks to.
//
// The APIs are made again only when the address, the token or the open
// workspace changes. Everything downstream (the tree, the open file's room, the
// history) reloads when they do, so changing your name or colour, or the hub's
// list being read again, must not make new ones.
import { computed, markRaw, ref, shallowRef, watch, type Ref } from 'vue';
import { HostApi, HubApi, type HubWorkspace } from './api.js';
import type { Settings } from './settings.js';

/** The id of the one workspace of an address that is a single workspace’s host, not a hub. */
const DIRECT = '';
/** How often the list is read again while a workspace is still opening. */
const OPENING_POLL_MS = 1000;

export function useWorkspaces(options: {
  settings: Ref<Settings>;
  /** Whether to ask the address now (not while the settings are being edited). */
  active: () => boolean;
  /** The workspace the shell would open first, if it says. */
  preferred: () => string | undefined;
  /** A problem reaching the address; null once it answers. */
  onError: (message: string | null) => void;
}) {
  const { settings, active, preferred, onError } = options;
  const hostUrl = computed(() => settings.value.hostUrl);
  const token = computed(() => settings.value.token);
  const hubApi = computed(() => markRaw(new HubApi(hostUrl.value, token.value)));
  /** The host's workspaces; null before the address has answered. */
  const workspaces = shallowRef<HubWorkspace[] | null>(null);
  /** People may add workspaces (and take them off the list). */
  const canAdd = ref(false);
  /** People may invite others to its workspaces. */
  const canInvite = ref(false);
  /** Any folder on the host's computer may be opened (its owner, decision 0047). */
  const canOpenFolder = ref(false);
  /** Preferences may be changed here. */
  const canChangeSettings = ref(false);
  /** Why the owner's features are not available here, if they are not. */
  const ownerOff = ref<string | null>(null);
  /** The address is a single workspace’s host, not a hub. */
  const direct = ref(false);
  /** The address has answered. */
  const known = ref(false);
  const chosen = ref<string | null>(null);
  const chosenKey = () => `kuraa:workspace:${keptAs(hostUrl.value)}`;
  /** Where new workspaces go on the host (and one is moved to out of a cloud service's folder), where it says. */
  const folder = ref<string | null>(null);
  let againTimer: ReturnType<typeof setTimeout> | undefined;
  /** Read the list again in a moment, while the address is the same. */
  function again(asked: HubApi) {
    clearTimeout(againTimer);
    againTimer = setTimeout(() => {
      if (asked === hubApi.value && active()) void load();
    }, OPENING_POLL_MS);
  }

  async function load(prefer?: string | null) {
    const asked = hubApi.value;
    try {
      const answer = await asked.workspaces();
      if (asked !== hubApi.value) return; // the address changed meanwhile
      direct.value = !answer;
      if (!answer) {
        // A single workspace’s host: its one workspace, named once it says (the tree's header shows the host's name for it).
        workspaces.value = [{ id: DIRECT, name: '', path: '', peers: false }];
        canAdd.value = false;
        canInvite.value = false; // the menu asks the workspace itself
        canOpenFolder.value = false;
        canChangeSettings.value = false;
        ownerOff.value = null;
        folder.value = null;
        chosen.value = DIRECT;
      } else {
        const list = answer.workspaces;
        workspaces.value = list;
        canAdd.value = answer.canAdd;
        canInvite.value = answer.canInvite;
        canOpenFolder.value = !!answer.canOpenFolder;
        canChangeSettings.value = !!answer.canChangeSettings;
        ownerOff.value = answer.ownerOff ?? null;
        folder.value = answer.folder ?? null;
        // Some still opening (0103): asked again shortly, to learn how each stands once it has opened.
        if (list.some((w) => w.opening)) again(asked);
        let stored: string | null = null;
        try { stored = localStorage.getItem(chosenKey()); } catch { /* storage unavailable */ }
        const ok = (id: string | null | undefined) => !!id && list.some((w) => w.id === id && !w.error);
        chosen.value = [prefer, chosen.value, preferred(), stored, list.find((w) => !w.error)?.id].find(ok) ?? null;
      }
      onError(null);
    } catch (e) {
      if (asked === hubApi.value) onError((e as Error).message);
    } finally {
      if (asked === hubApi.value) known.value = true;
    }
  }

  // Another address: nothing known of it yet, and no workspace of the old one.
  watch(hubApi, () => {
    workspaces.value = null;
    known.value = false;
    chosen.value = null;
  });
  watch([hubApi, active], () => {
    if (active()) void load();
  }, { immediate: true });
  watch(chosen, (id) => {
    try { if (id && !direct.value) localStorage.setItem(chosenKey(), id); } catch { /* storage unavailable */ }
  });

  /** The address answers, and a workspace is open. */
  const ready = computed(() => known.value && chosen.value !== null);
  const api = computed(() => markRaw(direct.value || chosen.value === null ? new HostApi(hostUrl.value, token.value) : hubApi.value.workspaceApi(chosen.value)));

  return { hubApi, workspaces, canAdd, canInvite, canOpenFolder, canChangeSettings, ownerOff, folder, known, chosen, ready, api, load };
}

/**
 * The address the workspace last open is kept by: a host on this computer by
 * its name alone, not its port, as the desktop app's host takes another port
 * each time it starts (and the last workspace would otherwise be forgotten).
 * Pages served by different hosts on this computer have storage of their own anyway.
 */
export function keptAs(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') return `${u.protocol}//${u.hostname}`;
  } catch { /* not an address: kept as it is */ }
  return url;
}
