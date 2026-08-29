import { describe, it, expect } from 'vitest';
import { IamClient } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';
const INTROSPECT = 'https://iam.example.com/oauth/introspect';

function jwtOf(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64(header)}.${b64(claims)}.sig`;
}

const DELEGATED = jwtOf(
  { alg: 'ES256', typ: 'delegated+jwt' },
  { sub: 'user:42', act: { sub: 'agent:a1' }, pds_dgr: 'dgr_1', scope: 'orders:read' },
);

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): IamClient {
  return new IamClient({ baseUrl: BASE, token: 'svc-tok', fetch: fetchImpl, ...extra });
}

describe('verifyDelegatedToken — introspection is mandatory', () => {
  it('builds the view from the INTROSPECTED claims, not the local bytes', async () => {
    const { fetch, calls } = mockFetch(
      jsonResponse({
        active: true,
        sub: 'user:42',
        act: { sub: 'agent:hop2', act: { sub: 'agent:hop1' } },
        pds_dgr: 'dgr_server',
        scope: 'orders:read orders:draft',
      }),
    );

    const bearer = await client(fetch).verifyDelegatedToken(DELEGATED);

    // The local token said one hop and grant dgr_1; the server says two hops and
    // dgr_server. The server wins — that is what "server-side truth" means.
    expect(bearer).toEqual({
      sub: 'user:42',
      actors: ['agent:hop2', 'agent:hop1'],
      grantId: 'dgr_server',
      scopes: ['orders:read', 'orders:draft'],
      verified: true,
    });
    expect(calls[0]?.url).toBe(INTROSPECT);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(String(calls[0]?.init?.headers ? (calls[0].init.headers as Record<string, string>)['Content-Type'] : ''))
      .toBe('application/x-www-form-urlencoded');
    expect(String(calls[0]?.init?.body)).toContain(encodeURIComponent(DELEGATED));
  });

  it('falls back to the local chain when the server does not echo act', async () => {
    const { fetch } = mockFetch(jsonResponse({ active: true, sub: 'user:42' }));
    const bearer = await client(fetch).verifyDelegatedToken(DELEGATED);
    expect(bearer?.actors).toEqual(['agent:a1']);
    expect(bearer?.grantId).toBe('dgr_1');
    expect(bearer?.scopes).toEqual(['orders:read']);
    expect(bearer?.verified).toBe(true);
  });

  it('DENIES when the token is inactive — a revoked grant stops here', async () => {
    const { fetch } = mockFetch(jsonResponse({ active: false }));
    expect(await client(fetch).verifyDelegatedToken(DELEGATED)).toBeNull();
  });

  it('DENIES when introspection is unreachable — never degrades to the local parse', async () => {
    // This is the load-bearing case: the token looks perfectly well-formed and
    // says `sub: user:42`. Without introspection there is no way to know the
    // session is still alive, so the answer is deny, not "trust the bytes".
    const { fetch } = mockFetch(new Error('introspection down'));
    expect(await client(fetch).verifyDelegatedToken(DELEGATED)).toBeNull();
  });

  it('DENIES on a non-200 from introspection', async () => {
    const { fetch } = mockFetch(jsonResponse({ active: true, sub: 'user:42' }, 401));
    expect(await client(fetch).verifyDelegatedToken(DELEGATED)).toBeNull();
  });

  it('DENIES when introspection returns an unreadable act', async () => {
    const { fetch } = mockFetch(
      jsonResponse({ active: true, sub: 'user:42', act: { sub: 'user:99' } }),
    );
    expect(await client(fetch).verifyDelegatedToken(DELEGATED)).toBeNull();
  });

  it('DENIES when introspection omits sub', async () => {
    const { fetch } = mockFetch(jsonResponse({ active: true, scope: 'orders:read' }));
    expect(await client(fetch).verifyDelegatedToken(DELEGATED)).toBeNull();
  });

  it('DENIES a malformed delegated token WITHOUT calling introspection', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ active: true, sub: 'user:42' }));
    const broken = jwtOf({ alg: 'ES256' }, { sub: 'user:42', act: { sub: 'not-an-agent' } });
    expect(await client(fetch).verifyDelegatedToken(broken)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null for a PLAIN token: it is not this method’s business', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ active: true, sub: 'user:42' }));
    const plain = jwtOf({ alg: 'ES256' }, { sub: 'user:42', scope: 'orders:read' });
    expect(await client(fetch).verifyDelegatedToken(plain)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('honours an explicitly configured introspectionUrl', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ active: true, sub: 'user:42' }));
    const c = client(fetch, { introspectionUrl: 'https://auth.example.org/introspect' });
    await c.verifyDelegatedToken(DELEGATED);
    expect(calls[0]?.url).toBe('https://auth.example.org/introspect');
  });

  it('DENIES outright when introspection is disabled (empty url)', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ active: true, sub: 'user:42' }));
    const c = client(fetch, { introspectionUrl: '' });
    expect(await c.verifyDelegatedToken(DELEGATED)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
