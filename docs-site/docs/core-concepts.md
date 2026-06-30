---
title: "Core concepts"
description: "The mental model: PDP vs PEP, subjects and resources, the Decision shape, allowed vs granted, AAL and step-up, the wire contract, and the opt-in cache."
---

This page is the vocabulary. Read it once and the rest of the docs — and the API — read themselves.

## PDP and PEP

Authorization has two roles:

- **Policy Decision Point (PDP)** — decides. _"Given this subject, permission, resource and context, is it `allow` or `deny`?"_ Laravel IAM **is** the PDP. It owns roles, conditions, relationships and step-up rules.
- **Policy Enforcement Point (PEP)** — enforces. It asks the PDP and acts on the answer (lets the request through, or returns 403). **Your Node service is the PEP.** This SDK is the wire between them.

> This SDK is a PEP-side client. It contains **no** PDP logic. It never interprets a grant or evaluates a policy — it asks `decisions/check` and reports the answer.

```mermaid
flowchart LR
    subgraph Your service (PEP)
      H[Route handler] --> C["IamClient.check()"]
    end
    C -->|"decision query"| PDP["Laravel IAM (PDP)"]
    PDP -->|"Decision"| C
    C -->|"allow → next()<br/>deny → 403"| H
```

## Subject and resource

- A **subject** (`{ type?, id }`) is _whoever the decision is about_ — a user, a service account, a group, an agent. `id` is required; `type` defaults to `user` server-side. A subject without an `id` is an immediate deny.
- A **resource** (`{ type, id }`) is _the object an action targets_ — a specific warehouse, document, order. Optional: many permissions are resource-independent.
- **Context** is free-form ABAC facts the policy may evaluate — amount, time, IP, anything. `{ amount: 300 }` lets a policy say _"adjustments over 500 need step-up"_.

## The Decision

Every `check()` returns a normalised `Decision`:

| Field | Type | Meaning |
| --- | --- | --- |
| `allowed` | `boolean` | The PDP's raw verdict. **Not** sufficient on its own (see below). |
| `requiresStepUp` | `boolean` | Allowed only at a higher assurance level — currently **not yet permitted**. |
| `requiredAal` | `string \| null` | The AAL the action needs if step-up is pending (e.g. `aal2`). |
| `policyVersion` | `number` | Monotonic server policy version — drives cache invalidation. |
| `decisionId` | `string` | Server-assigned id for audit correlation. |
| `matched` | `DecisionMatch[]` | Policy elements the PDP matched while deciding. |
| `explanation` | `string[]` | Human-readable reasoning (populated when you pass `explain: true`). |

## `allowed` vs `granted`

This is the single most important distinction in the SDK:

$$
\text{granted} = \text{allowed} \land \lnot\,\text{requiresStepUp}
$$

`allowed: true, requiresStepUp: true` means _"this would be allowed, but only after a step-up challenge"_ — so it is **not** something you may act on yet. The fail-safe reduction is exposed two ways:

- `iam.can(query)` — does the check and returns the boolean.
- `isGranted(decision)` — reduces a `Decision` you already have.

**Gate on `granted`, never on raw `allowed`.** See [Step-up & AAL](/concepts/step-up-aal).

## Assurance levels (AAL)

**AAL** (Authenticator Assurance Level, from NIST SP 800-63B) grades _how strongly_ the caller authenticated: `aal1` (password), `aal2` (MFA), and so on. Every query carries a `currentAal` (default `aal1`). A policy can demand a higher AAL for sensitive actions; when the caller's level is too low, the PDP returns `requiresStepUp: true` with a `requiredAal`, and your PEP should drive a step-up challenge rather than a flat denial.

## The wire contract

The SDK speaks the **canonical decision contract**, byte-for-byte identical to the PHP client. That parity is the whole point: the server cannot tell a Node caller from a PHP one.

- **Endpoint:** `POST {baseUrl}/decisions/check` (note the **slash** form `decisions/check`).
- **Auth:** `Authorization: Bearer <service token>`, `Accept: application/json`.
- **Body:** `{ subject:{type,id}, permission, organization, application, resource, context, current_aal, explain }` — every key present (nulls included), `current_aal` snake-case, `subject.type` defaulted to `user`.
- **Response:** the server's `Decision`, wrapped in a `{ "data": { … } }` envelope that the SDK unwraps transparently.

Full detail in [Wire contract](/architecture/wire-contract).

## Token verification

Separate from decisions, `verifyToken()` answers _"is this token genuine and meant for me?"_ It verifies the **ES256** signature and the `iss` / `aud` / `exp` / `nbf` claims against the server's JWKS. The **audience is mandatory** — without it the SDK refuses to verify, because the underlying library would otherwise skip the audience check and accept tokens minted for sibling services. See [Token verification theory](/concepts/token-verification).

## The opt-in cache

Off by default. When enabled (`cache: { ttlMs }`), the SDK caches the server's verdict under a stable hash of the full query, for a short TTL. The cache is built to be **incapable of turning a deny into an allow**:

- it stores the verdict **verbatim** — it never synthesises an allow;
- it **never** caches transport errors (a synthetic deny must not outlive the outage);
- it **skips** `explain` queries (reasoning must be fresh);
- it **flushes wholesale** when the server reports a newer `policyVersion`.

See [Caching decisions](/guides/caching) and [Caching safely](/best-practices/caching-safely).

## Where each concept lives in the API

| Concept | API surface |
| --- | --- |
| Ask a decision | `check()`, `can()` → [client reference](/reference/client) |
| Reduce to granted | `can()`, `isGranted()` |
| Gate a route | `requirePermission()` → [middleware reference](/reference/middleware) |
| Verify a token | `verifyToken()` |
| List ReBAC resources | `listResources()` |
| Cache decisions | `cache` config |

## Next steps

- [Checking permissions](/guides/checking-permissions)
- [The decision model](/concepts/decision-model)
- [Architecture overview](/architecture/overview)
