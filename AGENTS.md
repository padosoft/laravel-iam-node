# AGENTS.md

Agent guidance for `@padosoft/laravel-iam-node`. See [CLAUDE.md](CLAUDE.md) for the
full brief — this is the short version.

## Non-negotiable

**Fail-closed.** Any error/ambiguity ⇒ deny, never allow. No fail-open opt-out.
Preserve a dedicated test for each error path when you change request, cache, token
verification, or middleware code.

## Before you commit

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

All four must pass (CI runs them on Node 18/20/22).

## Don't

- Don't add client-side PDP logic — the verdict is always the server's.
- Don't let the cache turn a deny into an allow, cache transport errors, or cache `explain`.
- Don't publish to npm or create git tags/releases from automation; the maintainer does that.
- Don't add heavy dependencies; native `fetch` + `jose` only.
