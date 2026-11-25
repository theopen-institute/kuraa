// The Settings window's sections (decisions 0064, 0084), by who they apply to and
// where they are kept: you (this browser), the open document (its file), the
// open workspace (the workspace), and the host (its settings file), with the
// host's components beneath it, theirs too. Each place that opens Settings opens
// it at one of them.

export type SettingsSection = 'you' | 'document' | 'workspace' | 'host' | 'components';

export const SETTINGS_SECTIONS: SettingsSection[] = ['you', 'document', 'workspace', 'host', 'components'];

/** Shown in the list beneath another, as part of it: the host's components, under Host. */
export const SUB_SECTIONS: Partial<Record<SettingsSection, SettingsSection>> = { components: 'host' };
