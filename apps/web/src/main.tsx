// The web shell: the client with the standard document types, the same ones the host loads.
import '@kuraa/client/style.css';
import { mountApp } from '@kuraa/client';
import { standardTypes } from '@kuraa/formats';
import { resolveShell } from './shell.js';

const { shell, overrides, defaults } = resolveShell();
mountApp(document.getElementById('root')!, { types: standardTypes, shell, overrides, defaults });
