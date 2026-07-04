import { SignJWT, importPKCS8 } from 'jose';

/**
 * Bearer resolution for the Admin API (mirrors the PHP client's TokenProvider). Three modes:
 * a static token supplied by the app; self-managed `client_credentials` that mints/refreshes the token and —
 * when IAM auto-rotates the client secret — self-fetches the new one during the grace and hot-swaps; or
 * `private_key_jwt`, which signs a short-lived ES256 assertion instead of sending any shared secret.
 * Fail-closed: on any failure the provider resolves to `undefined` → no Authorization header → the PDP denies.
 */
export type TokenProvider = () => Promise<string | undefined>;

export function staticTokenProvider(token?: string): TokenProvider {
  return async () => (typeof token === 'string' && token !== '' ? token : undefined);
}

export interface ClientCredentialsOptions {
  fetch: typeof fetch;
  oauthUrl: string; // e.g. https://iam.example.com/oauth
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  skewMs?: number; // refresh the token this long before it expires
}

export function clientCredentialsTokenProvider(opts: ClientCredentialsOptions): TokenProvider {
  const skewMs = opts.skewMs ?? 30_000;
  const base = opts.oauthUrl.replace(/\/+$/, '');
  let cachedToken: string | undefined;
  let expiresAt = 0;
  let currentSecret = opts.clientSecret;

  const basic = (secret: string): string =>
    'Basic ' + Buffer.from(`${opts.clientId}:${secret}`).toString('base64');

  async function post(path: string, secret: string, body?: string): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: basic(secret),
        ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      signal: controller.signal,
    };
    if (body !== undefined) init.body = body;
    try {
      return await opts.fetch(`${base}/${path}`, init);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestToken(secret: string): Promise<string | undefined> {
    const res = await post('token', secret, 'grant_type=client_credentials');
    if (!res || res.status !== 200) return undefined;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return undefined;
    }
    const token = (body as Record<string, unknown> | null)?.['access_token'];
    if (typeof token !== 'string' || token === '') return undefined;
    const expiresIn = (body as Record<string, unknown>)['expires_in'];
    const ttl = typeof expiresIn === 'number' ? expiresIn : 900;
    cachedToken = token;
    expiresAt = Date.now() + Math.max(1, ttl * 1000 - skewMs);
    return token;
  }

  // On a rotated secret, retrieve the new one authenticating with the still-valid current secret.
  async function fetchRotatedSecret(): Promise<boolean> {
    const res = await post('client-secret', currentSecret);
    if (!res || res.status !== 200) return false;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return false;
    }
    const b = body as Record<string, unknown> | null;
    if (b?.['rotated'] === true && typeof b['client_secret'] === 'string' && b['client_secret'] !== '') {
      currentSecret = b['client_secret'] as string;
      return true;
    }
    return false;
  }

  return async () => {
    if (cachedToken !== undefined && Date.now() < expiresAt) return cachedToken;
    let token = await requestToken(currentSecret);
    if (token === undefined && (await fetchRotatedSecret())) {
      token = await requestToken(currentSecret);
    }
    return token;
  };
}

export interface PrivateKeyJwtOptions {
  fetch: typeof fetch;
  oauthUrl: string; // e.g. https://iam.example.com/oauth
  clientId: string;
  privateKeyPem: string; // ES256 private key, PKCS#8 PEM
  kid?: string;
  timeoutMs: number;
  skewMs?: number; // refresh the token this long before it expires
  assertionTtlSec?: number; // lifetime of each signed assertion (kept short)
}

/**
 * private_key_jwt (RFC 7523): sign a short-lived ES256 assertion with the app's private key and exchange it
 * for an access token via client_credentials — no shared secret is ever sent. The token is cached until just
 * before it expires. Fail-closed: any failure resolves to `undefined`.
 */
export function privateKeyJwtTokenProvider(opts: PrivateKeyJwtOptions): TokenProvider {
  const skewMs = opts.skewMs ?? 30_000;
  const ttl = opts.assertionTtlSec ?? 60;
  const base = opts.oauthUrl.replace(/\/+$/, '');
  let cachedToken: string | undefined;
  let expiresAt = 0;

  async function buildAssertion(): Promise<string> {
    const key = await importPKCS8(opts.privateKeyPem, 'ES256');
    const header =
      opts.kid !== undefined && opts.kid !== ''
        ? ({ alg: 'ES256', kid: opts.kid } as const)
        : ({ alg: 'ES256' } as const);
    return await new SignJWT({})
      .setProtectedHeader(header)
      .setIssuer(opts.clientId)
      .setSubject(opts.clientId)
      .setAudience(`${base}/token`)
      .setJti(globalThis.crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(key);
  }

  return async () => {
    if (cachedToken !== undefined && Date.now() < expiresAt) return cachedToken;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await buildAssertion(),
      }).toString();
      const res = await opts.fetch(`${base}/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      if (res.status !== 200) return undefined;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return undefined;
      }
      const token = (json as Record<string, unknown> | null)?.['access_token'];
      if (typeof token !== 'string' || token === '') return undefined;
      const expiresIn = (json as Record<string, unknown>)['expires_in'];
      const ttlSec = typeof expiresIn === 'number' ? expiresIn : 900;
      cachedToken = token;
      expiresAt = Date.now() + Math.max(1, ttlSec * 1000 - skewMs);
      return token;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
