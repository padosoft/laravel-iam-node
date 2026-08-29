---
title: "Delegated access (agents acting for users)"
description: "Verify and authorize tokens where an AI agent acts on behalf of a user: the act chain, the strict-intersection rule, why delegated tokens are introspection-mandatory, and why their decisions are never cached."
---

When an **AI agent acts on behalf of a user**, the token it presents carries *two* identities, not one: `sub` is the user, and `act` is the agent acting for them. The SDK reads both, and asks the PDP a different question than it asks for a human.

This is the client half of [`laravel-iam-agents`](https://doc.laravel-iam-agents.padosoft.com) (RFC 8693 token exchange). Without that module on the server there is nothing to verify — `/decisions/check-delegated` and the delegated tokens themselves only exist when it is installed.

## The invariant

> **Two identities, strict intersection, never union, fail-closed.**

The verdict is what the user may do **AND** what every actor in the chain may do — never the union of the two. That single sentence is what makes handing an agent a delegation safer than handing it a session token:

- The agent can never do more than the user could. A user who cannot refund an order cannot lend that power to a bot.
- The agent can never do more than *it* was allowed. An agent scoped to drafting cannot pay, even for an admin.
- **Adding a hop can only narrow authority.** A chain of three agents is bounded by the smallest of the four sets. There is no arrangement of hops that grants something new — which is why depth is an accountability question, not an authority one.

A deny at any layer wins. That is deny-overrides, composed.

## The act chain

For a single hop, `act` is one level:

```json
{ "sub": "user:42", "act": { "sub": "agent:assistant" } }
```

For multiple hops it nests, outermost-first (RFC 8693 §4.1) — and the ordering is load-bearing:

```json
{
  "sub": "user:42",
  "act": { "sub": "agent:hop2", "act": { "sub": "agent:hop1" } }
}
```

`actorChainFromClaims` flattens that into `['agent:hop2', 'agent:hop1']`:

- **`actors[0]` is the CURRENT actor** — the one holding the token right now, outermost in the claim.
- **The last element is the root** — the agent the user actually consented to, and the one whose grant governs the whole chain. Revoke it and everything downstream stops.

Reading that order backwards silently checks the wrong agent, so it is pinned by a test rather than left to a comment.

## Verifying a delegated token

```ts
import { IamClient } from '@padosoft/laravel-iam-node';

const iam = new IamClient({
  baseUrl: 'https://iam.example.com/api/iam/v1',
  clientId: process.env.IAM_CLIENT_ID,
  privateKey: process.env.IAM_PRIVATE_KEY,
  // introspectionUrl defaults to <oauthUrl>/introspect
});

const bearer = await iam.verifyDelegatedToken(token);
if (bearer === null) return res.status(401).end();

// bearer = { sub: 'user:42', actors: ['agent:a1'], grantId: 'dgr_…', scopes: [...], verified: true }
```

`verifyDelegatedToken` is fail-closed **without throwing**: every failure — not a JWT, not delegated, malformed `act`, introspection unreachable, token inactive, incoherent claims — resolves to `null`. Treat `null` as 401.

It also returns `null` for a perfectly good **non-delegated** token. That is not an error: such a token is not this method's business. Verify it with [`verifyToken`](/guides/verifying-tokens) on the normal path.

### Delegated tokens are introspection-mandatory

This is the rule most likely to be "optimised away" by someone who has not been bitten by it, so it is worth stating plainly: **the authorization view never comes from the local bytes.**

`verifyDelegatedToken` calls the server's RFC 7662 `/oauth/introspect`, and builds its answer from the claims that come back. The server re-checks the signature, the expiry, **and that the delegating user's session is still alive** — the last of which no amount of local parsing can tell you. A user who logged out ten seconds ago still has a perfectly valid-looking token in the agent's hands.

So: **no introspection reachable ⇒ no delegated authorization.** Not "fall back to the local parse" — deny.

::: callout warning "typ is routing, not a defence"
`typ: delegated+jwt` tells the SDK which path a token belongs on — nothing more. A verifier that trusts a header field to decide how much authority a token carries is trusting the token to describe itself.
:::

If your resource server must never accept delegated tokens at all, set `introspectionUrl: ''` — the SDK then refuses every one of them without a round-trip.

## Asking for a delegated decision

```ts
const ok = await iam.canDelegated(
  { id: bearer.sub },   // the USER — never the agent
  bearer.actors,        // current actor first
  'orders.draft',
  {
    resource: { type: 'order', id: orderId },
    delegationGrantId: bearer.grantId, // so a revoked grant is caught inside the token's lifetime
  },
);
```

`checkDelegated` returns the full `Decision` (with its citable `decision_id`); `canDelegated` is the fail-safe boolean — `true` only when the PDP allowed **and** no step-up is pending.

Passing `delegationGrantId` matters: the PDP looks the grant up on every delegated decision, so a grant revoked one second ago stops the very next request rather than waiting for the token to expire.

### An empty actor chain is a deny

```ts
await iam.checkDelegated({ id: 'usr_1' }, [], 'orders.read');
// → denied, explanation: ['no-actor'], no request sent
```

It is **not** "fall back to checking the user". An empty chain means the caller lost track of who is acting, and quietly answering the user-only question there would hand the agent's request the user's full authority — the exact escalation delegation exists to prevent.

## Delegated decisions are never cached

Even with the decision cache enabled, a query carrying an act chain always goes to the server.

A cached allow would outlive the revocation meant to stop it, and "the kill switch works *now*" is the entire reason delegated tokens are short-lived in the first place. Caching them would trade that away for a few milliseconds.

Plain checks cache exactly as before — see [Caching decisions](/guides/caching). The cache key includes the full query, so a cached plain allow can never be served to a delegated question about the same user and permission.

## Malformed `act` throws; absent `act` does not

The asymmetry is deliberate:

| Claim | Meaning | Behaviour |
| --- | --- | --- |
| no `act` | not delegated | `null` — use the normal path |
| readable `act` | delegated | the chain |
| unreadable `act` | delegated, but broken | **throws** `MalformedDelegationError` |

Degrading a broken delegated token into "a normal user token" is the confused deputy in one line of code: the `act` that bounded the agent's authority becomes unreadable, so the agent inherits the user's. Refusing is the only safe reading. The same applies to a `typ: delegated+jwt` header with no `act` to act on, and to a chain deeper than 16 hops (a cyclic claim must not spin the parser).

`verifyDelegatedToken` catches all of this for you and returns `null` — the throw is what you get from the lower-level [`inspectDelegatedBearer`](/reference/client) if you call it directly.

## Middleware

```ts
import { requireDelegatedPermission } from '@padosoft/laravel-iam-node/middleware';

app.post(
  '/orders/:id/draft',
  requireDelegatedPermission(iam, 'orders.draft', {
    resource: (req) => ({ type: 'order', id: req.params.id }),
  }),
  draftHandler,
);
```

On success, `req.iamDelegation` carries the verified `{ sub, actors, grantId, scopes }` — so handlers and logs can name both identities without re-parsing anything. On a denial nothing is attached, so a handler can never mistake a leftover object for a grant.

A **non-delegated token is a 401** here, not a fallback: the route exists to say "only delegated callers reach this", and accepting a full-authority user token would defeat the point. Use `requirePermission` for routes humans call directly.

By default the token is read from `Authorization: Bearer …`; pass `token: (req) => …` for other transports.

## Logging both identities

Once a request is delegated, "who did this" has two answers, and an audit trail that records only one of them is not an audit trail. Log both:

```ts
logger.info('order drafted', {
  sub: req.iamDelegation.sub,          // on whose behalf
  actor: req.iamDelegation.actors[0],  // who actually did it
  chain: req.iamDelegation.actors,     // the full path of authority
  grant: req.iamDelegation.grantId,    // what the user consented to
  decision_id: decision.decisionId,    // replayable against the PDP
});
```

That set answers the two questions an auditor actually asks — *everything agent X did, for anyone* and *everything done on behalf of user Y, by any agent* — and the `decision_id` lets them replay the verdict instead of taking your word for it.

## See also

- [`laravel-iam-agents`](https://doc.laravel-iam-agents.padosoft.com) — the server module: agent registry, delegation grants, consent, token exchange
- [Verifying tokens (JWKS)](/guides/verifying-tokens) — the non-delegated path
- [Caching decisions](/guides/caching) — why delegated queries opt out
- [Fail-closed by design](/concepts/fail-closed)
