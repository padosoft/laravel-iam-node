import { describe, it, expect } from 'vitest';
import { IamClient } from '../src/index.js';
import { mockFetch, jsonResponse } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';

describe('listResources (ReBAC M16)', () => {
  it('returns the resources from a data-enveloped response and posts the right body', async () => {
    const { fetch, calls } = mockFetch(
      jsonResponse({ data: { resources: [{ type: 'doc', id: '42' }, { type: 'doc', id: '7' }] } }),
    );
    const client = new IamClient({ baseUrl: BASE, token: 't', fetch });

    const resources = await client.listResources({ id: 'usr_1' }, 'owner');
    expect(resources).toEqual([{ type: 'doc', id: '42' }, { type: 'doc', id: '7' }]);

    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/decisions/list-resources`);
    expect(call.body).toEqual({ subject: { type: 'user', id: 'usr_1' }, relation: 'owner' });
  });

  it('fail-closed: returns an empty list on a server error', async () => {
    const { fetch } = mockFetch(new Response(null, { status: 500 }));
    const client = new IamClient({ baseUrl: BASE, fetch });
    expect(await client.listResources({ id: 'usr_1' }, 'owner')).toEqual([]);
  });

  it('fail-closed: returns an empty list on a network error', async () => {
    const { fetch } = mockFetch(new Error('ECONNREFUSED'));
    const client = new IamClient({ baseUrl: BASE, fetch });
    expect(await client.listResources({ id: 'usr_1' }, 'owner')).toEqual([]);
  });

  it('returns an empty list (no network call) when subject or relation is missing', async () => {
    const { fetch, calls } = mockFetch(jsonResponse({ data: { resources: [] } }));
    const client = new IamClient({ baseUrl: BASE, fetch });
    expect(await client.listResources({ id: '' }, 'owner')).toEqual([]);
    expect(await client.listResources({ id: 'usr_1' }, '')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('drops malformed resource entries', async () => {
    const { fetch } = mockFetch(
      jsonResponse({ data: { resources: [{ type: 'doc', id: '1' }, { type: 'doc' }, 'nope', null] } }),
    );
    const client = new IamClient({ baseUrl: BASE, fetch });
    expect(await client.listResources({ id: 'usr_1' }, 'owner')).toEqual([{ type: 'doc', id: '1' }]);
  });
});
