---
title: "Architecture decisions (ADR)"
description: "The load-bearing decisions behind the SDK and their trade-offs: thin client, never-throw, fail-closed sink, mandatory audience, ES256 pinning, opt-in cache that can't grant, PHP parity, and framework-agnostic middleware."
---

These are the choices that shape everything else. Each is stated as _Problem → Decision → Consequences_, so you can see not just what the SDK does but the trade-off it accepted. The deep pages link back here.

## ADR-1 — A thin client with no PDP logic

::: collapsible open "Problem → Decision → Consequences"
**Problem.** A client SDK could cache policies, evaluate conditions locally, or short-circuit obvious cases to save round-trips. Each of those duplicates the PDP and creates a second place where authorization can drift or be wrong.

**Decision.** The SDK contains **zero** authorization logic. Every verdict comes from the server's `decisions/check`. The client only serialises, calls, normalises, and fails closed.

**Consequences.** One source of truth for policy; the SDK can never disagree with the server. The cost is a network round-trip per uncached check — mitigated by the opt-in cache and a tight default timeout, never by moving policy into the client.
:::

## ADR-2 — `check()` never throws; failures are values

::: collapsible "Problem → Decision → Consequences"
**Problem.** If an authorization call throws on transport failure, callers write `try/catch` blocks that, under pressure, swallow the error and continue — silently failing open.

**Decision.** `check`, `can`, and `listResources` never throw. Failures fold into the return value (deny `Decision`, `false`, `[]`). Only `verifyToken` rejects, because a token has no safe fallback value.

**Consequences.** You cannot fail open by mishandling an exception — there isn't one. "Denied" and "couldn't reach the PDP" look identical at the call site (read `explanation` for observability, never for branching). See [Fail-closed by design](/concepts/fail-closed).
:::

## ADR-3 — A single fail-closed sink

::: collapsible "Problem → Decision → Consequences"
**Problem.** Error handling scattered across call sites tends to be inconsistent — some paths deny, some leak a permissive default.

**Decision.** Every error path funnels through one `deny(reason)` constructor producing a fully-safe `Decision` (`allowed: false`, empty fields, a reason breadcrumb). It mirrors the PHP `IamDecision::deny()`. Normalisation degrades missing/wrong-typed fields to their safe defaults.

**Consequences.** There is exactly one way to be denied and it is always safe; adding a new error branch means calling `deny()`, not inventing a new shape. The reason strings (`no-subject`, `transport`, `invalid body`) aid debugging without weakening the verdict.
:::

## ADR-4 — Mandatory audience on `verifyToken`

::: collapsible "Problem → Decision → Consequences"
**Problem.** `jose` skips the `aud` check when no audience is given, letting a token minted for a sibling service verify (confused-deputy) in a shared-issuer cluster.

**Decision.** `verifyToken` rejects unless an audience is configured (`verify.audience`) or passed (`options.audience`). The algorithm is pinned to `['ES256']`.

**Consequences.** The library's most dangerous default is unreachable; every caller must declare who a token is for. The cost is that you can't "just verify" without knowing your own audience — the right trade given the severity. See [Token verification theory](/concepts/token-verification).
:::

## ADR-5 — An opt-in cache that cannot turn deny into allow

::: collapsible "Problem → Decision → Consequences"
**Problem.** A naive decision cache can serve a stale **allow** after a revocation, or — worse — cache a transport-error deny and later be mistaken for a real verdict.

**Decision.** The cache is off by default. When on, it stores only real verdicts (never transport errors), skips `explain` queries, keys on a stable hash of the full query, and flushes wholesale on a newer `policyVersion`.

**Consequences.** The cache can only ever shorten the life of a stale **allow** (bounded by `ttlMs`, zeroed by a policy bump) and can never manufacture one. Latency relief without breaking the invariant. See [Caching safely](/best-practices/caching-safely).
:::

## ADR-6 — Byte-for-byte PHP parity

::: collapsible "Problem → Decision → Consequences"
**Problem.** A polyglot fleet (PHP, Node, RN, Rust) talking to one PDP must present an identical contract, or the server's view of "a caller" fragments per language.

**Decision.** The wire types and serialisation mirror the PHP client's `HttpDecider`/`DecisionRequest`/`IamDecision` exactly — slash endpoint, snake-case `current_aal`, explicit nulls, `{ data }` envelope unwrap, Bearer auth, deny-on-error.

**Consequences.** One policy engine and one audit trail serve every language; the server can't distinguish callers. The cost is that this SDK must track the PHP contract as it evolves — which is the point, not a burden. See [Wire contract](/architecture/wire-contract).
:::

## ADR-7 — Framework-agnostic middleware

::: collapsible "Problem → Decision → Consequences"
**Problem.** Shipping separate Express and Fastify middleware doubles the surface and the test matrix; taking a hard dependency on either bloats the install.

**Decision.** One `requirePermission` works on both, through a minimal structural request/response interface (`status`/`code`, `json`/`send`, `next`/`done`). No framework is imported. It also catches its own serialisation throws so even a circular `context` fails **closed**.

**Consequences.** One implementation, one test suite, zero framework deps. The cost is a slightly looser type surface (structural, not the frameworks' own types) — worth it for the reach and the smaller dependency tree.
:::

## ADR-8 — Native `fetch`, minimal dependencies

::: collapsible "Problem → Decision → Consequences"
**Problem.** Pulling in an HTTP client (axios, got) and a crypto stack inflates the dependency tree and the supply-chain surface for a security-critical package.

**Decision.** Transport is the global `fetch` (Node 18+), injectable for tests/proxies. The only runtime dependency is `jose` for JWKS/ES256. Ship ESM + CJS + types.

**Consequences.** A tiny, auditable dependency tree appropriate for a security component, and full testability via an injected `fetch`. The cost is requiring Node 18+ (or an injected `fetch` on older runtimes) — an acceptable floor in 2026.
:::

## Next steps

- [Architecture overview](/architecture/overview) — where these decisions live in the code.
- [Fail-closed by design](/concepts/fail-closed) — the invariant ADR-2/3/4/5 protect.
- [Fail-closed discipline](/best-practices/fail-closed-discipline) — keeping it true in your code.
