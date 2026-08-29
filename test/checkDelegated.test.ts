import { describe, it, expect } from 'vitest';
import { IamClient } from '../src/index.js';
import { jsonResponse, mockFetch, sequenceFetch } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): IamClient {
  return new IamClient({ baseUrl: BASE, token: 'svc-tok', fetch: fetchImpl, ...extra });
}

function allow(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    data: {
      allowed: true,
      decision_id: 'dec_del_1',
      policy_version: 3,
      requires_step_up: false,
      required_aal: null,
      matched: [],
      explanation: ['ok'],
      ...overrides,
    },
  });
}

describe('checkDelegated — wire contract', () => {
  it('routes to decisions/check-delegated and sends the chain', async () => {
    const { fetch, calls } = mockFetch(allow());
    const decision = await client(fetch).checkDelegated(
      { type: 'user', id: 'usr_123' },
      ['agent:hop2', 'agent:hop1'],
      'orders.draft',
      { resource: { type: 'order', id: 'ord_1' }, delegationGrantId: 'dgr_9' },
    );

    expect(decision.allowed).toBe(true);
    expect(calls[0]?.url).toBe(`${BASE}/decisions/check-delegated`);
    expect(calls[0]?.body).toMatchObject({
      subject: { type: 'user', id: 'usr_123' },
      permission: 'orders.draft',
      actors: ['agent:hop2', 'agent:hop1'],
      delegation_grant_id: 'dgr_9',
      current_aal: 'aal1',
    });
  });

  it('leaves the PLAIN check body byte-identical (no delegation keys leak in)', async () => {
    const { fetch, calls } = mockFetch(allow());
    await client(fetch).check({ subject: { id: 'usr_123' }, permission: 'stock.adjust' });

    expect(calls[0]?.url).toBe(`${BASE}/decisions/check`);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('actors');
    expect(body).not.toHaveProperty('delegation_grant_id');
  });

  it('omits delegation_grant_id when there is none', async () => {
    const { fetch, calls } = mockFetch(allow());
    await client(fetch).checkDelegated({ id: 'usr_1' }, ['agent:a1'], 'orders.read');
    expect(calls[0]?.body).not.toHaveProperty('delegation_grant_id');
  });
});

describe('checkDelegated — fail-closed', () => {
  it('denies an EMPTY actor chain without calling the server', async () => {
    // An empty chain is not "fall back to the user check": it means the caller
    // lost track of who is acting. Falling back would hand the agent's request
    // the user's full authority — the exact escalation delegation prevents.
    const { fetch, calls } = mockFetch(allow());
    const decision = await client(fetch).checkDelegated({ id: 'usr_1' }, [], 'orders.read');

    expect(decision.allowed).toBe(false);
    expect(decision.explanation).toEqual(['no-actor']);
    expect(calls).toHaveLength(0);
  });

  it('denies a chain of only empty strings', async () => {
    const { fetch, calls } = mockFetch(allow());
    const decision = await client(fetch).checkDelegated({ id: 'usr_1' }, ['', ''], 'orders.read');
    expect(decision.allowed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('denies without a subject', async () => {
    const { fetch, calls } = mockFetch(allow());
    const decision = await client(fetch).checkDelegated({ id: '' }, ['agent:a1'], 'orders.read');
    expect(decision.explanation).toEqual(['no-subject']);
    expect(calls).toHaveLength(0);
  });

  it('denies on transport failure', async () => {
    const { fetch } = mockFetch(new Error('network down'));
    const decision = await client(fetch).checkDelegated({ id: 'usr_1' }, ['agent:a1'], 'orders.read');
    expect(decision.allowed).toBe(false);
    expect(decision.explanation).toEqual(['transport']);
  });

  it('canDelegated is false when a step-up is pending, even on allowed', async () => {
    const { fetch } = mockFetch(allow({ requires_step_up: true, required_aal: 'aal2' }));
    expect(await client(fetch).canDelegated({ id: 'usr_1' }, ['agent:a1'], 'orders.pay')).toBe(false);
  });
});

describe('checkDelegated — the cache must never outlive a revocation', () => {
  it('NEVER caches a delegated verdict, even with the cache enabled', async () => {
    const { fetch, calls } = sequenceFetch([allow(), allow()]);
    const c = client(fetch, { cache: { ttlMs: 60_000 } });

    await c.checkDelegated({ id: 'usr_1' }, ['agent:a1'], 'orders.read');
    await c.checkDelegated({ id: 'usr_1' }, ['agent:a1'], 'orders.read');

    // Two identical delegated checks ⇒ two round-trips. A cached allow would
    // survive the grant being revoked in between, which is the whole kill switch.
    expect(calls).toHaveLength(2);
  });

  it('still caches plain checks (delegation did not regress the fast path)', async () => {
    const { fetch, calls } = sequenceFetch([allow(), allow()]);
    const c = client(fetch, { cache: { ttlMs: 60_000 } });

    await c.check({ subject: { id: 'usr_1' }, permission: 'stock.adjust' });
    await c.check({ subject: { id: 'usr_1' }, permission: 'stock.adjust' });

    expect(calls).toHaveLength(1);
  });

  it('a cached PLAIN allow is never served to a delegated query', async () => {
    const { fetch, calls } = sequenceFetch([
      allow(),
      jsonResponse({ data: { allowed: false, decision_id: 'dec_deny', policy_version: 3, explanation: ['agent-denied'] } }),
    ]);
    const c = client(fetch, { cache: { ttlMs: 60_000 } });

    const plain = await c.check({ subject: { id: 'usr_1' }, permission: 'orders.read' });
    expect(plain.allowed).toBe(true);

    // Same user, same permission — but now an agent is acting. The agent layer
    // denies, and the user's cached allow must not shadow that.
    const delegated = await c.checkDelegated({ id: 'usr_1' }, ['agent:a1'], 'orders.read');
    expect(delegated.allowed).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
