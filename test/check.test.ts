import { describe, it, expect } from 'vitest';
import { IamClient } from '../src/index.js';
import { jsonResponse, mockFetch, sequenceFetch } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): IamClient {
  return new IamClient({ baseUrl: BASE, token: 'svc-tok', fetch: fetchImpl, ...extra });
}

const QUERY = {
  subject: { type: 'user', id: 'usr_123' },
  application: 'warehouse',
  permission: 'stock.adjust',
  resource: { type: 'warehouse', id: 'wh_milan' },
  context: { amount: 300 },
} as const;

describe('check — happy path & wire contract', () => {
  it('returns the allow decision from a 200 (data-enveloped) response', async () => {
    const { fetch } = mockFetch(
      jsonResponse({
        data: {
          allowed: true,
          decision_id: 'dec_1',
          policy_version: 7,
          requires_step_up: false,
          required_aal: null,
          matched: [{ type: 'role', key: 'warehouse:stock_operator' }],
          explanation: ['ok'],
        },
      }),
    );
    const d = await client(fetch).check(QUERY);
    expect(d.allowed).toBe(true);
    expect(d.decisionId).toBe('dec_1');
    expect(d.policyVersion).toBe(7);
    expect(d.matched).toHaveLength(1);
  });

  it('also parses a flat (non-enveloped) body, like the PHP client mock', async () => {
    const { fetch } = mockFetch(jsonResponse({ allowed: true, decision_id: 'dec_flat' }));
    const d = await client(fetch).check(QUERY);
    expect(d.allowed).toBe(true);
    expect(d.decisionId).toBe('dec_flat');
  });

  it('posts the exact payload, endpoint, and Bearer auth the server expects', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true } }));
    await client(fetch).check(QUERY);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/decisions/check`);
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer svc-tok');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    // Mirrors DecisionRequest::toArray(): snake_case current_aal, all keys present.
    expect(call.body).toEqual({
      subject: { type: 'user', id: 'usr_123' },
      permission: 'stock.adjust',
      organization: null,
      application: 'warehouse',
      resource: { type: 'warehouse', id: 'wh_milan' },
      context: { amount: 300 },
      current_aal: 'aal1',
      explain: false,
    });
  });

  it('propagates step-up: allowed but requiresStepUp ⇒ not granted', async () => {
    const { fetch } = mockFetch(
      jsonResponse({ data: { allowed: true, requires_step_up: true, required_aal: 'aal2' } }),
    );
    const c = client(fetch);
    const d = await c.check(QUERY);
    expect(d.allowed).toBe(true);
    expect(d.requiresStepUp).toBe(true);
    expect(d.requiredAal).toBe('aal2');
    expect(await c.can(QUERY)).toBe(false);
  });

  it('omits the Authorization header when no token is configured', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true } }));
    await new IamClient({ baseUrl: BASE, fetch }).check(QUERY);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.has('authorization')).toBe(false);
  });
});

describe('check — fail-closed on every error path', () => {
  it('denies with no allow when there is no subject id', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true } }));
    const d = await client(fetch).check({ subject: { id: '' }, permission: 'x' });
    expect(d.allowed).toBe(false);
    expect(d.explanation).toContain('no-subject');
    expect(calls).toHaveLength(0); // never hits the network
  });

  it('denies on a 500 response', async () => {
    const { fetch } = mockFetch(new Response(null, { status: 500 }));
    expect((await client(fetch).check(QUERY)).allowed).toBe(false);
  });

  it('denies on a 4xx response (and does NOT retry it)', async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 403 }));
    const d = await client(fetch, { retries: 3 }).check(QUERY);
    expect(d.allowed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('denies on a network error', async () => {
    const { fetch } = mockFetch(new Error('ECONNREFUSED'));
    expect((await client(fetch).check(QUERY)).allowed).toBe(false);
  });

  it('denies on a malformed (non-JSON) 200 body', async () => {
    const { fetch } = mockFetch(
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect((await client(fetch).check(QUERY)).allowed).toBe(false);
  });

  it('denies on timeout (slow server, AbortController fires)', async () => {
    const slow = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const d = await client(slow, { timeoutMs: 20 }).check(QUERY);
    expect(d.allowed).toBe(false);
  });

  it('retries idempotent network errors, then succeeds within budget', async () => {
    const { fetch, calls } = sequenceFetch([
      new Error('ETIMEDOUT'),
      new Error('ECONNRESET'),
      jsonResponse({ data: { allowed: true, decision_id: 'dec_retry' } }),
    ]);
    const d = await client(fetch, { retries: 2 }).check(QUERY);
    expect(d.allowed).toBe(true);
    expect(d.decisionId).toBe('dec_retry');
    expect(calls).toHaveLength(3);
  });

  it('denies after exhausting the retry budget', async () => {
    const { fetch, calls } = mockFetch(new Error('ECONNREFUSED'));
    const d = await client(fetch, { retries: 2 }).check(QUERY);
    expect(d.allowed).toBe(false);
    expect(calls).toHaveLength(3); // initial + 2 retries
  });
});
