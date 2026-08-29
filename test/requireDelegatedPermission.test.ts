import { describe, it, expect, vi } from 'vitest';
import { IamClient } from '../src/index.js';
import {
  requireDelegatedPermission,
  type MiddlewareRequest,
  type MiddlewareResponse,
} from '../src/middleware.js';
import { mockFetch, jsonResponse, type FetchCall } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';

function jwtOf(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64(header)}.${b64(claims)}.sig`;
}

const DELEGATED = jwtOf(
  { alg: 'ES256', typ: 'delegated+jwt' },
  { sub: 'user:42', act: { sub: 'agent:a1' }, pds_dgr: 'dgr_1', scope: 'orders:read' },
);
const PLAIN = jwtOf({ alg: 'ES256' }, { sub: 'user:42', scope: 'orders:read' });

function fakeRes() {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number): MiddlewareResponse {
      res.statusCode = code;
      return res;
    },
    json(body: unknown): MiddlewareResponse {
      res.body = body;
      return res;
    },
  };
  return res;
}

/** Serve introspection and the delegated check from one fetch, by URL. */
function routed(opts: { active?: boolean; allowed?: boolean } = {}) {
  return mockFetch((call: FetchCall) => {
    if (call.url.includes('introspect')) {
      return jsonResponse(
        opts.active === false
          ? { active: false }
          : { active: true, sub: 'user:42', act: { sub: 'agent:a1' }, pds_dgr: 'dgr_1', scope: 'orders:read' },
      );
    }
    return jsonResponse({ data: { allowed: opts.allowed !== false, decision_id: 'dec_1' } });
  });
}

function reqWith(token?: string): MiddlewareRequest {
  return token === undefined
    ? { headers: {} }
    : { headers: { authorization: `Bearer ${token}` } };
}

describe('requireDelegatedPermission', () => {
  it('grants and attaches the verified delegation to the request', async () => {
    const { fetch, calls } = routed();
    const mw = requireDelegatedPermission(new IamClient({ baseUrl: BASE, fetch }), 'orders.draft');
    const req = reqWith(DELEGATED);
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
    expect(req['iamDelegation']).toMatchObject({
      sub: 'user:42',
      actors: ['agent:a1'],
      grantId: 'dgr_1',
      verified: true,
    });
    // Introspection first, then the delegated decision — with the grant id, so a
    // revoked grant is caught by the PDP even inside the token's short lifetime.
    expect(calls[0]?.url).toContain('introspect');
    expect(calls[1]?.url).toBe(`${BASE}/decisions/check-delegated`);
    expect(calls[1]?.body).toMatchObject({
      subject: { id: 'user:42' },
      actors: ['agent:a1'],
      delegation_grant_id: 'dgr_1',
    });
  });

  it('401s a PLAIN token instead of falling back to the user path', async () => {
    // The route exists to say "only delegated callers". Silently accepting a
    // full-authority user token here would hand it more than delegation allows.
    const { fetch, calls } = routed();
    const mw = requireDelegatedPermission(new IamClient({ baseUrl: BASE, fetch }), 'orders.draft');
    const res = fakeRes();
    const next = vi.fn();

    await mw(reqWith(PLAIN), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('401s when there is no Authorization header at all', async () => {
    const { fetch } = routed();
    const mw = requireDelegatedPermission(new IamClient({ baseUrl: BASE, fetch }), 'orders.draft');
    const res = fakeRes();
    const next = vi.fn();

    await mw(reqWith(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s when the grant was revoked (introspection says inactive)', async () => {
    const { fetch } = routed({ active: false });
    const mw = requireDelegatedPermission(new IamClient({ baseUrl: BASE, fetch }), 'orders.draft');
    const res = fakeRes();
    const next = vi.fn();

    await mw(reqWith(DELEGATED), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when the PDP denies the delegated decision, and attaches nothing', async () => {
    const { fetch } = routed({ allowed: false });
    const mw = requireDelegatedPermission(new IamClient({ baseUrl: BASE, fetch }), 'orders.draft');
    const req = reqWith(DELEGATED);
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    // A denied request must not carry a delegation a handler could mistake for a grant.
    expect(req['iamDelegation']).toBeUndefined();
  });

  it('accepts a custom token resolver (non-header transports)', async () => {
    const { fetch } = routed();
    const mw = requireDelegatedPermission(new IamClient({ baseUrl: BASE, fetch }), 'orders.draft', {
      token: (r) => (r['agentToken'] as string | undefined),
    });
    const req: MiddlewareRequest = { agentToken: DELEGATED };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
