---
title: "Quickstart"
description: "From npm install to a fail-closed, PDP-gated Express route in about five minutes — construct the client, ask a decision, gate a handler, verify a token."
---

This walks you from install to a route gated on a Policy Decision Point, with the fail-closed guarantees intact. For the full prerequisite matrix and configuration, see [Installation](/installation).

::: callout info
`@padosoft/laravel-iam-node` is a thin client. It needs a running **Laravel IAM server** to talk to (the PDP) and a **service token** (OAuth2 Client Credentials) to authenticate with. The SDK itself decides nothing — it asks the server and fails closed on uncertainty.
:::

::: steps

1. **Install the package**
   ```bash
   npm install @padosoft/laravel-iam-node
   ```
   Requires **Node 18+** for native `fetch`. The only runtime dependency is [`jose`](https://github.com/panva/jose) (JWKS verification). ESM, CommonJS and TypeScript types all ship in the box.

2. **Construct the client**
   The `baseUrl` is the **full API base including the route prefix** — identical to the PHP client's `iam-client.http.base_url`. The `token` is sent as `Authorization: Bearer` on every PDP call.

   ```ts
   import { IamClient } from '@padosoft/laravel-iam-node';

   export const iam = new IamClient({
     baseUrl: 'https://iam.example.com/api/iam/v1',
     token: process.env.IAM_SERVICE_TOKEN,
     timeoutMs: 2000,                 // per-request budget; default 2000
     verify: { audience: 'warehouse' }, // default audience for verifyToken (see step 5)
   });
   ```

   ::: callout tip
   `baseUrl` must include the `/api/iam/v1` prefix. The JWKS endpoint is derived from the **origin**, not the prefix (`https://iam.example.com/.well-known/jwks.json`), because keys live at the server root.
   :::

3. **Ask the PDP for a decision**
   `check()` returns a normalised `Decision`. It **never throws** — every error path resolves to a deny.

   ```ts
   const decision = await iam.check({
     subject: { type: 'user', id: 'usr_123' },
     application: 'warehouse',
     permission: 'stock.adjust',
     resource: { type: 'warehouse', id: 'wh_milan' },
     context: { amount: 300 },
   });

   if (!decision.allowed) {
     // denied, or transport failure, or malformed response — all look the same here
   }
   if (decision.requiresStepUp) {
     // allowed only at a higher AAL — NOT yet permitted
   }
   ```

   ::: callout warning
   `decision.allowed === true` alone is **not** permission. When `requiresStepUp` is `true` the action needs a higher assurance level. Prefer `iam.can()` (next step), which folds both conditions into one safe boolean.
   :::

4. **Reduce to a fail-safe boolean and gate a handler**
   `can()` returns `true` **only** when the PDP allowed **and** no step-up is pending:

   ```ts
   import { iam } from './iam';

   app.post('/warehouses/:id/stock', async (req, res) => {
     const granted = await iam.can({
       subject: { type: 'user', id: req.user.id },
       application: 'warehouse',
       permission: 'stock.adjust',
       resource: { type: 'warehouse', id: req.params.id },
       context: { amount: req.body.amount },
     });

     if (!granted) return res.status(403).end(); // fail-closed
     // …perform the stock adjustment…
   });
   ```

   Or let the middleware do it for you — a missing subject, an unreachable PDP, or a pending step-up all respond **403** and never call `next()`:

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

5. **Verify an incoming token (authentication)**
   `verifyToken()` checks an access/ID token's ES256 signature and `iss`/`aud`/`exp`/`nbf` against the server JWKS. It **rejects** on any problem — treat a rejection as deny.

   ```ts
   try {
     const claims = await iam.verifyToken(bearer, { audience: 'warehouse' });
     // trust claims.sub / claims.org / claims.scope
   } catch {
     return res.status(401).end(); // fail-closed
   }
   ```

   ::: callout danger "Audience is mandatory"
   `verifyToken` **rejects** if no `audience` is supplied (via `verify.audience` on the client or `options.audience` here). This is deliberate: `jose` silently skips the `aud` check when none is given, so a token minted for another service in the same cluster would otherwise verify. See [Token verification theory](/concepts/token-verification).
   :::

:::

## What just happened

1. You constructed an `IamClient` pointed at the PDP's full API base, with a service token.
2. `check()` serialised your query into the exact wire body the server expects (`current_aal` snake-case, all keys present, `subject.type` defaulted to `user`) and `POST`ed it to `/decisions/check` with a Bearer token.
3. The server's `Decision` (wrapped in a `{ data }` envelope) was unwrapped and normalised — missing or wrong-typed fields degrade safely (a missing `allowed` becomes `false`).
4. `can()` reduced the decision to `allowed && !requiresStepUp` — the only interpretation safe to gate on.
5. `verifyToken()` fetched and cached the JWKS, then verified signature + claims, requiring an explicit audience.

## Next steps

::: grids
  ::: grid
    ::: card "Core concepts" icon:workflow
    Subjects, decisions, AAL, the wire contract, the cache — the mental model behind the API.

    [Open →](/core-concepts)
    :::
  :::
  ::: grid
    ::: card "Express middleware" icon:route
    Wire `requirePermission` into an Express app, with subject/resource/context resolvers.

    [Open →](/guides/express)
    :::
  :::
  ::: grid
    ::: card "Fail-closed by design" icon:shield
    Why every error path funnels to deny, and the threat model it defends against.

    [Read →](/concepts/fail-closed)
    :::
  :::
:::
