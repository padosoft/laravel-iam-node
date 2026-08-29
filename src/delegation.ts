/**
 * Delegated access (RFC 8693): the act chain, and the fail-closed rules around it.
 *
 * A delegated token carries TWO identities — `sub` is the user, `act` is the agent
 * acting for them, nested outward-in when the chain is longer than one hop. This
 * module never decides anything: it parses, and it refuses to guess.
 *
 * Parity target: `Padosoft\Iam\Client\Support\DelegatedBearerInspector` and
 * `DelegatedBearer` in the PHP SDK. The shapes and the failure modes are the same
 * on purpose — the server cannot tell the two callers apart.
 */

/** Header `typ` carried by tokens minted through the token-exchange grant. */
export const TYP_DELEGATED = 'delegated+jwt';

const AGENT_PREFIX = 'agent:';
/** A cyclic or absurdly deep `act` claim must not spin the parser. */
const MAX_CHAIN_DEPTH = 16;

/** One actor, as it appears in the `act` claim: `agent:<id>`. */
export type ActorId = string;

/**
 * The authorization view of a delegated bearer token.
 *
 * `verified` says where the view came from: `true` only when the claims were
 * returned by the server's introspection endpoint. A `verified: false` view is
 * routing information — it must never authorize anything.
 */
export interface DelegatedBearer {
  /** The delegating user — never the agent. */
  sub: string;
  /** The act chain, CURRENT actor first (outermost in the nested claim). */
  actors: ActorId[];
  /** `pds_dgr` — the grant this delegation descends from, for targeted revocation. */
  grantId: string | null;
  scopes: string[];
  verified: boolean;
}

/**
 * Thrown when a token IS delegated but cannot be read. Distinct from "not
 * delegated": the caller must deny, never fall back to the plain-user path.
 */
export class MalformedDelegationError extends Error {
  override readonly name = 'MalformedDelegationError';

  constructor(reason: string) {
    super(`malformed delegated token: ${reason}`);
  }
}

interface ActLevel {
  sub?: unknown;
  act?: unknown;
}

/**
 * Read the act chain out of an `act` claim. Returns `null` when the claim is
 * absent (the token is simply not delegated), and THROWS when it is present but
 * malformed.
 *
 * The asymmetry is deliberate and load-bearing: a token with an unreadable `act`
 * must not silently degrade into a full-authority user token. Absent means "not
 * delegated"; unreadable means "refuse". That silent degradation is precisely the
 * confused-deputy that delegation exists to prevent.
 */
export function actorChainFromClaims(claims: Record<string, unknown>): ActorId[] | null {
  const act = claims['act'];
  if (act === undefined || act === null) return null;

  const actors: ActorId[] = [];
  let level: unknown = act;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (typeof level !== 'object' || level === null || Array.isArray(level)) {
      throw new MalformedDelegationError('act level is not an object');
    }
    const sub = (level as ActLevel).sub;
    if (typeof sub !== 'string' || !sub.startsWith(AGENT_PREFIX) || sub.length <= AGENT_PREFIX.length) {
      throw new MalformedDelegationError('act level without a valid `agent:<id>` sub');
    }
    actors.push(sub);

    const next = (level as ActLevel).act;
    if (next === undefined || next === null) return actors;
    level = next;
  }
  throw new MalformedDelegationError(`chain deeper than ${MAX_CHAIN_DEPTH} hops`);
}

/** True when these claims describe a delegated token. */
export function isDelegated(claims: Record<string, unknown>): boolean {
  return claims['act'] !== undefined && claims['act'] !== null;
}

/** Split an OAuth `scope` string into a list, tolerating extra whitespace. */
export function parseScopes(scope: unknown): string[] {
  if (typeof scope !== 'string' || scope === '') return [];
  return scope.split(' ').filter((s) => s !== '');
}

/**
 * Build the authorization view from a set of claims. Used for BOTH halves of the
 * delegated path: the local (unverified, routing-only) inspection and the
 * introspected (verified) one — the parsing rules must not diverge between them.
 *
 * @throws MalformedDelegationError when the claims are delegated but unreadable
 */
export function delegatedBearerFromClaims(
  claims: Record<string, unknown>,
  verified: boolean,
): DelegatedBearer | null {
  const actors = actorChainFromClaims(claims);
  if (actors === null) return null;

  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub === '') {
    throw new MalformedDelegationError('delegated token without sub');
  }
  const grantId = claims['pds_dgr'];

  return {
    sub,
    actors,
    grantId: typeof grantId === 'string' && grantId !== '' ? grantId : null,
    scopes: parseScopes(claims['scope']),
    verified,
  };
}

/**
 * LOCAL inspection of a bearer JWT — no signature check (this SDK holds no keys
 * for it). It answers one question only: is this a delegated token, and to whom
 * does it refer? The answer is routing, never authorization: a delegated token is
 * authorized through introspection plus a delegated decision, never from what the
 * bytes say locally.
 *
 * Returns `null` when the token is not delegated (proceed on the normal path).
 *
 * @throws MalformedDelegationError when it looks delegated but is unreadable
 */
export function inspectDelegatedBearer(jwt: string): DelegatedBearer | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null; // not even a JWT: not delegated

  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header === null || claims === null) return null;

  const typDelegated = header['typ'] === TYP_DELEGATED;
  const hasAct = Object.prototype.hasOwnProperty.call(claims, 'act');
  if (!typDelegated && !hasAct) return null;

  // From here the token IS delegated: every defect throws (fail-closed).
  const bearer = delegatedBearerFromClaims(claims, false);
  if (bearer === null) {
    // `typ` said delegated but there is no `act` to act on — refuse rather than
    // hand back a token that would then be read as full user authority.
    throw new MalformedDelegationError('typ is delegated+jwt but the act claim is absent');
  }
  return bearer;
}

function decodeSegment(segment: string | undefined): Record<string, unknown> | null {
  if (segment === undefined || segment === '') return null;
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
