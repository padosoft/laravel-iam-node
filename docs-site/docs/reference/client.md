---
title: "IamClient API"
description: "Complete reference for IamClient: constructor config, check, can, listResources, verifyToken — signatures, behaviour, defaults, and fail-closed guarantees."
---

`IamClient` is the SDK's single entry point. Construct one per IAM server you talk to and reuse it (it caches JWKS and, optionally, decisions).

```ts
import { IamClient } from '@padosoft/laravel-iam-node';
```

## `new IamClient(config)`

Throws synchronously if `baseUrl` is missing, or if no `fetch` is available and none is injected.

```ts
const iam = new IamClient({
  baseUrl: 'https://iam.example.com/api/iam/v1',
  token: process.env.IAM_SERVICE_TOKEN,
});
```

### Config (`IamClientConfig`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — **(required)** | Full API base incl. route prefix, e.g. `…/api/iam/v1`. Trailing slashes are trimmed. |
| `token` | `string` | — | Service token (OAuth2 Client Credentials), sent as `Authorization: Bearer` on PDP calls. |
| `timeoutMs` | `number` | `2000` | Per-request timeout, enforced via `AbortController`. |
| `retries` | `number` | `0` | Retries for **idempotent network errors only** (never on 4xx/5xx). Clamped to `>= 0`. |
| `cache` | `CacheOptions` | off | `{ ttlMs, maxEntries? }` opt-in decision cache. `ttlMs <= 0` disables. |
| `verify` | `VerifyOptions` | `{}` | Defaults for `verifyToken` (`issuer`, `audience`, `jwksUri`). |
| `fetch` | `typeof fetch` | global | Inject a custom `fetch` (tests, proxies). Used for both decisions and JWKS. |
| `checkPath` | `string` | `decisions/check` | Path appended to `baseUrl` for the PDP check. Slashes trimmed. |
| `listResourcesPath` | `string` | `decisions/list-resources` | Path for ReBAC list-resources. |

JWKS are refetched at most every **10 minutes** (plus a one-shot refetch on a key-rotation miss). This is not configurable.

## `check(query): Promise<Decision>`

`POST {baseUrl}/{checkPath}`. Returns a normalised [`Decision`](/reference/types#decision). **Never throws** — every error path resolves to a deny.

```ts
const decision = await iam.check({
  subject: { type: 'user', id: 'usr_123' },
  application: 'warehouse',
  permission: 'stock.adjust',
  resource: { type: 'warehouse', id: 'wh_milan' },
  context: { amount: 300 },
  currentAal: 'aal1',
  explain: false,
});
```

**Behaviour:**

- A query with no `subject.id` returns `deny('no-subject')` without any network call.
- Serialises to the canonical wire body (see [Wire contract](/architecture/wire-contract)).
- With caching on and `explain !== true`, returns a fresh cache hit; otherwise calls the PDP and caches the verdict.
- Any transport error / non-2xx / unparseable body returns `deny('transport')` — **not cached**.
- Unwraps a single `{ data }` envelope and normalises with safe defaults.

See [Checking permissions](/guides/checking-permissions).

## `can(query): Promise<boolean>`

`check()` reduced to the fail-safe boolean — `true` **only** when `allowed && !requiresStepUp`. Never throws.

```ts
if (!(await iam.can(query))) return res.status(403).end();
```

Equivalent to `isGranted(await iam.check(query))`. This is the method to gate on. See [Step-up & AAL](/concepts/step-up-aal).

## `listResources(subject, relation): Promise<Resource[]>`

`POST {baseUrl}/{listResourcesPath}`. ReBAC reverse query — the resources on which `subject` has `relation`. Fail-closed: returns `[]` on any error.

```ts
const warehouses = await iam.listResources({ id: 'usr_123' }, 'manage');
// → [{ type: 'warehouse', id: 'wh_milan' }, …]
```

| Param | Type | Notes |
| --- | --- | --- |
| `subject` | `{ type?: string; id: string }` | `type` defaults to `user`. Missing `id` ⇒ `[]`. |
| `relation` | `string` | Empty ⇒ `[]`. |

Returns only entries shaped `{ type: string, id: string }`; everything else is filtered out. An empty array can mean "no relationships" **or** an error — never treat it as a positive assertion. See [ReBAC list-resources](/guides/list-resources).

## `verifyToken(jwt, options?): Promise<Claims>`

Verifies a JWT's **ES256** signature and `iss` / `aud` / `exp` / `nbf` against the server JWKS. Resolves to the verified [`Claims`](/reference/types#claims), or **rejects** with [`TokenVerificationError`](/reference/errors). A rejection is the fail-closed signal — treat it as deny.

```ts
const claims = await iam.verifyToken(bearer, { audience: 'warehouse' });
```

### Options (`VerifyOptions`)

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `audience` | `string \| string[]` | — **(required)** | Expected `aud`. **Absent ⇒ rejects** (no accept-any). |
| `issuer` | `string` | `baseUrl` origin | Expected `iss`. |
| `jwksUri` | `string` | `<origin>/.well-known/jwks.json` | Keys live at the server root, not the API prefix. |

Options merge over the client's `verify` defaults. **Rejects when:** the token is empty; no audience is resolvable; the signature/claims fail; the JWKS is unreachable or malformed. On a no-matching-key error it refetches the JWKS once (rotation) and retries before rejecting. See [Token verification theory](/concepts/token-verification).

::: callout danger "Audience is mandatory"
Without an `audience` (from `options` or the client default), `verifyToken` rejects with `audience is required: …`. This closes the confused-deputy hole where `jose` would otherwise skip the `aud` check.
:::

## Exported helpers

`index.ts` also exports the pure decision helpers, useful when you hold a `Decision` directly:

| Export | Signature | Use |
| --- | --- | --- |
| `isGranted` | `(d: Decision) => boolean` | `d.allowed && !d.requiresStepUp` — the granted reduction. |
| `deny` | `(reason: string) => Decision` | Build an explicit deny (e.g. in custom guards). |
| `decisionFromBody` | `(body: unknown) => Decision` | Normalise a raw PDP body yourself (advanced). |

## Next steps

- [Middleware API](/reference/middleware) — `requirePermission`.
- [Types](/reference/types) — every interface.
- [Errors](/reference/errors) — `TokenVerificationError`.
