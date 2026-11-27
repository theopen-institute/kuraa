// The keys of what ships (0091): every command and panel of the standard features
// (and the example, which the browser tests' build has) has its keys to itself,
// apart from the app's own keys and those the standard editor modules list. A
// clash is refused when the app runs (said in the console); here it fails.
import { describe, expect, it } from 'vitest';
import { standardFeatureClients } from '@kuraa/features/client';
import { clients as exampleClients } from '@kuraa/feature-example/client';
import { standardEditors } from '@kuraa/formats/editor';
import { claimKeys, commandsOf, takenKeys } from '@kuraa/client/commands';

describe('the standard features’ keys', () => {
  it('clash with nothing: each other, the app, or the editor modules', () => {
    const features = Object.values({ ...standardFeatureClients, ...exampleClients });
    const commands = features.flatMap((f) => commandsOf(f, f.helpGroup ?? f.id));
    const { refused } = claimKeys(commands, takenKeys(standardEditors));
    expect(refused.map(({ command: c, by }) => `${c.feature} ${c.id} (${c.keys}): ${by}`)).toEqual([]);
    // There is something to check.
    expect(commands.filter((c) => c.keys).length).toBeGreaterThan(5);
  });
});
