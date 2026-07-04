import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  clientCredentialsTokenProvider,
  privateKeyJwtTokenProvider,
  staticTokenProvider,
} from '../src/token-provider.js';

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

  it('private_key_jwt: signs an ES256 assertion and mints a token (no shared secret)', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    let sentBody = '';
    const fetch = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return res(200, { access_token: 'AT-PK', expires_in: 900 });
    });

    const p = privateKeyJwtTokenProvider({
      fetch: fetch as unknown as typeof globalThis.fetch,
      oauthUrl: 'https://iam.test/oauth',
      clientId: 'cli',
      privateKeyPem: pem,
      kid: 'k1',
      timeoutMs: 1000,
    });

    expect(await p()).toBe('AT-PK');
    expect(await p()).toBe('AT-PK'); // cached
    expect(fetch).toHaveBeenCalledTimes(1);

    const params = new URLSearchParams(sentBody);
    expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect((params.get('client_assertion') ?? '').split('.').length).toBe(3);
    expect(params.get('client_secret')).toBeNull();
  });
});
