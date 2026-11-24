// You on this computer, through the host: where it listens only on this
// computer, whoever has its access code is its owner (decision 0047), in a
// browser as in the desktop app. Null where it does not (a host open to the
// network: its key is its owner's).
import { ApiError, type HostApi } from './api.js';
import type { PersonShell } from './shell.js';
import { S } from './strings.js';

export async function hostPerson(api: HostApi): Promise<PersonShell | null> {
  try {
    await api.person();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
  const copied = async (line: () => Promise<string>) => {
    try {
      await navigator.clipboard.writeText(await line());
      return true;
    } catch {
      return false;
    }
  };
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  return {
    afterChange: S.person.afterChangeHost,
    get: () => api.person(),
    create: (name) => attempt(() => api.createPerson(name)),
    import: (line) => attempt(() => api.importPerson(line)),
    revoke: (key) => attempt(() => api.revokeKey(key)),
    copy: () => copied(() => api.exportPerson()),
    copyRecovery: () => copied(() => api.recoveryLine()),
    recoverySaved: () => attempt(() => api.recoverySaved()),
    previewRecovery: async (line) => {
      try {
        return await api.previewRecovery(line);
      } catch (e) {
        return (e as Error).message;
      }
    },
    recover: (line, drop) => attempt(() => api.recover(line, drop)),
  };
}

/**
 * Make your identity, from your name, if this computer has none yet (0038): the
 * first time the app runs with a name for you, or when you first set one in
 * Settings. What you save is then marked as yours, without your asking.
 */
export async function ensureIdentity(person: PersonShell, name: string): Promise<void> {
  if (!name.trim() || (await person.get()).identity) return;
  await person.create(name.trim());
}

/** You on this computer, through the host where it allows; null where it does not. */
export async function personShellFor(api: HostApi): Promise<PersonShell | null> {
  return hostPerson(api).catch(() => null);
}
