---
title: "Errors"
description: "The SDK's error surface: TokenVerificationError (the only thrown type) — its shape, when it's thrown, the reason field, and how check/can/listResources signal failure without throwing."
---

The SDK has a deliberately small error surface. Only **one** method throws, and it throws exactly one type.

## The throwing/non-throwing split

| Method | On failure |
| --- | --- |
| `check` | returns a deny `Decision` (never throws) |
| `can` | returns `false` (never throws) |
| `listResources` | returns `[]` (never throws) |
| `verifyToken` | **rejects** with `TokenVerificationError` |

`check` / `can` / `listResources` fold every failure into a safe return value — there is no exception to mishandle, so you can't accidentally fail open. `verifyToken` is the exception because a token has no safe fallback "value": the only correct signal for "this token can't be trusted" is to reject. See [ADR-2](/architecture/decisions#adr-2-check-never-throws-failures-are-values).

## `TokenVerificationError`

Thrown by `verifyToken` when a token cannot be trusted.

```ts
import { TokenVerificationError } from '@padosoft/laravel-iam-node';

class TokenVerificationError extends Error {
  readonly name = 'TokenVerificationError';
  readonly reason: string; // short machine-readable reason
  constructor(reason: string, options?: { cause?: unknown });
}
```

- `message` is `token verification failed: <reason>`.
- `reason` is the short cause, e.g. `empty token`, `audience is required: …`, a `jose` failure message, or `jwks: <detail>`.
- `cause` (when present) is the underlying error — a `jose` exception or a fetch/JWKS error — useful for logging.

## When it's thrown

| Situation | `reason` (illustrative) |
| --- | --- |
| Empty or non-string token | `empty token` |
| No audience configured or passed | `audience is required: set \`verify.audience\` …` |
| JWKS unreachable / non-2xx / malformed | `jwks: <detail>` |
| Bad signature, wrong `iss`/`aud`, expired/`nbf` | the underlying `jose` message |

On a no-matching-key error (likely key rotation) the SDK refetches the JWKS **once** and retries before giving up — so a transient rotation doesn't surface as an error. Any other failure rejects immediately.

## Handling it

Treat **any** rejection as a hard deny. Don't decode the unverified payload as a fallback.

```ts
try {
  const claims = await iam.verifyToken(bearer, { audience: 'warehouse' });
  // proceed only here — claims are trustworthy
} catch (err) {
  if (err instanceof TokenVerificationError) {
    logger.warn('token rejected', { reason: err.reason, cause: err.cause });
  }
  return res.status(401).end(); // fail-closed
}
```

::: callout warning "Don't catch-and-continue"
A `catch` that logs and proceeds anyway lets unauthenticated requests through. Every `TokenVerificationError` must end in a 401/deny. See [Fail-closed discipline](/best-practices/fail-closed-discipline).
:::

## Observing deny reasons (without branching on them)

The non-throwing methods leave a breadcrumb in the `Decision`. A synthetic deny carries a short reason in `explanation`:

| Reason in `explanation` | Cause |
| --- | --- |
| `no-subject` | the query had no `subject.id` |
| `transport` | network error / timeout / non-2xx / unparseable body |
| `invalid body` | the response wasn't a JSON object |
| `check-threw` | the middleware's `check()` call threw (e.g. circular `context`) |

Read these for **logging and metrics** only. Never branch authorization on them — "denied" and "couldn't reach the PDP" must remain indistinguishable to your access logic. See [Fail-closed by design](/concepts/fail-closed).

## Construction-time errors

The `IamClient` constructor throws plain `Error`s for misconfiguration, before any request:

- `IamClient: \`baseUrl\` is required` — no `baseUrl` given.
- `IamClient: no \`fetch\` available. Use Node 18+ or pass \`fetch\` in the config.` — no global `fetch` and none injected.

These are programmer errors surfaced early, not runtime authorization failures.

## Next steps

- [Verifying tokens (JWKS)](/guides/verifying-tokens) — the happy path.
- [IamClient API](/reference/client) — method-level behaviour.
- [Fail-closed by design](/concepts/fail-closed) — why the split exists.
