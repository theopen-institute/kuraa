// Whether a folder is kept in sync by a cloud storage service (iCloud Drive,
// Dropbox, Google Drive, OneDrive), and which (decision 0103). A workspace there
// is slow, and can be damaged: the service holds back reading a file while it
// uploads it (seen holding one of git's files for minutes, and so the app's
// start with it), and copies a file it finds changed on two computers beside it
// ("HEAD 2"), which git does not know what to do with. The app says so, and
// offers to move it.
//
// On macOS such a folder (or one above it) is marked by the system with the
// service that keeps it (com.apple.file-provider-domain-id): Desktop and
// Documents, when iCloud keeps them; everything under ~/Library/CloudStorage.
// Elsewhere, and for the older ways these services kept folders, by where it is.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

const ATTRIBUTE = 'com.apple.file-provider-domain-id';

/** Services by the start of the id the system gives what they keep (macOS). */
const BY_DOMAIN: [string, string][] = [
  ['com.apple.CloudDocs', 'iCloud Drive'],
  ['com.getdropbox', 'Dropbox'],
  ['com.google.drivefs', 'Google Drive'],
  ['com.microsoft.OneDrive', 'OneDrive'],
  ['com.box', 'Box'],
];

/** Services by a folder's name, under the home folder (Windows, Linux, and macOS before file providers). */
const BY_NAME: [RegExp, string][] = [
  [/^Mobile Documents$/, 'iCloud Drive'],
  [/^iCloud ?Drive$/i, 'iCloud Drive'],
  [/^Dropbox( \(.*\))?$/, 'Dropbox'],
  [/^OneDrive( - .*)?$/, 'OneDrive'],
  [/^Google ?Drive$/i, 'Google Drive'],
  [/^GoogleDrive-/, 'Google Drive'],
  [/^Box( Sync)?$/, 'Box'],
];

/** The name of a service, from the id the system gives a folder it keeps (macOS); a cloud service, if not one of those known. */
export function serviceOfDomain(domain: string): string {
  return BY_DOMAIN.find(([prefix]) => domain.startsWith(prefix))?.[1] ?? 'a cloud storage service';
}

/** The service a path is under by its folders' names (below the home folder), or null. */
export function serviceByPath(path: string, home = homedir()): string | null {
  const full = resolve(path);
  const base = resolve(home);
  if (full !== base && !full.startsWith(base + sep)) return null;
  for (const part of full.slice(base.length).split(sep)) {
    const found = BY_NAME.find(([name]) => name.test(part));
    if (found) return found[1];
  }
  return null;
}

/** The id the system gives the service keeping this folder (macOS), or null. */
function domainOf(path: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('/usr/bin/xattr', ['-p', ATTRIBUTE, path], { timeout: 5000 }, (err, out) => done(err ? null : String(out).trim() || null));
  });
}

/**
 * The cloud storage service that keeps a folder in sync, by name ("iCloud
 * Drive"), or null if none does (or it cannot be told). Never throws.
 */
export async function cloudService(dir: string): Promise<string | null> {
  const byPath = serviceByPath(dir);
  if (byPath) return byPath;
  if (process.platform !== 'darwin') return null;
  // The folder, and each above it: the system marks the top of what a service keeps.
  for (let p = resolve(dir); ; p = dirname(p)) {
    const domain = await domainOf(p);
    if (domain) return serviceOfDomain(domain);
    if (dirname(p) === p) return null;
  }
}
