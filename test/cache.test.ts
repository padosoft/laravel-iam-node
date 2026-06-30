import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IamClient } from '../src/index.js';
import { mockFetch, jsonResponse } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';
const QUERY = { subject: { id: 'usr_1' }, permission: 'reports.view' } as const;

describe('decision cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves the second identical query from cache (no second request)', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true, policy_version: 1 } }));
    const c = new IamClient({ baseUrl: BASE, fetch, cache: { ttlMs: 5000 } });

    expect((await c.check(QUERY)).allowed).toBe(true);
    expect((await c.check(QUERY)).allowed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('re-fetches after the TTL elapses', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true, policy_version: 1 } }));
    const c = new IamClient({ baseUrl: BASE, fetch, cache: { ttlMs: 5000 } });

    await c.check(QUERY);
    vi.advanceTimersByTime(5001);
    await c.check(QUERY);
    expect(calls).toHaveLength(2);
  });

  it('invalidates the whole cache when policy_version increases', async () => {
    let version = 1;
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ data: { allowed: true, policy_version: version } }),
    );
    const c = new IamClient({ baseUrl: BASE, fetch, cache: { ttlMs: 60_000 } });

    await c.check(QUERY); // caches at v1
    await c.check({ subject: { id: 'usr_2' }, permission: 'reports.view' }); // v1 → bumps to 1, caches
    expect(calls).toHaveLength(2);

    version = 2; // server rolls policy forward
    await c.check({ subject: { id: 'usr_3' }, permission: 'reports.view' }); // sees v2 → clears cache
    expect(calls).toHaveLength(3);

    // The original query must now miss (cache was cleared by the version bump).
    await c.check(QUERY);
    expect(calls).toHaveLength(4);
  });

  it('never caches explain queries', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true, policy_version: 1 } }));
    const c = new IamClient({ baseUrl: BASE, fetch, cache: { ttlMs: 60_000 } });

    await c.check({ ...QUERY, explain: true });
    await c.check({ ...QUERY, explain: true });
    expect(calls).toHaveLength(2);
  });

  it('never turns a cached deny into an allow', async () => {
    const { fetch } = mockFetch(jsonResponse({ data: { allowed: false, policy_version: 1 } }));
    const c = new IamClient({ baseUrl: BASE, fetch, cache: { ttlMs: 60_000 } });

    expect((await c.check(QUERY)).allowed).toBe(false);
    expect((await c.check(QUERY)).allowed).toBe(false);
  });

  it('a transport error is never cached (deny is recomputed each time)', async () => {
    const { fetch, calls } = mockFetch(new Error('ECONNREFUSED'));
    const c = new IamClient({ baseUrl: BASE, fetch, cache: { ttlMs: 60_000 } });

    expect((await c.check(QUERY)).allowed).toBe(false);
    expect((await c.check(QUERY)).allowed).toBe(false);
    expect(calls).toHaveLength(2); // both attempted, neither cached
  });
});
