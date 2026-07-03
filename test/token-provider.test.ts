import { describe, it, expect, vi } from 'vitest';
import { clientCredentialsTokenProvider, staticTokenProvider } from '../src/token-provider.js';

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const opts = (fetch: typeof globalThis.fetch, secret = 's') => ({
  fetch,
  oauthUrl: 'https://iam.test/oauth',
  clientId: 'cli',
  clientSecret: secret,
  timeoutMs: 1000,
});

describe('token providers', () => {
  it('static: returns the token, or undefined when empty', async () => {
    expect(await staticTokenProvider('t')()).toBe('t');
    expect(await staticTokenProvider('')()).toBeUndefined();
    expect(await staticTokenProvider(undefined)()).toBeUndefined();
  });

  it('client_credentials: mints via client_credentials then caches', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(res(200, { access_token: 'AT1', expires_in: 900 }));
    const p = clientCredentialsTokenProvider(opts(fetch as unknown as typeof globalThis.fetch));
    expect(await p()).toBe('AT1');
    expect(await p()).toBe('AT1'); // served from cache
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('client_credentials: on 401 self-fetches the rotated secret and retries (rollover)', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(res(401, {}))
      .mockResolvedValueOnce(res(200, { rotated: true, client_secret: 'NEW' }))
      .mockResolvedValueOnce(res(200, { access_token: 'AT2', expires_in: 900 }));
    const p = clientCredentialsTokenProvider(opts(fetch as unknown as typeof globalThis.fetch, 'OLD'));
    expect(await p()).toBe('AT2');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('client_credentials: fail-closed → undefined when token + self-fetch both fail', async () => {
    const fetch = vi.fn().mockResolvedValue(res(500, {}));
    const p = clientCredentialsTokenProvider(opts(fetch as unknown as typeof globalThis.fetch));
    expect(await p()).toBeUndefined();
  });
});
