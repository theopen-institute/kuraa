// Folders a cloud storage service keeps (0103): told by where they are, and on macOS by the system's mark.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { serviceByPath, serviceOfDomain } from '../src/cloud.js';

describe('cloud storage folders', () => {
  const home = '/Users/ada';

  it('knows a service by the folder it keeps, below the home folder', () => {
    expect(serviceByPath(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'thesis'), home)).toBe('iCloud Drive');
    expect(serviceByPath(join(home, 'Dropbox', 'notes'), home)).toBe('Dropbox');
    expect(serviceByPath(join(home, 'Dropbox (Personal)', 'notes'), home)).toBe('Dropbox');
    expect(serviceByPath(join(home, 'OneDrive - University', 'Documents', 'notes'), home)).toBe('OneDrive');
    expect(serviceByPath(join(home, 'Library', 'CloudStorage', 'GoogleDrive-ada@example.org', 'My Drive', 'notes'), home)).toBe('Google Drive');
  });

  it('passes over folders no service keeps, and anything outside the home folder', () => {
    expect(serviceByPath(join(home, 'Kuraa Workspaces', 'notes'), home)).toBeNull();
    expect(serviceByPath(join(home, 'Documents', 'notes'), home)).toBeNull();
    expect(serviceByPath('/srv/Dropbox/notes', home)).toBeNull();
    expect(serviceByPath('/Users/adam/Dropbox', home)).toBeNull();
  });

  it('names the service from the mark macOS gives what it keeps', () => {
    expect(serviceOfDomain('com.apple.CloudDocs.iCloudDriveFileProvider/1D9F99E7-482E-4897-9941-0EED6BCD7F3A')).toBe('iCloud Drive');
    expect(serviceOfDomain('com.getdropbox.dropbox.fileprovider/1bb70c9d')).toBe('Dropbox');
    expect(serviceOfDomain('com.google.drivefs.fpext/gdrive-1')).toBe('Google Drive');
    expect(serviceOfDomain('org.example.sync/1')).toBe('a cloud storage service');
  });
});
