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
  /** And takes releases that change the protocol at once (--auto-update-all, 0112). */
  autoUpdateAll: boolean;
}

/** Which role the arguments ask for: `server` first (after `--auto-update`, if any), else a host. */
export function roleOf(argv: string[]): Role {
  const autoUpdateAll = argv.includes('--auto-update-all');
  const autoUpdate = autoUpdateAll || argv.includes('--auto-update');
  const rest = argv.filter((a) => a !== '--auto-update' && a !== '--auto-update-all');
  if (rest[0] === 'server') return { role: 'server', args: rest.slice(1), autoUpdate, autoUpdateAll };
  return { role: 'host', args: argv, autoUpdate, autoUpdateAll };
}
