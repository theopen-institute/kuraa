// The one program, by role (docs/decisions/0099-servers.md): `kuraa-host` is a host (the app's own,
// serving the web client), and `kuraa-host server` the same program as a server (headless, no
// person, its own constraints). A service runs it as `kuraa-host --auto-update <its flags>`
// (selfupdate.ts, installServer), so the role is found after that flag, wherever it is.

export interface Role {
  role: 'host' | 'server';
  /** The arguments for the role: `server` and `--auto-update` taken out. */
  args: string[];
  /** It updates itself (a release, installed: 0052). */
  autoUpdate: boolean;
}

/** Which role the arguments ask for: `server` first (after `--auto-update`, if any), else a host. */
export function roleOf(argv: string[]): Role {
  const autoUpdate = argv.includes('--auto-update');
  const rest = argv.filter((a) => a !== '--auto-update');
  if (rest[0] === 'server') return { role: 'server', args: rest.slice(1), autoUpdate };
  return { role: 'host', args: argv, autoUpdate };
}
