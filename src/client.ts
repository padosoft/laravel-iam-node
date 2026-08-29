import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { DecisionCache, cacheKey } from './cache.js';
import { decisionFromBody, deny, isGranted } from './decision.js';
import {
  delegatedBearerFromClaims,
  inspectDelegatedBearer,
  MalformedDelegationError,
  type DelegatedBearer,
} from './delegation.js';
import { TokenVerificationError } from './errors.js';
import {
  clientCredentialsTokenProvider,
  privateKeyJwtTokenProvider,
  staticTokenProvider,
  type TokenProvider,
} from './token-provider.js';
import type {
  Claims,
  Decision,
  DecisionQuery,
  IamClientConfig,
  Resource,
  VerifyOptions,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CHECK_PATH = 'decisions/check';
const DEFAULT_LIST_RESOURCES_PATH = 'decisions/list-resources';
const DEFAULT_CHECK_DELEGATED_PATH = 'decisions/check-delegated';

/**
 * Thin, fail-closed client for the Laravel IAM control plane.
 *
 * No PDP logic lives here: every authorization decision comes from the server's
 * `decisions/check` endpoint. The wire format (endpoint payload, Bearer auth,
 * response parsing, deny-on-error semantics) mirrors the PHP client's
 * `HttpDecider`/`DecisionRequest`/`IamDecision` so this SDK is a drop-in
 * equivalent in another language.
 */
export class IamClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenProvider;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: DecisionCache;
  private readonly checkPath: string;
  private readonly listResourcesPath: string;
  private readonly checkDelegatedPath: string;
  private readonly introspectionUrl: string;
  private readonly verifyDefaults: VerifyOptions;
  private readonly jwksMaxAgeMs: number;
  private readonly jwks = new Map<string, { keySet: JWTVerifyGetKey; fetchedAt: number }>();

  constructor(config: IamClientConfig) {
    if (!config.baseUrl) {
      throw new Error('IamClient: `baseUrl` is required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, config.retries ?? 0);
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    // Auth precedence: private_key_jwt (signed assertion, no secret) → self-managed client_credentials
    // (mint/refresh + auto-follow secret rotation via self-fetch) → static token.
    const oauthUrl = config.oauthUrl ?? new URL('/oauth', this.baseUrl).href.replace(/\/+$/, '');
    if (config.clientId && config.privateKey) {
      this.tokens = privateKeyJwtTokenProvider({
        fetch: this.fetchImpl,
        oauthUrl,
        clientId: config.clientId,
        privateKeyPem: config.privateKey,
        ...(config.privateKeyKid !== undefined ? { kid: config.privateKeyKid } : {}),
        timeoutMs: this.timeoutMs,
      });
    } else if (config.clientId && config.clientSecret) {
      this.tokens = clientCredentialsTokenProvider({
        fetch: this.fetchImpl,
        oauthUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        timeoutMs: this.timeoutMs,
      });
    } else {
      this.tokens = staticTokenProvider(config.token);
    }
    this.cache = new DecisionCache(config.cache?.ttlMs ?? 0, config.cache?.maxEntries);
    this.checkPath = trimPath(config.checkPath ?? DEFAULT_CHECK_PATH);
    this.listResourcesPath = trimPath(config.listResourcesPath ?? DEFAULT_LIST_RESOURCES_PATH);
    this.checkDelegatedPath = trimPath(config.checkDelegatedPath ?? DEFAULT_CHECK_DELEGATED_PATH);
    this.introspectionUrl = config.introspectionUrl ?? `${oauthUrl}/introspect`;
    this.verifyDefaults = config.verify ?? {};
    this.jwksMaxAgeMs = 10 * 60 * 1000; // refetch JWKS at most every 10 minutes

    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'IamClient: no `fetch` available. Use Node 18+ or pass `fetch` in the config.',
      );
    }
  }

  /**
   * Ask the PDP whether `query` is permitted. Fail-closed by construction: any
   * network error, timeout, non-2xx status, or malformed body resolves to a
   * deny — it never throws and never returns allow on uncertainty.
   */
  async check(query: DecisionQuery): Promise<Decision> {
    if (!query.subject || !query.subject.id) {
      return deny('no-subject');
    }

    const payload = toPayload(query);
    const explain = query.explain === true;
    const delegated = payload['actors'] !== undefined;

    // Explain queries are never cached (fresh, non-shared reasoning), and neither
    // are DELEGATED ones: a grant can be revoked at any moment, and the whole point
    // of short-lived delegation is that the verdict is never older than the request.
    // A cached delegated allow would outlive the revocation that was supposed to
    // stop it. The extra round-trip is the price of the kill switch actually working.
    const key = !explain && !delegated && this.cache.enabled ? cacheKey(payload) : undefined;
    if (key !== undefined) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    const body = await this.requestJson(delegated ? this.checkDelegatedPath : this.checkPath, payload);
    if (body === undefined) {
      // Transport error / non-2xx / malformed body: fail closed. Never cached —
      // a synthetic deny must not outlive the outage that caused it.
      return deny('transport');
    }

    const decision = decisionFromBody(body);
    if (key !== undefined) {
      this.cache.set(key, decision);
    }
    return decision;
  }

  /**
   * Convenience wrapper around {@link check}: returns `true` only when the PDP
   * allowed AND no step-up is pending (fail-safe). Mirrors PHP `IamClient::can()`.
   */
  async can(query: DecisionQuery): Promise<boolean> {
    return isGranted(await this.check(query));
  }

  /**
   * Ask the PDP whether an AGENT may do something ON BEHALF OF a user.
   *
   * The verdict is the strict intersection — the subject's authority AND every
   * actor's authority AND the grant's scope — never the union. Adding a hop can
   * only ever narrow what is permitted; it can never grant anything new. An empty
   * chain is not "check the user instead", it is a deny: calling the delegated
   * path with no actor means the caller lost track of who is acting.
   *
   * @param actors act chain, `agent:<id>`, CURRENT actor first
   */
  async checkDelegated(
    subject: { type?: string; id: string },
    actors: string[],
    permission: string,
    options: Omit<DecisionQuery, 'subject' | 'permission' | 'actors'> = {},
  ): Promise<Decision> {
    if (!subject || !subject.id) return deny('no-subject');

    const chain = (actors ?? []).filter((a): a is string => typeof a === 'string' && a !== '');
    if (chain.length === 0) return deny('no-actor');

    return this.check({ ...options, subject, permission, actors: chain });
  }

  /**
   * Fail-safe wrapper around {@link checkDelegated}: `true` only when the PDP
   * allowed AND no step-up is pending. Mirrors PHP `IamClient::canDelegated()`.
   */
  async canDelegated(
    subject: { type?: string; id: string },
    actors: string[],
    permission: string,
    options: Omit<DecisionQuery, 'subject' | 'permission' | 'actors'> = {},
  ): Promise<boolean> {
    return isGranted(await this.checkDelegated(subject, actors, permission, options));
  }

  /**
   * Verify a DELEGATED bearer token. Delegated tokens are INTROSPECTION-MANDATORY
   * (RFC 7662): the authorization view is built from the claims the server returns
   * — it verifies the signature, the expiry AND that the user's session is still
   * alive — never from the local parse. `typ: delegated+jwt` is routing, not a
   * defence.
   *
   * Fail-closed WITHOUT throwing: any problem at all (not delegated, malformed,
   * no introspection endpoint, transport failure, inactive token, incoherent
   * claims) resolves to `null`, which callers must treat as a 401.
   *
   * Returns `null` for a NON-delegated token too: that token is not this method's
   * business — verify it with {@link verifyToken} on the normal path.
   */
  async verifyDelegatedToken(jwt: string): Promise<DelegatedBearer | null> {
    let local: DelegatedBearer | null;
    try {
      local = inspectDelegatedBearer(jwt);
    } catch (err) {
      if (err instanceof MalformedDelegationError) return null; // never degrade
      return null;
    }
    if (local === null) return null; // not delegated: not this path

    if (this.introspectionUrl === '') return null; // no introspection ⇒ no delegated authority

    const body = await this.introspect(jwt);
    if (body === undefined) return null;
    if (body['active'] !== true) return null;

    // The authorization view comes from the INTROSPECTED claims (server-side truth),
    // falling back to the local values only for fields introspection may omit.
    try {
      const introspected = delegatedBearerFromClaims(body, true);
      if (introspected !== null) {
        return {
          sub: introspected.sub,
          actors: introspected.actors,
          grantId: introspected.grantId ?? local.grantId,
          scopes: introspected.scopes.length > 0 ? introspected.scopes : local.scopes,
          verified: true,
        };
      }
    } catch {
      return null; // introspection returned an unreadable act: refuse
    }

    // Active, but the server did not echo `act`: keep the local chain, which the
    // signature-verified introspection has just vouched for as a whole.
    const sub = body['sub'];
    if (typeof sub !== 'string' || sub === '') return null;
    const grantId = body['pds_dgr'];
    const scope = body['scope'];

    return {
      sub,
      actors: local.actors,
      grantId: typeof grantId === 'string' && grantId !== '' ? grantId : local.grantId,
      scopes: typeof scope === 'string' && scope !== ''
        ? scope.split(' ').filter((s) => s !== '')
        : local.scopes,
      verified: true,
    };
  }

  /**
   * ReBAC list-resources (M16): the resources on which `subject` has `relation`.
   * Fail-closed: on any error returns an empty list (never a speculative grant).
   */
  async listResources(subject: { type?: string; id: string }, relation: string): Promise<Resource[]> {
    if (!subject || !subject.id || !relation) return [];

    const body = await this.requestJson(this.listResourcesPath, {
      subject: { type: subject.type ?? 'user', id: subject.id },
      relation,
    });
    if (body === undefined) return [];

    const data = unwrap(body);
    const resources = data && typeof data === 'object' ? (data as Record<string, unknown>)['resources'] : undefined;
    if (!Array.isArray(resources)) return [];

    return resources.filter(
      (r): r is Resource =>
        typeof r === 'object' && r !== null &&
        typeof (r as Resource).type === 'string' &&
        typeof (r as Resource).id === 'string',
    );
  }

  /**
   * Verify an access/ID token's signature (ES256) and `iss`/`aud`/`exp`/`nbf`
   * against the server JWKS (`.well-known/jwks.json`). Resolves to the verified
   * {@link Claims}, or rejects with {@link TokenVerificationError}. Rejection is
   * the fail-closed signal — callers must treat it as deny.
   */
  async verifyToken(jwt: string, options?: VerifyOptions): Promise<Claims> {
    if (typeof jwt !== 'string' || jwt === '') {
      throw new TokenVerificationError('empty token');
    }

    const opts = { ...this.verifyDefaults, ...options };

    // Fail-closed on audience: jose silently SKIPS the `aud` check when no
    // audience is supplied, so a token minted for another service in the same
    // cluster (right issuer, right signing key) would verify. Require an explicit
    // audience rather than accept-any. Callers must set `verify.audience` (client
    // default) or pass `options.audience`.
    if (opts.audience === undefined) {
      throw new TokenVerificationError(
        'audience is required: set `verify.audience` on the client or pass `options.audience` to verifyToken',
      );
    }

    const uri = opts.jwksUri ?? this.defaultJwksUri();
    const issuer = opts.issuer ?? this.defaultIssuer();
    const verifyOptions = {
      algorithms: ['ES256'],
      ...(issuer !== undefined ? { issuer } : {}),
      audience: opts.audience,
    };

    // First pass against the cached JWKS; on a key-resolution miss (likely a key
    // rotation) refetch once and retry. Any other failure denies immediately.
    let refetched = false;
    for (;;) {
      let keySet: JWTVerifyGetKey;
      try {
        keySet = await this.resolveJwks(uri, refetched);
      } catch (err) {
        throw new TokenVerificationError(jwksFailureReason(err), { cause: err });
      }

      try {
        const { payload } = await jwtVerify(jwt, keySet, verifyOptions);
        return payload as Claims;
      } catch (err) {
        if (!refetched && isKeyResolutionError(err)) {
          refetched = true; // give rotation a single chance
          continue;
        }
        const reason = err instanceof Error ? err.message : 'unknown';
        throw new TokenVerificationError(reason, { cause: err });
      }
    }
  }

  // ---- internals -------------------------------------------------------------

  /**
   * POST JSON and return the parsed body, or `undefined` on any failure (network,
   * timeout, non-2xx, unparseable JSON). Retries apply ONLY to idempotent network
   * errors, never to a 4xx/5xx response (`http_errors => false` semantics).
   */
  private async requestJson(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}/${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const token = await this.tokens();
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const serialized = JSON.stringify(payload);

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: serialized,
          signal: controller.signal,
        });

        if (response.status < 200 || response.status >= 300) {
          return undefined; // non-2xx → deny, no retry
        }
        try {
          return await response.json();
        } catch {
          return undefined; // malformed body → deny
        }
      } catch {
        // Network error / timeout / abort: idempotent, so retry if budget remains.
        if (attempt >= this.retries) return undefined;
      } finally {
        clearTimeout(timer);
      }
    }
    return undefined;
  }

  /**
   * RFC 7662 introspection. Form-encoded, like the PHP client, because that is
   * what the spec mandates and what the server's endpoint accepts. Returns the
   * parsed body, or `undefined` on any failure (fail-closed at the call site).
   */
  private async introspect(jwt: string): Promise<Record<string, unknown> | undefined> {
    const form = new URLSearchParams({ token: jwt });
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    // Introspection authenticates the CALLER (the resource server), not the token.
    const token = await this.tokens();
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.introspectionUrl, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status !== 200) return undefined;
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
      return body as Record<string, unknown>;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Return a local JWKS key set for `uri`, fetched through the client's own
   * `fetch` (so it honours the configured fetch/timeout and is testable). Cached
   * for {@link jwksMaxAgeMs}; `force` bypasses the cache for rotation handling.
   */
  private async resolveJwks(uri: string, force = false): Promise<JWTVerifyGetKey> {
    const cached = this.jwks.get(uri);
    if (!force && cached && Date.now() - cached.fetchedAt < this.jwksMaxAgeMs) {
      return cached.keySet;
    }

    const document = await this.fetchJwks(uri);
    const keySet = createLocalJWKSet(document);
    this.jwks.set(uri, { keySet, fetchedAt: Date.now() });
    return keySet;
  }

  private async fetchJwks(uri: string): Promise<JSONWebKeySet> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(uri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`jwks http ${response.status}`);
      }
      const body: unknown = await response.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !Array.isArray((body as { keys?: unknown }).keys)
      ) {
        throw new Error('malformed jwks document');
      }
      return body as JSONWebKeySet;
    } finally {
      clearTimeout(timer);
    }
  }

  /** JWKS lives at the server root, not under the API prefix (see `routes/oidc.php`). */
  private defaultJwksUri(): string {
    return new URL('/.well-known/jwks.json', this.baseUrl).href;
  }

  private defaultIssuer(): string | undefined {
    return new URL(this.baseUrl).origin;
  }
}

function trimPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** jose throws specific codes when no key in the set matches the token's header. */
function isKeyResolutionError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === 'ERR_JWKS_NO_MATCHING_KEY' || code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS';
}

function jwksFailureReason(err: unknown): string {
  return err instanceof Error ? `jwks: ${err.message}` : 'jwks: unknown';
}

function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const data = (body as Record<string, unknown>)['data'];
    if (data && typeof data === 'object') return data;
  }
  return body;
}

/**
 * Serialise a {@link DecisionQuery} into the exact JSON body the server expects,
 * matching `DecisionRequest::toArray()` of the PHP client: `current_aal` snake-case,
 * all keys present (nulls included), `subject.type` defaulted to `user`.
 */
function toPayload(query: DecisionQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subject: { type: query.subject.type ?? 'user', id: query.subject.id },
    permission: query.permission,
    organization: query.organization ?? null,
    application: query.application ?? null,
    resource: query.resource ?? null,
    context: query.context ?? {},
    current_aal: query.currentAal ?? 'aal1',
    explain: query.explain === true,
  };

  // Delegation keys are ONLY present on delegated queries: the plain-check body
  // must stay byte-identical to what it has always been, so an older server that
  // never heard of delegation is unaffected.
  const actors = (query.actors ?? []).filter((a): a is string => typeof a === 'string' && a !== '');
  if (actors.length > 0) {
    body['actors'] = actors;
    if (typeof query.delegationGrantId === 'string' && query.delegationGrantId !== '') {
      body['delegation_grant_id'] = query.delegationGrantId;
    }
  }

  return body;
}
