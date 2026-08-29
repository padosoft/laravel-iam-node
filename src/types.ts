/**
 * Wire types for the Laravel IAM control plane.
 *
 * These mirror, byte-for-byte, the canonical decision contract documented in
 * `01-architecture.md` §12 and implemented by the PHP client's `HttpDecider`
 * (`Padosoft\Iam\Client`). Keeping the shapes identical is what makes this SDK a
 * drop-in equivalent in another language: the server cannot tell the callers apart.
 */

/** A subject is whoever the decision is about (user, service account, group, agent…). */
export interface Subject {
  /** Subject kind. Defaults to `user` server-side when omitted. */
  type?: string;
  /** Stable subject identifier (e.g. `usr_123`). Required. */
  id: string;
}

/** A resource is the object an action targets (`{ type, id }`, e.g. a warehouse). */
export interface Resource {
  type: string;
  id: string;
}

/** Free-form ABAC facts evaluated by policy conditions (amount, time, ip…). */
export type DecisionContext = Record<string, unknown>;

/**
 * Input to `POST /decisions/check`. Matches `DecisionRequest::toArray()` of the
 * PHP client and the OpenAPI `DecisionQuery` request body.
 */
export interface DecisionQuery {
  subject: Subject;
  permission: string;
  organization?: string | null;
  application?: string | null;
  resource?: Resource | string | null;
  context?: DecisionContext;
  /** Current authenticator assurance level of the caller's session. Default `aal1`. */
  currentAal?: string;
  /** Ask the PDP for a step-by-step explanation. Explain queries are never cached. */
  explain?: boolean;
  /**
   * Delegation act chain (`agent:<id>`, CURRENT actor first). When present the
   * query is routed to `decisions/check-delegated` and the verdict is the strict
   * intersection of the subject and EVERY actor — never the union.
   */
  actors?: string[];
  /** `pds_dgr` of the grant the delegation descends from, so revocation is enforced per-grant. */
  delegationGrantId?: string | null;
}

/** One policy element the PDP matched while reaching its verdict. */
export interface DecisionMatch {
  type?: string;
  key?: string;
  [k: string]: unknown;
}

/**
 * Result of `POST /decisions/check`. Normalised from the server's `Decision`
 * payload (`01-architecture.md` §12). `allowed` alone is NOT permission: when
 * `requiresStepUp` is true the action is only permitted at a higher AAL — treat
 * it as not-yet-allowed. Use {@link granted} for the fail-safe interpretation.
 */
export interface Decision {
  allowed: boolean;
  decisionId: string;
  policyVersion: number;
  requiresStepUp: boolean;
  requiredAal: string | null;
  matched: DecisionMatch[];
  explanation: string[];
}

/** Verified JWT claims returned by {@link IamClient.verifyToken}. */
export interface Claims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  scope?: string;
  org?: string;
  client_id?: string;
  sid?: string;
  /** RFC 8693 §4.1 nested actor claim, present only on delegated tokens. */
  act?: { sub?: string; act?: unknown };
  /** Private claim: the delegation grant this token descends from. */
  pds_dgr?: string;
  [k: string]: unknown;
}

/** Optional short-TTL cache. Off by default — correctness before latency. */
export interface CacheOptions {
  /** Time-to-live in milliseconds. `<= 0` disables caching. */
  ttlMs: number;
  /** Max number of cached entries (LRU-ish eviction). Default 1000. */
  maxEntries?: number;
}

/** Token-verification settings for {@link IamClient.verifyToken}. */
export interface VerifyOptions {
  /** Expected `iss`. Defaults to the client `issuer`/`baseUrl` origin. */
  issuer?: string;
  /** Expected `aud` (string or list of acceptable audiences). */
  audience?: string | string[];
  /** Override the JWKS URL. Defaults to `<baseUrl origin>/.well-known/jwks.json`. */
  jwksUri?: string;
}

/** Constructor configuration for {@link IamClient}. */
export interface IamClientConfig {
  /**
   * Full API base URL of the IAM server, including the route prefix, e.g.
   * `https://iam.example.com/api/iam/v1`. Identical to the PHP client's
   * `iam-client.http.base_url`.
   */
  baseUrl: string;
  /** Static service token sent as `Authorization: Bearer`. Use this OR clientId+clientSecret. */
  token?: string;
  /**
   * Self-managed client_credentials auth: when both are set, the client mints/refreshes the token itself
   * and auto-follows IAM's client-secret rotation (self-fetch). Takes precedence over `token`.
   */
  clientId?: string;
  clientSecret?: string;
  /**
   * private_key_jwt (RFC 7523): an ES256 private key (PKCS#8 PEM). With clientId set, the client signs a
   * short-lived assertion instead of sending any secret. Highest precedence. Register the public key in IAM.
   */
  privateKey?: string;
  /** kid of the registered public key, written into the assertion header. */
  privateKeyKid?: string;
  /** OAuth base for token + self-fetch, e.g. `https://iam.example.com/oauth`. Defaults to `<origin>/oauth`. */
  oauthUrl?: string;
  /** Per-request timeout in milliseconds. Default 2000. */
  timeoutMs?: number;
  /** Retries for idempotent network errors only (never on 4xx/5xx). Default 0. */
  retries?: number;
  /** Opt-in decision cache. Off by default. */
  cache?: CacheOptions;
  /** Defaults applied to {@link IamClient.verifyToken}. */
  verify?: VerifyOptions;
  /**
   * Inject a `fetch` implementation (tests, custom agents). Defaults to the
   * global `fetch` (Node 18+ / undici).
   */
  fetch?: typeof fetch;
  /**
   * Path appended to `baseUrl` for the PDP check. Default `decisions/check`
   * (the canonical server route). Overridable for forward compatibility.
   */
  checkPath?: string;
  /** Path appended to `baseUrl` for ReBAC list-resources. Default `decisions/list-resources`. */
  listResourcesPath?: string;
  /**
   * Path appended to `baseUrl` for the DELEGATED PDP check. Default
   * `decisions/check-delegated` (the canonical server route).
   */
  checkDelegatedPath?: string;
  /**
   * RFC 7662 introspection endpoint, e.g. `https://iam.example.com/oauth/introspect`.
   * REQUIRED to accept delegated tokens: they are introspection-mandatory, so
   * without this {@link IamClient.verifyDelegatedToken} always denies.
   * Defaults to `<oauthUrl>/introspect`.
   */
  introspectionUrl?: string;
}
