// This computer's person's key through the host, where the one running it lets
// the app manage it (`pnpm dev`: --manage-person). Null where it does not (a
// shared server: its key is its operator's).
import { ApiError, type HostApi } from './api.js';
import type { PersonShell } from './shell.js';

export async function hostPerson(api: HostApi): Promise<PersonShell | null> {
  try {
    await api.person();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  return {
    afterChange: 'What you save from now on is marked as yours.',
    get: () => api.person(),
    create: (name) => attempt(() => api.createPerson(name)),
    import: (line) => attempt(() => api.importPerson(line)),
    revoke: (key) => attempt(() => api.revokeKey(key)),
    copy: async () => {
      try {
        await navigator.clipboard.writeText(await api.exportPerson());
        return true;
      } catch {
        return false;
      }
    },
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

/** You on this computer: the shell's (the desktop app), else the host's where it allows (`pnpm dev`); null if neither. */
export async function personShellFor(shell: { person?: PersonShell }, api: HostApi): Promise<PersonShell | null> {
  return shell.person ?? (await hostPerson(api).catch(() => null));
}
