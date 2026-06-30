# @padosoft/laravel-iam-node

> Thin, **fail-closed** TypeScript/Node client for the [Laravel IAM](https://github.com/padosoft) control plane.

[![tests](https://github.com/padosoft/laravel-iam-node/actions/workflows/tests.yml/badge.svg)](https://github.com/padosoft/laravel-iam-node/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/@padosoft/laravel-iam-node.svg)](https://www.npmjs.com/package/@padosoft/laravel-iam-node)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Ask the IAM server *"is this subject allowed to do this?"* and verify its tokens — from any Node service, with the **exact same wire contract and guarantees as the PHP client**. No policy logic lives here: every decision is the server's.

## Why

Laravel IAM is an **Identity & Authorization control plane** (PDP) for multi-application ecosystems. Your non-PHP services still need to ask it for decisions. This SDK is the JavaScript core of that story:

- **Fail-closed by construction.** Any network error, timeout, 5xx, 4xx, malformed body, or unverifiable token resolves to **deny** — never allow. There is no fail-open switch. An unreachable PDP must never open the doors.
- **No PDP logic client-side.** The verdict always comes from the server's `decisions/check`. The client never interprets grants or policies.
- **Drop-in parity.** Same endpoint, payload, Bearer auth and response handling as the PHP `HttpDecider` — the server can't tell the callers apart.
- **Zero heavy deps.** Native `fetch` (Node 18+) and [`jose`](https://github.com/panva/jose) for JWKS verification. ESM + CJS + types.

## Install

```bash
npm install @padosoft/laravel-iam-node
```

> Requires Node 18+ (native `fetch`).

## Quick start

```ts
import { IamClient } from '@padosoft/laravel-iam-node';

const iam = new IamClient({
  baseUrl: 'https://iam.example.com/api/iam/v1', // full API base, incl. route prefix
  token: process.env.IAM_SERVICE_TOKEN,          // OAuth2 Client Credentials service token
  timeoutMs: 2000,
  cache: { ttlMs: 5000 },                        // optional, OFF by default
});

const decision = await iam.check({
  subject: { type: 'user', id: 'usr_123' },
  application: 'warehouse',
  permission: 'stock.adjust',
  resource: { type: 'warehouse', id: 'wh_milan' },
  context: { amount: 300 },
});

if (!decision.allowed) throw new Forbidden(decision);     // fail-closed
if (decision.requiresStepUp) promptStepUp(decision.requiredAal);
```

Prefer a single boolean? `iam.can(query)` returns `true` only when the PDP allowed **and** no step-up is pending:

```ts
if (!(await iam.can(query))) return res.status(403).end();
```

## Fail-closed: read this

`allowed === true` alone is **not** permission. When `requiresStepUp` is `true`, the action is only permitted at a higher AAL — treat it as *not yet allowed*. Use `iam.can()` / `isGranted()` for the fail-safe interpretation, and only inspect `requiresStepUp` when you intend to drive a step-up challenge.

The cache (opt-in, off by default) never turns a deny into an allow: it stores the server's verdict verbatim, expires on a short TTL, never caches transport errors, and **flushes the whole cache when the server reports a newer `policy_version`**. Correctness before latency.

## API

### `new IamClient(config)`

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | — (required) | Full API base, e.g. `https://iam.example.com/api/iam/v1`. |
| `token` | — | Service token sent as `Authorization: Bearer`. |
| `timeoutMs` | `2000` | Per-request timeout. |
| `retries` | `0` | Retries for **idempotent network errors only** (never on 4xx/5xx). |
| `cache` | off | `{ ttlMs, maxEntries? }` short-TTL decision cache. |
| `verify` | — | `{ issuer?, audience?, jwksUri? }` defaults for `verifyToken`. |
| `fetch` | global | Inject a custom `fetch` (tests, proxies). |

### `check(query): Promise<Decision>`

`POST {baseUrl}/decisions/check`. Returns a normalised `Decision` (`allowed`, `decisionId`, `policyVersion`, `requiresStepUp`, `requiredAal`, `matched[]`, `explanation[]`). Never throws.

### `can(query): Promise<boolean>`

`check()` reduced to the fail-safe boolean (allowed **and** not step-up-pending).

### `listResources(subject, relation): Promise<Resource[]>`

ReBAC list-resources (M16): the resources on which `subject` has `relation`. Fail-closed — returns `[]` on any error.

### `verifyToken(jwt, options?): Promise<Claims>`

Verifies an access/ID token's **ES256** signature and `iss` / `aud` / `exp` / `nbf` against the server JWKS (`/.well-known/jwks.json`). Resolves to the verified claims, or **rejects** with `TokenVerificationError` (the fail-closed signal — treat a rejection as deny). JWKS are cached and refetched on key rotation.

```ts
try {
  const claims = await iam.verifyToken(bearer, { audience: 'warehouse' });
  // trust claims.sub / claims.org / claims.scope
} catch {
  return res.status(401).end(); // fail-closed
}
```

## Middleware (Express / Fastify)

```ts
import { requirePermission } from '@padosoft/laravel-iam-node/middleware';

app.post(
  '/warehouses/:id/stock',
  requirePermission(iam, 'stock.adjust', {
    resource: (req) => ({ type: 'warehouse', id: req.params.id }),
    context: (req) => ({ amount: req.body.amount }),
  }),
  stockHandler,
);
```

The subject defaults to `req.user.id` / `req.auth.sub`. A missing subject, an unreachable PDP, or a pending step-up all respond **403** (fail-closed) and never call `next()`.

## Endpoint contract

This SDK speaks the canonical decision contract (`01-architecture.md` §12), mirroring the PHP client:

- **Endpoint:** `POST {baseUrl}/decisions/check`
- **Auth:** `Authorization: Bearer <service token>`, `Accept: application/json`
- **Body:** `{ subject:{type,id}, permission, organization, application, resource, context, current_aal, explain }`
- **Response:** the server's `Decision` (a `{ "data": { … } }` envelope is unwrapped transparently)

## License

MIT © [Padosoft](https://www.padosoft.com)
