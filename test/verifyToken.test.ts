import { describe, it, expect } from 'vitest';
import { IamClient, TokenVerificationError } from '../src/index.js';
import { makeSigningKit } from './helpers.js';

const BASE = 'https://iam.example.com/api/iam/v1';
const ISS = 'https://iam.example.com';

async function clientWithKit(verify?: Record<string, unknown>) {
  const kit = await makeSigningKit({ iss: ISS });
  const client = new IamClient({
    baseUrl: BASE,
    fetch: kit.fetch,
    verify: { issuer: ISS, audience: 'warehouse', jwksUri: kit.jwksUri, ...verify },
  });
  return { kit, client };
}

describe('verifyToken', () => {
  it('returns claims for a valid ES256 token (correct iss/aud, not expired)', async () => {
    const { kit, client } = await clientWithKit();
    const token = await kit.sign({ sub: 'usr_123', org: 'org_1' }, { aud: 'warehouse' });

    const claims = await client.verifyToken(token);
    expect(claims.sub).toBe('usr_123');
    expect(claims.iss).toBe(ISS);
    expect(claims.org).toBe('org_1');
  });

  it('rejects an expired token', async () => {
    const { kit, client } = await clientWithKit();
    const token = await kit.sign({ sub: 'usr_123' }, { aud: 'warehouse', expSec: -10 });

    await expect(client.verifyToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token with the wrong audience', async () => {
    const { kit, client } = await clientWithKit();
    const token = await kit.sign({ sub: 'usr_123' }, { aud: 'someone-else' });

    await expect(client.verifyToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token with the wrong issuer', async () => {
    const { kit, client } = await clientWithKit();
    const token = await kit.sign({ sub: 'usr_123' }, { aud: 'warehouse', iss: 'https://evil.example' });

    await expect(client.verifyToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token signed by a different (untrusted) key', async () => {
    const trusted = await makeSigningKit({ iss: ISS });
    const attacker = await makeSigningKit({ iss: ISS });
    const client = new IamClient({
      baseUrl: BASE,
      fetch: trusted.fetch, // serves only the trusted JWKS
      verify: { issuer: ISS, audience: 'warehouse', jwksUri: trusted.jwksUri },
    });
    const forged = await attacker.sign({ sub: 'usr_123' }, { aud: 'warehouse' });

    await expect(client.verifyToken(forged)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a malformed token string', async () => {
    const { client } = await clientWithKit();
    await expect(client.verifyToken('not-a-jwt')).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects an empty token without any network call', async () => {
    const { client } = await clientWithKit();
    await expect(client.verifyToken('')).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('fail-closed: rejects when no audience is configured (never accept-any-aud)', async () => {
    const kit = await makeSigningKit({ iss: ISS });
    const token = await kit.sign({ sub: 'usr_123' }, { aud: 'warehouse' });
    // No `audience` in client defaults nor in the call options → must throw,
    // not silently skip the `aud` check (jose's default when audience is absent).
    const client = new IamClient({
      baseUrl: BASE,
      fetch: kit.fetch,
      verify: { issuer: ISS, jwksUri: kit.jwksUri },
    });

    await expect(client.verifyToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
    // A per-call audience satisfies the requirement.
    const claims = await client.verifyToken(token, { audience: 'warehouse' });
    expect(claims.sub).toBe('usr_123');
  });

  it('rejects when the JWKS endpoint is unreachable', async () => {
    const kit = await makeSigningKit({ iss: ISS });
    const token = await kit.sign({ sub: 'usr_123' }, { aud: 'warehouse' });
    const downFetch = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const client = new IamClient({
      baseUrl: BASE,
      fetch: downFetch,
      verify: { issuer: ISS, audience: 'warehouse', jwksUri: kit.jwksUri },
    });

    await expect(client.verifyToken(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });
});
