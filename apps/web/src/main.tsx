// The web shell: the client with the document types the host also loads.
import '@kuraa/client/style.css';
import { mountApp, type Settings } from '@kuraa/client';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';

// A shell may pass settings in the URL (the desktop app does): host and token
// override stored settings, name and email only fill gaps. They are removed
// from the address bar so the token does not linger in history.
const url = new URL(location.href);
const overrides: Partial<Settings> = {};
const defaults: Partial<Settings> = {};
const params = [['host', 'hostUrl', overrides], ['token', 'token', overrides], ['name', 'name', defaults], ['email', 'email', defaults]] as const;
for (const [param, key, target] of params) {
  const value = url.searchParams.get(param);
  if (value) {
    target[key] = value;
    url.searchParams.delete(param);
  }
}
if (url.href !== location.href) history.replaceState(null, '', url);

mountApp(document.getElementById('root')!, { types: [pandocMarkdown, rmarkdown], overrides, defaults });
