import { describe, it, expect, vi } from 'vitest';
import { IamClient } from '../src/index.js';
import { requirePermission, type MiddlewareRequest, type MiddlewareResponse } from '../src/middleware.js';
import { mockFetch, jsonResponse } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';

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

describe('requirePermission middleware', () => {
  it('calls next() when the PDP grants', async () => {
    const { fetch } = mockFetch(jsonResponse({ data: { allowed: true } }));
    const client = new IamClient({ baseUrl: BASE, fetch });
    const mw = requirePermission(client, 'stock.adjust');

    const req: MiddlewareRequest = { user: { id: 'usr_1' } };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it('responds 403 when the PDP denies', async () => {
    const { fetch } = mockFetch(jsonResponse({ data: { allowed: false } }));
    const client = new IamClient({ baseUrl: BASE, fetch });
    const mw = requirePermission(client, 'stock.adjust');

    const res = fakeRes();
    const next = vi.fn();
    await mw({ user: { id: 'usr_1' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe('forbidden');
  });

  it('responds 403 (step_up_required) when a step-up is pending — never treated as allow', async () => {
    const { fetch } = mockFetch(
      jsonResponse({ data: { allowed: true, requires_step_up: true, required_aal: 'aal2' } }),
    );
    const client = new IamClient({ baseUrl: BASE, fetch });
    const mw = requirePermission(client, 'stock.adjust');

    const res = fakeRes();
    const next = vi.fn();
    await mw({ user: { id: 'usr_1' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe('step_up_required');
    expect((res.body as { required_aal: string }).required_aal).toBe('aal2');
  });

  it('fail-closed: responds 403 with no subject and never calls the PDP', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true } }));
    const client = new IamClient({ baseUrl: BASE, fetch });
    const mw = requirePermission(client, 'stock.adjust');

    const res = fakeRes();
    const next = vi.fn();
    await mw({}, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('fail-closed: an unreachable PDP denies (403)', async () => {
    const { fetch } = mockFetch(new Error('ECONNREFUSED'));
    const client = new IamClient({ baseUrl: BASE, fetch });
    const mw = requirePermission(client, 'stock.adjust');

    const res = fakeRes();
    const next = vi.fn();
    await mw({ user: { id: 'usr_1' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('passes resolved subject/resource/context into the decision query', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { allowed: true } }));
    const client = new IamClient({ baseUrl: BASE, fetch });
    const mw = requirePermission(client, 'stock.adjust', {
      subject: (req) => ({ id: String((req.params as { uid: string }).uid) }),
      resource: { type: 'warehouse', id: 'wh_milan' },
      context: { amount: 300 },
      application: 'warehouse',
    });

    const res = fakeRes();
    await mw({ params: { uid: 'usr_9' } } as MiddlewareRequest, res, vi.fn());

    expect(calls[0]!.body).toMatchObject({
      subject: { type: 'user', id: 'usr_9' },
      permission: 'stock.adjust',
      application: 'warehouse',
      resource: { type: 'warehouse', id: 'wh_milan' },
      context: { amount: 300 },
    });
  });
});
