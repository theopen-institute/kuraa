// The Settings window's four sections (decision 0064), by who they apply to and
// where they are kept: you (this browser), the open document (its file), the
// open workspace (the workspace), and the server (its settings file). Each place
// that opens Settings opens it at one of them.

export type SettingsSection = 'you' | 'document' | 'workspace' | 'server';

export const SETTINGS_SECTIONS: SettingsSection[] = ['you', 'document', 'workspace', 'server'];
