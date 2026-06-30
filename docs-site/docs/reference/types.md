---
title: "Types"
description: "Every exported TypeScript interface: Subject, Resource, DecisionContext, DecisionQuery, DecisionMatch, Decision, Claims, CacheOptions, VerifyOptions, IamClientConfig."
---

All types are exported from the package root:

```ts
import type {
  Subject, Resource, DecisionContext, DecisionQuery,
  DecisionMatch, Decision, Claims, CacheOptions,
  VerifyOptions, IamClientConfig,
} from '@padosoft/laravel-iam-node';
```

These mirror the canonical decision contract and the PHP client's DTOs byte-for-byte (see [Wire contract](/architecture/wire-contract)).

## `Subject`

Whoever the decision is about — user, service account, group, agent.

```ts
interface Subject {
  type?: string; // defaults to 'user' server-side when omitted
  id: string;    // stable identifier, e.g. 'usr_123'. Required.
}
```

## `Resource`

The object an action targets.

```ts
interface Resource {
  type: string;
  id: string;
}
```

## `DecisionContext`

Free-form ABAC facts evaluated by policy conditions (amount, time, ip…).

```ts
type DecisionContext = Record<string, unknown>;
```

## `DecisionQuery`

Input to `check()` / `can()`.

```ts
interface DecisionQuery {
  subject: Subject;
  permission: string;
  organization?: string | null;
  application?: string | null;
  resource?: Resource | string | null;
  context?: DecisionContext;
  currentAal?: string; // caller's assurance level; default 'aal1'
  explain?: boolean;   // ask for reasoning; explain queries are never cached
}
```

Only `subject.id` and `permission` are required; the rest serialise with safe defaults. `currentAal` is sent on the wire as snake-case `current_aal`.

## `DecisionMatch`

One policy element the PDP matched while deciding.

```ts
interface DecisionMatch {
  type?: string;
  key?: string;
  [k: string]: unknown;
}
```

## `Decision`

Normalised result of `check()`. `allowed` alone is **not** permission — use `isGranted` / `can`.

```ts
interface Decision {
  allowed: boolean;
  decisionId: string;
  policyVersion: number;
  requiresStepUp: boolean;
  requiredAal: string | null;
  matched: DecisionMatch[];
  explanation: string[];
}
```

See [The decision model](/concepts/decision-model) for field-by-field normalisation and safe defaults.

## `Claims`

Verified JWT claims returned by `verifyToken`.

```ts
interface Claims {
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
  [k: string]: unknown;
}
```

Trust these values only **after** `verifyToken` resolves.

## `CacheOptions`

Opt-in short-TTL decision cache. Off by default.

```ts
interface CacheOptions {
  ttlMs: number;       // <= 0 disables caching
  maxEntries?: number; // LRU-ish eviction cap; default 1000
}
```

See [Caching decisions](/guides/caching).

## `VerifyOptions`

Token-verification settings (client default `verify` and/or per-call `options`).

```ts
interface VerifyOptions {
  issuer?: string;             // default: baseUrl origin
  audience?: string | string[];// REQUIRED at call time (absent ⇒ reject)
  jwksUri?: string;            // default: <origin>/.well-known/jwks.json
}
```

::: callout danger "Audience is effectively required"
Although `audience` is optional in the type (so it can come from either the client default or the call), `verifyToken` rejects if neither supplies one. See [Token verification theory](/concepts/token-verification).
:::

## `IamClientConfig`

Constructor configuration.

```ts
interface IamClientConfig {
  baseUrl: string;               // REQUIRED — full API base incl. route prefix
  token?: string;                // Bearer for PDP calls
  timeoutMs?: number;            // default 2000
  retries?: number;              // idempotent network errors only; default 0
  cache?: CacheOptions;          // off by default
  verify?: VerifyOptions;        // verifyToken defaults
  fetch?: typeof fetch;          // inject for tests/proxies; default global fetch
  checkPath?: string;            // default 'decisions/check'
  listResourcesPath?: string;    // default 'decisions/list-resources'
}
```

Full semantics in the [IamClient API](/reference/client).

## Next steps

- [IamClient API](/reference/client) — methods that consume these types.
- [Errors](/reference/errors) — `TokenVerificationError`.
- [Wire contract](/architecture/wire-contract) — how these map to the wire.
