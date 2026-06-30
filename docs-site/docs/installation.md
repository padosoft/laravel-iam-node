---
title: "Installation"
description: "Prerequisites, install, module formats (ESM/CJS), configuring the client against your IAM server, and the service-token / fetch requirements."
---

## Prerequisites

| Requirement | Why |
| --- | --- |
| **Node 18+** | The SDK uses the global `fetch` (undici) for all HTTP. On older Node you must inject a `fetch` implementation via `config.fetch`. |
| **A running Laravel IAM server** | This is a thin client: it asks the server's PDP for every decision and fetches its JWKS to verify tokens. Nothing is decided locally. |
| **A service token** | An OAuth2 Client Credentials token for `decisions/check`, sent as `Authorization: Bearer`. Token verification (`verifyToken`) needs no token — it only reads the public JWKS. |

## Install

```bash
npm install @padosoft/laravel-iam-node
```

The only runtime dependency is [`jose`](https://github.com/panva/jose) (`^5.9.6`) for JWKS verification. There are no transitive HTTP libraries — transport is native `fetch`.

## Module formats

The package ships **ESM**, **CommonJS** and **TypeScript declarations**, with a dedicated `./middleware` subpath:

::: tabs
== tab "ESM / TypeScript"
```ts
import { IamClient } from '@padosoft/laravel-iam-node';
import { requirePermission } from '@padosoft/laravel-iam-node/middleware';
```
== tab "CommonJS"
```js
const { IamClient } = require('@padosoft/laravel-iam-node');
const { requirePermission } = require('@padosoft/laravel-iam-node/middleware');
```
:::

`"sideEffects": false` and a clean ESM build mean tree-shaking works: importing only `verifyToken`'s path won't pull in the middleware.

## Configuring the client

The minimum is a `baseUrl`. Everything else has a safe default.

```ts
import { IamClient } from '@padosoft/laravel-iam-node';

const iam = new IamClient({
  baseUrl: 'https://iam.example.com/api/iam/v1', // REQUIRED — full API base incl. route prefix
  token: process.env.IAM_SERVICE_TOKEN,          // Bearer for PDP calls
  timeoutMs: 2000,                               // per-request timeout (default 2000)
  retries: 0,                                    // idempotent network errors only (default 0)
  cache: { ttlMs: 5000 },                        // opt-in decision cache (OFF by default)
  verify: { audience: 'warehouse' },             // verifyToken defaults
});
```

::: callout warning "`baseUrl` includes the route prefix; JWKS does not"
`baseUrl` is the full API base, e.g. `…/api/iam/v1` — PDP calls are `POST {baseUrl}/decisions/check`. The JWKS URL, by contrast, is derived from the **origin**: `https://iam.example.com/.well-known/jwks.json`. Keys live at the server root, not under the API prefix. Override with `verify.jwksUri` if your deployment differs.
:::

A missing `baseUrl` throws at construction time (`IamClient: \`baseUrl\` is required`). A missing global `fetch` with no injected `fetch` also throws — upgrade Node or pass one.

## Pointing at a non-standard server

Two escape hatches exist for forward compatibility; you rarely need them:

| Option | Default | Use when |
| --- | --- | --- |
| `checkPath` | `decisions/check` | The PDP check route moved. |
| `listResourcesPath` | `decisions/list-resources` | The ReBAC list-resources route moved. |

Both are trimmed of leading/trailing slashes and appended to `baseUrl`.

## Injecting a custom `fetch`

For tests, proxies, mTLS agents, or Node < 18:

```ts
import { fetch as undiciFetch } from 'undici';

const iam = new IamClient({
  baseUrl: 'https://iam.example.com/api/iam/v1',
  fetch: undiciFetch, // used for BOTH decisions and JWKS fetches
});
```

The injected `fetch` is honoured everywhere, including JWKS retrieval, which is what makes the client fully testable without a network.

## Verify the install

```ts
const iam = new IamClient({ baseUrl: 'https://iam.example.com/api/iam/v1' });

// With no server reachable, check() must fail closed — never throw, never allow:
const d = await iam.check({ subject: { id: 'usr_1' }, permission: 'ping' });
console.log(d.allowed); // false
```

If that prints `false` against an unreachable host, the fail-closed path is wired correctly.

## Next steps

- [Quickstart](/quickstart) — a gated route end to end.
- [Core concepts](/core-concepts) — the model behind the API.
- [IamClient API](/reference/client) — every option and method.
