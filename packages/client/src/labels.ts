// Words and times shown in the menu and panels.

export const CONNECTION: Record<string, string> = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Offline', unauthorized: 'Token rejected' };
export const SESSION: Record<string, string> = { none: 'not started', starting: 'starting…', ready: 'ready', busy: 'running', stopped: 'stopped', failed: 'failed' };

/** A time: hours and minutes if today, the date and time otherwise; a dash if none. */
export const time = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString();
};

/** A commit's time, with seconds. */
export const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
};
