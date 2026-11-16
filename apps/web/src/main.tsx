// The web shell: the client with the document types the host also loads.
import '@kuraa/client/style.css';
import { mountApp } from '@kuraa/client';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { resolveShell } from './shell.js';

const { shell, overrides, defaults } = resolveShell();
mountApp(document.getElementById('root')!, { types: [pandocMarkdown, rmarkdown], shell, overrides, defaults });
