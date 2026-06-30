import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { DecisionCache, cacheKey } from './cache.js';
import { decisionFromBody, deny, isGranted } from './decision.js';
import { TokenVerificationError } from './errors.js';
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
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: DecisionCache;
  private readonly checkPath: string;
  private readonly listResourcesPath: string;
  private readonly verifyDefaults: VerifyOptions;
  private readonly jwksMaxAgeMs: number;
  private readonly jwks = new Map<string, { keySet: JWTVerifyGetKey; fetchedAt: number }>();

  constructor(config: IamClientConfig) {
    if (!config.baseUrl) {
      throw new Error('IamClient: `baseUrl` is required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    if (config.token !== undefined) this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, config.retries ?? 0);
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.cache = new DecisionCache(config.cache?.ttlMs ?? 0, config.cache?.maxEntries);
    this.checkPath = trimPath(config.checkPath ?? DEFAULT_CHECK_PATH);
    this.listResourcesPath = trimPath(config.listResourcesPath ?? DEFAULT_LIST_RESOURCES_PATH);
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

    // Explain queries are never cached (fresh, non-shared reasoning).
    const key = !explain && this.cache.enabled ? cacheKey(payload) : undefined;
    if (key !== undefined) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    const body = await this.requestJson(this.checkPath, payload);
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
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
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
  return {
    subject: { type: query.subject.type ?? 'user', id: query.subject.id },
    permission: query.permission,
    organization: query.organization ?? null,
    application: query.application ?? null,
    resource: query.resource ?? null,
    context: query.context ?? {},
    current_aal: query.currentAal ?? 'aal1',
    explain: query.explain === true,
  };
}
