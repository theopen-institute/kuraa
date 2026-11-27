// The Settings window's sections (decisions 0064, 0084, 0095), by who they apply
// to and where they are kept: you (this browser), the open document (its file),
// the open workspace (the workspace), and the host (its settings file); then
// every component, with a column for each of the host, the workspace and you.
// Each place that opens Settings opens it at one of them.

export type SettingsSection = 'you' | 'document' | 'workspace' | 'host' | 'components';

export const SETTINGS_SECTIONS: SettingsSection[] = ['you', 'document', 'workspace', 'host', 'components'];
