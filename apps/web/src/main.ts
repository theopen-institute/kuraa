// The web shell: the client with the standard document types (the same ones the
// host loads) and their editor modules.
import '@kuraa/client/style.css';
import { mountApp } from '@kuraa/client';
import { standardTypes } from '@kuraa/formats';
import { standardEditors } from '@kuraa/formats/editor';
import { resolveShell } from './shell.js';

const { shell, overrides, defaults } = resolveShell();
mountApp(document.getElementById('root')!, { types: standardTypes, editors: standardEditors, shell, overrides, defaults });
