import { describe, it, expect } from 'vitest';
import {
  actorChainFromClaims,
  delegatedBearerFromClaims,
  inspectDelegatedBearer,
  isDelegated,
  MalformedDelegationError,
  parseScopes,
} from '../src/delegation.js';

/** Build an unsigned JWT-shaped string: local inspection never checks signatures. */
function jwtOf(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64(header)}.${b64(claims)}.signature-not-checked-here`;
}

describe('actorChainFromClaims — the act chain', () => {
  it('returns null when the token is simply not delegated', () => {
    expect(actorChainFromClaims({ sub: 'user:42' })).toBeNull();
    expect(actorChainFromClaims({ sub: 'user:42', act: null })).toBeNull();
  });

  it('reads a single hop', () => {
    expect(actorChainFromClaims({ act: { sub: 'agent:a1' } })).toEqual(['agent:a1']);
  });

  it('reads a nested chain CURRENT actor first, root last (RFC 8693 §4.1)', () => {
    const claims = { act: { sub: 'agent:hop2', act: { sub: 'agent:hop1' } } };
    // Outermost = the actor holding the token right now; innermost = the root the
    // user actually consented to. Getting this order backwards silently checks the
    // wrong agent, so it is pinned here.
    expect(actorChainFromClaims(claims)).toEqual(['agent:hop2', 'agent:hop1']);
  });

  it.each([
    ['act is a scalar', { act: 'agent:a1' }],
    ['act is an array', { act: ['agent:a1'] }],
    ['level without sub', { act: {} }],
    ['sub is not an agent', { act: { sub: 'user:42' } }],
    ['sub is the bare prefix', { act: { sub: 'agent:' } }],
    ['nested level is a scalar', { act: { sub: 'agent:a1', act: 'agent:a2' } }],
    ['nested level is an array', { act: { sub: 'agent:a1', act: ['x'] } }],
  ])('THROWS rather than degrading when %s', (_label, claims) => {
    expect(() => actorChainFromClaims(claims as Record<string, unknown>))
      .toThrow(MalformedDelegationError);
  });

  it('refuses a chain deeper than 16 hops instead of spinning', () => {
    let act: Record<string, unknown> = { sub: 'agent:leaf' };
    for (let i = 0; i < 40; i += 1) act = { sub: `agent:h${i}`, act };
    expect(() => actorChainFromClaims({ act })).toThrow(/deeper than 16/);
  });

  it('refuses a self-referential act claim (would otherwise loop forever)', () => {
    const level: Record<string, unknown> = { sub: 'agent:loop' };
    level['act'] = level;
    expect(() => actorChainFromClaims({ act: level })).toThrow(MalformedDelegationError);
  });
});

describe('isDelegated / parseScopes', () => {
  it('flags only claims that actually carry act', () => {
    expect(isDelegated({ act: { sub: 'agent:a1' } })).toBe(true);
    expect(isDelegated({ sub: 'user:42' })).toBe(false);
    expect(isDelegated({ act: null })).toBe(false);
  });

  it('splits scopes and drops the empty fragments', () => {
    expect(parseScopes('orders:read  orders:draft')).toEqual(['orders:read', 'orders:draft']);
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe('delegatedBearerFromClaims', () => {
  it('builds the view, keeping sub as the USER (never the agent)', () => {
    const bearer = delegatedBearerFromClaims(
      {
        sub: 'user:42',
        act: { sub: 'agent:a1' },
        pds_dgr: 'dgr_01J9',
        scope: 'orders:read orders:draft',
      },
      true,
    );
    expect(bearer).toEqual({
      sub: 'user:42',
      actors: ['agent:a1'],
      grantId: 'dgr_01J9',
      scopes: ['orders:read', 'orders:draft'],
      verified: true,
    });
  });

  it('throws when a delegated token has no sub', () => {
    expect(() => delegatedBearerFromClaims({ act: { sub: 'agent:a1' } }, false))
      .toThrow(/without sub/);
  });

  it('returns null (not delegated) when act is absent', () => {
    expect(delegatedBearerFromClaims({ sub: 'user:42' }, false)).toBeNull();
  });
});

describe('inspectDelegatedBearer — routing only, never authorization', () => {
  it('returns an UNVERIFIED view: local bytes never authorize', () => {
    const jwt = jwtOf(
      { alg: 'ES256', typ: 'delegated+jwt' },
      { sub: 'user:42', act: { sub: 'agent:a1' }, pds_dgr: 'dgr_1', scope: 'orders:read' },
    );
    const bearer = inspectDelegatedBearer(jwt);
    expect(bearer?.verified).toBe(false);
    expect(bearer?.sub).toBe('user:42');
    expect(bearer?.actors).toEqual(['agent:a1']);
  });

  it('detects delegation from the act claim even without the typ header', () => {
    const jwt = jwtOf({ alg: 'ES256' }, { sub: 'user:42', act: { sub: 'agent:a1' } });
    expect(inspectDelegatedBearer(jwt)?.actors).toEqual(['agent:a1']);
  });

  it('returns null for a plain user token (not this path)', () => {
    expect(inspectDelegatedBearer(jwtOf({ alg: 'ES256' }, { sub: 'user:42' }))).toBeNull();
  });

  it('returns null for something that is not a JWT at all', () => {
    expect(inspectDelegatedBearer('not-a-jwt')).toBeNull();
    expect(inspectDelegatedBearer('')).toBeNull();
  });

  it('THROWS when typ says delegated but there is no act to act on', () => {
    // The dangerous case: without the throw this would read back as a full-authority
    // user token, which is exactly the confused deputy delegation exists to prevent.
    const jwt = jwtOf({ alg: 'ES256', typ: 'delegated+jwt' }, { sub: 'user:42' });
    expect(() => inspectDelegatedBearer(jwt)).toThrow(MalformedDelegationError);
  });

  it('THROWS on a delegated token with a malformed act', () => {
    const jwt = jwtOf({ alg: 'ES256' }, { sub: 'user:42', act: { sub: 'nope' } });
    expect(() => inspectDelegatedBearer(jwt)).toThrow(MalformedDelegationError);
  });
});
