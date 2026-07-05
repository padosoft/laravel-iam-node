# @padosoft/laravel-iam-node

> Thin, **fail-closed** TypeScript/Node client for the [Laravel IAM](https://github.com/padosoft) control plane.

[![tests](https://github.com/padosoft/laravel-iam-node/actions/workflows/tests.yml/badge.svg)](https://github.com/padosoft/laravel-iam-node/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/@padosoft/laravel-iam-node.svg)](https://www.npmjs.com/package/@padosoft/laravel-iam-node)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![docs](https://img.shields.io/badge/docs-doc.laravel--iam--node.padosoft.com-0d9488.svg)](https://doc.laravel-iam-node.padosoft.com)

Ask the IAM server *"is this subject allowed to do this?"* and verify its tokens — from any Node service, with the **exact same wire contract and guarantees as the PHP client**. No policy logic lives here: every decision is the server's.

📚 **Full documentation:** **[doc.laravel-iam-node.padosoft.com](https://doc.laravel-iam-node.padosoft.com)** — theory of fail-closed, decision-flow & token-verification diagrams, ADRs, Express/Fastify quickstarts, and the complete API reference.

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
| `token` | — | Static service token sent as `Authorization: Bearer`. |
| `clientId` + `privateKey` (+ `privateKeyKid`) | — | **`private_key_jwt` (RFC 7523)** — asymmetric, no shared secret. `privateKey` is an ES256 PKCS#8 PEM; the client signs a short-lived assertion per token request. **Highest precedence.** Register the matching public key (JWKS) in IAM. |
| `clientId` + `clientSecret` | — | **Self-managed `client_credentials`**: the client mints/refreshes the token itself and **auto-follows IAM's client-secret rotation** (self-fetch), so a long-running service never breaks on a rotation and you never handle a secret by hand. Takes precedence over `token`. |
| `oauthUrl` | `<origin>/oauth` | OAuth base for the token + self-fetch endpoints. |
| `timeoutMs` | `2000` | Per-request timeout. |
| `retries` | `0` | Retries for **idempotent network errors only** (never on 4xx/5xx). |
| `cache` | off | `{ ttlMs, maxEntries? }` short-TTL decision cache. |
| `verify` | — | `{ issuer?, audience?, jwksUri? }` defaults for `verifyToken`. |
| `fetch` | global | Inject a custom `fetch` (tests, proxies). |

**Auto-rotating credentials** (recommended for long-lived services): pass `clientId` + `clientSecret`
instead of a static `token`. The client obtains an access token via `client_credentials` and, when IAM
auto-rotates the secret, self-fetches the new one from `POST /oauth/client-secret` (authenticating with the
still-valid secret during the grace) and hot-swaps it — zero downtime. Enable the endpoint server-side with
`IAM_OAUTH_CLIENT_SELFFETCH=true`. See
[Application credentials & lifecycle](https://doc.laravel-iam-server.padosoft.com/guides/application-credentials).

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

### `validateManifest(manifest)` / `submitManifest(manifest, opts)`

A node service that owns a permission catalog **declares** it in a manifest (a versioned file — it *is* your
source of truth) and pushes it to IAM. `validateManifest` checks it locally against the
`laravel-iam.manifest.v2` rules (mirrors the server + the published schema at
`/.well-known/iam-manifest-schema.json`); `submitManifest` POSTs it to the Admin API.

```ts
import { validateManifest, submitManifest } from '@padosoft/laravel-iam-node';

const manifest = JSON.parse(await readFile('iam.manifest.json', 'utf8'));

const { valid, errors } = validateManifest(manifest);
if (!valid) throw new Error(errors.join('; '));

const res = await submitManifest(manifest, {
  baseUrl: 'https://your-iam.example.com/api/iam/v1',
  token: process.env.IAM_TOKEN!, // needs iam:manifests.submit
});
// res.ok / res.status / res.data — IAM diffs it: additive changes apply, a removal is gated for approval
// and the removed role/permission is DEPRECATED (kept, disabled), never deleted.
```

Run it in CI on deploy for hands-off sync. See
[Keeping IAM in sync](https://doc.laravel-iam-server.padosoft.com/guides/keeping-in-sync).

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

## Ecosystem

This SDK is one client in the **Laravel IAM** family — a server (the PDP) plus a polyglot fleet of thin, fail-closed clients sharing one wire contract and one audit trail:

- **[laravel-iam-server](https://doc.laravel-iam-server.padosoft.com)** — the IAM server: identity, org, Application Registry, PDP (RBAC + ABAC + ReBAC), OAuth/OIDC, tamper-evident audit, Admin API + panel.
- **[laravel-iam-contracts](https://doc.laravel-iam-contracts.padosoft.com)** — shared contracts/interfaces + DTOs.
- **[laravel-iam-client](https://doc.laravel-iam-client.padosoft.com)** — the Laravel client for consumer apps (OIDC login, JWKS verify, `iam.auth`/`iam.can` middleware).
- **[laravel-iam-react-native](https://doc.laravel-iam-react-native.padosoft.com)** — React Native client SDK (thin + hooks).
- **[laravel-iam-rust](https://doc.laravel-iam-rust.padosoft.com)** — Rust client SDK (async + blocking, fail-closed).

## Documentation

Full docs — fail-closed theory, mermaid decision/token-verification diagrams, ADRs, Express & Fastify quickstarts, and a complete API reference — live at **[doc.laravel-iam-node.padosoft.com](https://doc.laravel-iam-node.padosoft.com)**.

## License

MIT © [Padosoft](https://www.padosoft.com) · [npm](https://www.npmjs.com/package/@padosoft/laravel-iam-node)
