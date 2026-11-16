// The web shell: the client with the document types the host also loads.
import '@kuraa/client/style.css';
import { mountApp, type Settings } from '@kuraa/client';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';

// A shell may pass settings in the URL (the desktop app does). They are removed
// from the address bar so the token does not linger in history.
const url = new URL(location.href);
const overrides: Partial<Settings> = {};
for (const [param, key] of [['host', 'hostUrl'], ['token', 'token'], ['name', 'name'], ['email', 'email']] as const) {
  const value = url.searchParams.get(param);
  if (value) {
    overrides[key] = value;
    url.searchParams.delete(param);
  }
}
if (Object.keys(overrides).length) history.replaceState(null, '', url);

mountApp(document.getElementById('root')!, { types: [pandocMarkdown, rmarkdown], overrides });
