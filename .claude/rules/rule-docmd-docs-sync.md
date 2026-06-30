# Rule: keep the docmd docs-site in sync with the package (BLOCKING)

This rule is **binding**. It governs every change to user-facing behaviour of `@padosoft/laravel-iam-node`.

## The rule

**Whenever you add or change a user-facing feature, or substantially update the README, you MUST update the
corresponding docmd page under `docs-site/docs/**` in the same unit of work** — and register any new page in
`navigation[]` of `docs-site/docmd.config.json`. Follow the `docmd-docs` skill for layout, container syntax,
plugins, and the page-structure standard.

User-facing changes that REQUIRE a docs update include:

- a new or changed public method / option on `IamClient` (`check`, `can`, `listResources`, `verifyToken`)
  or its config (`IamClientConfig`, `VerifyOptions`, `CacheOptions`) → update `reference/client.md`,
  `reference/types.md`, and any affected guide/concept page;
- a change to the middleware (`requirePermission`, resolvers, deny body, `onDeny`) → `reference/middleware.md`,
  `guides/express.md`, `guides/fastify.md`;
- a change to the wire contract (endpoint, payload shape, envelope, auth) → `architecture/wire-contract.md`,
  `concepts/decision-model.md`;
- a change to fail-closed semantics, the cache, token verification, or step-up handling → the matching
  `concepts/**` and `best-practices/**` page;
- any new exported type or error → `reference/types.md` / `reference/errors.md`.

## When it does NOT apply

A docs update is **not** required for: internal refactors with no behavioural change, tooling/CI/build-only
changes, test-only changes, or pure cosmetics. When you skip docs for one of these reasons, **say so explicitly**
in the commit message / PR description (e.g. "docs: n/a — internal refactor, no behaviour change").

## Before you close the work

Run inside `docs-site/`:

```bash
npm run check   # raw-HTML/MDX guard — must pass
npm run build   # must be green; _site/index.html present
```

## Anti-patterns (treat as failures)

- A shipped feature with no corresponding docs page or update.
- A new page that isn't registered in `navigation[]` (it won't appear in the sidebar).
- MDX/JSX or raw HTML tags, or `::: button`, in Markdown (the guard rejects them).
- Docs that describe intended behaviour rather than what `src/` actually does — accuracy over aspiration.
- Leaving `npm run build` red or `_site/index.html` missing.
