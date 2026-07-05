import { randomUUID } from 'node:crypto';

/**
 * Manifest tooling for the Node SDK — the cross-language equivalent of the Laravel client's
 * `iam:manifest:push`. Apps that own a permission catalog **declare** it in a manifest (a versioned file);
 * `validateManifest` checks it locally (mirrors the server's rules + the published JSON Schema at
 * `/.well-known/iam-manifest-schema.json`), and `submitManifest` pushes it to IAM's Admin API for diff + apply.
 */

const KEY_RE = /^[a-z][a-z0-9_.-]*$/;
const RISK = ['low', 'medium', 'high', 'critical'];

export interface ManifestValidation {
  valid: boolean;
  errors: string[];
}

/** Validate a manifest object against the laravel-iam.manifest.v2 rules. Pure, no network. */
export function validateManifest(manifest: unknown): ManifestValidation {
  const errors: string[] = [];
  if (manifest === null || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be an object'] };
  }
  const m = manifest as Record<string, unknown>;

  if (m.schema !== 'laravel-iam.manifest.v2') {
    errors.push('schema must be "laravel-iam.manifest.v2"');
  }

  const app = (typeof m.app === 'object' && m.app !== null ? m.app : {}) as Record<string, unknown>;
  if (typeof app.key !== 'string' || !KEY_RE.test(app.key)) {
    errors.push('app.key missing or malformed (slug [a-z][a-z0-9_.-]*)');
  }
  if (typeof app.name !== 'string' || app.name === '') {
    errors.push('app.name required');
  }
  if (app.risk_level !== undefined && !RISK.includes(app.risk_level as string)) {
    errors.push('app.risk_level invalid (low|medium|high|critical)');
  }

  const permKeys = new Set<string>();
  const perms = Array.isArray(m.permissions) ? m.permissions : [];
  perms.forEach((raw, i) => {
    const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) {
      errors.push(`permissions[${i}].key missing or malformed`);
      return;
    }
    if (permKeys.has(p.key)) errors.push(`permissions: duplicate key "${p.key}"`);
    permKeys.add(p.key);
    if (p.risk !== undefined && !RISK.includes(p.risk as string)) {
      errors.push(`permissions["${p.key}"].risk invalid`);
    }
  });

  const roles = Array.isArray(m.roles) ? m.roles : [];
  roles.forEach((raw, i) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof r.key !== 'string' || !KEY_RE.test(r.key)) {
      errors.push(`roles[${i}].key missing or malformed`);
    }
    const refs = Array.isArray(r.permissions) ? r.permissions : [];
    refs.forEach((ref) => {
      if (typeof ref !== 'string' || !permKeys.has(ref)) {
        errors.push(`roles["${String(r.key)}"] references an undeclared permission: ${String(ref)}`);
      }
    });
  });

  return { valid: errors.length === 0, errors };
}

export interface SubmitManifestOptions {
  /** Admin API base, e.g. https://your-iam.example.com/api/iam/v1 */
  baseUrl: string;
  /** Bearer token with iam:manifests.submit (this service's own token). */
  token: string;
  /** Defaults to the manifest's app.key. */
  appKey?: string;
  fetch?: typeof fetch;
}

export interface SubmitManifestResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

/**
 * Push a manifest to IAM's Admin API (POST /applications/{app}/manifests). Validates locally first, then
 * submits with the bearer + an Idempotency-Key. IAM diffs it: additive changes apply, a removal is gated for
 * approval and the removed role/permission is deprecated (kept, disabled), never deleted.
 */
export async function submitManifest(
  manifest: Record<string, unknown>,
  opts: SubmitManifestOptions,
): Promise<SubmitManifestResult> {
  const appBlock = (typeof manifest.app === 'object' && manifest.app !== null ? manifest.app : {}) as Record<string, unknown>;
  const app = opts.appKey ?? (typeof appBlock.key === 'string' ? appBlock.key : undefined);
  if (typeof app !== 'string' || app === '') {
    return { ok: false, status: 0, error: 'no app key (pass appKey or set manifest.app.key)' };
  }

  const local = validateManifest(manifest);
  if (!local.valid) {
    return { ok: false, status: 0, error: local.errors.join('; ') };
  }

  const base = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${base}/applications/${encodeURIComponent(app)}/manifests`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ manifest }),
  });

  let data: unknown;
  try {
    const body = (await response.json()) as { data?: unknown };
    data = body && typeof body === 'object' && 'data' in body ? body.data : body;
  } catch {
    /* empty/unparseable body */
  }

  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, error: `HTTP ${response.status}`, data };
  }
  return { ok: true, status: response.status, data };
}
