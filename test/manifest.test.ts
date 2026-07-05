import { describe, it, expect } from 'vitest';
import { validateManifest, submitManifest } from '../src/index.js';
import { mockFetch, jsonResponse } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';

const VALID = {
  schema: 'laravel-iam.manifest.v2',
  app: { key: 'shop', name: 'Shop' },
  permissions: [{ key: 'orders.view', risk: 'low' }],
  roles: [{ key: 'clerk', permissions: ['orders.view'] }],
};

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(VALID)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a bad schema, a malformed app.key, and a dangling role reference', () => {
    const bad = {
      schema: 'wrong',
      app: { key: 'Bad Key', name: 'X' },
      permissions: [{ key: 'orders.view' }],
      roles: [{ key: 'clerk', permissions: ['orders.delete'] }],
    };
    const res = validateManifest(bad);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('schema'))).toBe(true);
    expect(res.errors.some((e) => e.includes('app.key'))).toBe(true);
    expect(res.errors.some((e) => e.includes('undeclared permission'))).toBe(true);
  });
});

describe('submitManifest', () => {
  it('POSTs the manifest with the bearer + an idempotency key', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { version: 4, status: 'approved' } }, 201));
    const res = await submitManifest(VALID, { baseUrl: BASE, token: 'svc-token', fetch });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ version: 4, status: 'approved' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/applications/shop/manifests`);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer svc-token');
    expect(headers['Idempotency-Key']).toBeTruthy();
    expect(calls[0].body).toEqual({ manifest: VALID });
  });

  it('fails locally (no network) when the manifest is invalid', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({}, 201));
    const res = await submitManifest({ schema: 'x', app: {} }, { baseUrl: BASE, token: 't', fetch });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0); // never hit the network
  });
});
