import type { Decision } from './types.js';

interface Entry {
  decision: Decision;
  expiresAt: number;
}

/**
 * Tiny in-memory TTL cache for decisions. Opt-in and off by default (see
 * `20-polyglot-sdks.md` §2/§6): the cache MUST NEVER turn a deny into an allow,
 * so we only ever store the server's verdict verbatim and invalidate the whole
 * cache when the server reports a newer `policy_version`. The key is a stable
 * hash of the full query (mirrors `DecisionRequest::cacheKey()`), so two
 * different queries can never share a verdict.
 */
export class DecisionCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, Entry>();
  private policyVersion = 0;

  constructor(ttlMs: number, maxEntries = 1000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries > 0 ? maxEntries : 1000;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): Decision | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.decision;
  }

  set(key: string, decision: Decision): void {
    if (!this.enabled) return;

    // Policy changed on the server → everything we cached is stale. Drop it all.
    if (decision.policyVersion > this.policyVersion) {
      this.policyVersion = decision.policyVersion;
      this.store.clear();
    }

    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }

    this.store.set(key, { decision, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Stable cache key: a SHA-256 over every input that can change the verdict.
 * Order-independent for object keys via recursive canonicalisation.
 */
export async function cacheKey(parts: unknown): Promise<string> {
  const json = canonicalJson(parts);
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
