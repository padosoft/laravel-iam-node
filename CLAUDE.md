# CLAUDE.md — @padosoft/laravel-iam-node

TypeScript/Node client SDK for the Laravel IAM control plane (PDP). Part of the
polyglot SDK family (`-node`, `-react-native`, `-rust`); see `20-polyglot-sdks.md`.

## The one rule: fail-closed

Every uncertainty resolves to **deny**, never allow. Network error, timeout,
5xx, 4xx, malformed body, unverifiable token ⇒ deny. There is **no fail-open
opt-out**. Each error path has a dedicated test. If you touch `check()`,
`listResources()`, `verifyToken()`, or the middleware, keep this invariant and
add/adjust a test that proves the failure denies.

## Contract (do not drift)

- Decision: `POST {baseUrl}/decisions/check`, `Authorization: Bearer`, body
  `{ subject:{type,id}, permission, organization, application, resource, context,
  current_aal, explain }`. This mirrors the PHP client's `DecisionRequest::toArray()`
  and `HttpDecider`. The server wraps success in `{ "data": { … } }` — we unwrap it.
- No PDP logic here: the verdict is always the server's.
- Cache is opt-in, off by default, never deny→allow, flush on `policy_version` bump,
  never caches transport errors, never caches `explain`.
- `verifyToken` = ES256 + `iss`/`aud`/`exp`/`nbf` via JWKS (`/.well-known/jwks.json`).

## Layout

- `src/client.ts` — `IamClient` (HTTP, cache wiring, JWKS/verifyToken).
- `src/decision.ts` — response normalisation, `deny()`, `isGranted()`.
- `src/cache.ts` — short-TTL decision cache + stable cache key.
- `src/middleware.ts` — `requirePermission` (Express/Fastify), exported at `/middleware`.
- `src/types.ts` — wire + config types.
- `test/` — vitest; `helpers.ts` provides `mockFetch` and an ES256 signing kit.

## Commands

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint
npm test            # vitest run
npm run build       # tsup → ESM + CJS + d.ts
```

CI matrix: Node 18 / 20 / 22.

## Conventions

- Strict TS, no `any`. `consistent-type-imports`. ESM source (`.js` import specifiers).
- Zero heavy deps: native `fetch`, `jose` for JWKS only.
- Do NOT publish to npm or tag releases from automation — the maintainer does that.
