/**
 * Bearer resolution for the Admin API (mirrors the PHP client's TokenProvider). Two modes:
 * a static token supplied by the app, or self-managed `client_credentials` that mints/refreshes the token
 * and — when IAM auto-rotates the client secret — self-fetches the new one during the grace and hot-swaps.
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
