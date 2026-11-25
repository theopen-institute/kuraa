// The web shell: the client with the standard document types (the same ones the
// host loads), their editor modules, and the standard features' client halves.
import '@kuraa/client/style.css';
import { mountApp, type ClientFeature } from '@kuraa/client';
import { standardTypes } from '@kuraa/formats';
import { standardEditors } from '@kuraa/formats/editor';
import { standardFeatureClients } from '@kuraa/features/client';
import { resolveShell } from './shell.js';

const features: Record<string, ClientFeature> = { ...standardFeatureClients };
// The browser tests' build (vite build --mode e2e) has the example feature too, whose host half
// their host loads (tests/e2e/serve.ts); in any other build this is not there at all.
if (import.meta.env.MODE === 'e2e') Object.assign(features, (await import('@kuraa/feature-example/client')).clients);

const { shell, overrides, defaults } = resolveShell();
mountApp(document.getElementById('root')!, { types: standardTypes, editors: standardEditors, features, shell, overrides, defaults });
