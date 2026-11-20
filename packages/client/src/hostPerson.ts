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
    afterChange: 'It vouches for this computer\'s key from your next save.',
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
