// Fixed values shared by the Playwright config, the host it starts and the tests.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E = {
  port: 4400,
  url: 'http://127.0.0.1:4400',
  token: 'e2e-token',
  dir: join(tmpdir(), 'kuraa-e2e-workspace'),
};

export const NOTES = `---
title: Field notes
---

# Day one

The tide was already on the turn when we arrived.

Mateus recalibrated the *refractometer*   before lunch.

- quadrats every 5 m
- cores at 0 m and 25 m

## Day two

Light rain all morning.
`;
