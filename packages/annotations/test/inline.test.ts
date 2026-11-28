import { describe, expect, it } from 'vitest';
import { huesFor } from '../src/inline.js';

describe('people’s colours in an inline thread', () => {
  it('gives each person in a thread a hue of their own, the same for them whatever else is in it', () => {
    const people = Array.from({ length: 10 }, (_, i) => String(i).repeat(64));
    const hues = huesFor(people);
    expect(new Set(hues.values()).size).toBe(10);
    // The first to write keeps their own, wherever they are.
    for (const p of people) expect(huesFor([p, ...people]).get(p)).toBe(huesFor([p]).get(p));
    // Written again: the same.
    expect(huesFor([people[0]!, people[1]!, people[0]!]).size).toBe(2);
  });
});
