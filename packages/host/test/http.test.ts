// The HTTP helpers the host and the hub share.
import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { localUrl, sameToken, serveStaticFrom } from '../src/http.js';

describe('sameToken', () => {
  it('matches only the same token', () => {
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abd', 'abc')).toBe(false);
    expect(sameToken('abcd', 'abc')).toBe(false);
    expect(sameToken('', 'abc')).toBe(false);
    expect(sameToken(null, 'abc')).toBe(false);
    expect(sameToken(undefined, 'abc')).toBe(false);
  });
});

describe('localUrl', () => {
  it('reaches an address from this computer', () => {
    expect(localUrl({ address: '127.0.0.1', port: 4321, family: 'IPv4' })).toBe('http://127.0.0.1:4321');
    expect(localUrl({ address: '0.0.0.0', port: 80, family: 'IPv4' })).toBe('http://127.0.0.1:80');
    expect(localUrl({ address: '::1', port: 9, family: 'IPv6' })).toBe('http://[::1]:9');
  });
});

describe('serveStaticFrom', () => {
  it('answers a path that does not decode with 400, not an error', () => {
    let status = 0;
    const res = { writeHead: (s: number) => (status = s), end: () => undefined } as unknown as ServerResponse;
    expect(serveStaticFrom('/nonexistent', '/%E0%A4%A', res)).toBe(true);
    expect(status).toBe(400);
  });
});
