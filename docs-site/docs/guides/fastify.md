---
title: "Fastify middleware"
description: "Use the same requirePermission middleware as a Fastify preHandler — why it works on both frameworks, reply.code/send detection, and an end-to-end example."
---

The same `requirePermission` function works on Fastify. It takes no hard dependency on either framework: it only needs a request, a response with `status()`/`code()` and `json()`/`send()`, and a `next`/`done` callback. That structural contract covers both Express and Fastify.

## Why one function fits both

Express middleware is `(req, res, next)`. A Fastify `preHandler` hook is `(request, reply, done)` (or an async function). `requirePermission` returns an `async (req, res, next)` that:

- reads the subject from `req.user` / `req.auth` (same shape both frameworks expose once you populate it),
- on grant, calls `next()` — which Fastify supplies as `done`,
- on deny, replies via `res.status(...).json(...)`, falling back to `reply.code(...).send(...)`.

The response shim tries, in order: `status()` then `code()` for the status, and `json()` then `send()` for the body. Fastify replies expose `code()` and `send()`; Express responses expose `status()` and `json()`. Both are satisfied.

## Usage as a preHandler

```ts
import Fastify from 'fastify';
import { IamClient } from '@padosoft/laravel-iam-node';
import { requirePermission } from '@padosoft/laravel-iam-node/middleware';

const iam = new IamClient({
  baseUrl: 'https://iam.example.com/api/iam/v1',
  token: process.env.IAM_SERVICE_TOKEN,
});

const app = Fastify();

app.post(
  '/warehouses/:id/stock',
  {
    preHandler: requirePermission(iam, 'stock.adjust', {
      resource: (req) => ({ type: 'warehouse', id: (req.params as any).id }),
      context: (req) => ({ amount: (req.body as any).amount }),
      application: 'warehouse',
    }),
  },
  async (req, reply) => {
    return { ok: true }; // reached only when granted
  },
);

await app.listen({ port: 3000 });
```

## Populating the subject

As on Express, the default subject comes from `req.user.id` (then `req.auth.sub`). With Fastify, decorate the request in an earlier hook — e.g. a JWT plugin or a custom `onRequest` hook that sets `request.user = { id, type }`. If you verify tokens with this SDK's `verifyToken`, set the subject from the verified claims:

```ts
app.addHook('onRequest', async (request) => {
  const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '');
  try {
    const claims = await iam.verifyToken(bearer, { audience: 'warehouse' });
    (request as any).user = { id: claims.sub, type: 'user' };
  } catch {
    // leave user unset → requirePermission denies with 403
  }
});
```

::: callout tip
Don't throw from the auth hook if you want the standard 403 deny body from `requirePermission`. Leaving `request.user` unset lets the middleware produce its own fail-closed 403. Throwing instead yields Fastify's default error response.
:::

## Deny behaviour

Identical to Express: a denial replies **403** with `{ error, required_aal, decision_id }` (or `step_up_required` when a step-up is pending) and does not invoke the handler. Override with `onDeny` for a custom reply:

```ts
requirePermission(iam, 'stock.adjust', {
  onDeny: (req, reply, decision) => {
    reply.code(decision.requiresStepUp ? 401 : 403).send({ id: decision.decisionId });
  },
});
```

## Next steps

- [Express middleware](/guides/express) — the same function, Express idioms.
- [Verifying tokens (JWKS)](/guides/verifying-tokens) — authenticate before you authorize.
- [Middleware API](/reference/middleware) — the full option reference.
