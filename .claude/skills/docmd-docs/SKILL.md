---
name: docmd-docs
description: >
  Author and maintain the public documentation site for @padosoft/laravel-iam-node, built with docmd
  and living in docs-site/. Use this skill whenever you work inside docs-site/ — adding or editing a
  page under docs-site/docs/**, touching navigation[] or plugins in docmd.config.json, adjusting the
  brand/CSS or favicon, wiring the semantic search, or keeping the docs in sync with a changed feature
  in src/ or the README. Covers the layout, the build/check commands, the container syntax, the plugin
  config, the semantic-search pin, the doc-page structure standard, and the known gotchas.
---

# docmd docs-site for laravel-iam-node

The public docs live in `docs-site/` and are built with [docmd](https://docs.docmd.io) — a static-site
generator from pure Markdown. The user deploys `_site/` to Cloudflare Pages; you never configure deploy CI.

## Layout

```
docs-site/
  docmd.config.json          # metadata, url, navigation (sole sidebar source), theme, plugins
  package.json               # scripts: dev / build / check
  package-lock.json          # lockfileVersion 3, cross-platform (Linux natives for CF) — verify with `npm ci`
  .node-version              # "20"
  .gitignore                 # ignores _site/, node_modules/, .docmd-search/* (keeps config.json)
  .docmd-search/config.json  # pinned embedding model (COMMITTED) — skips the interactive wizard
  assets/favicon.svg         # teal #0d9488 mark
  assets/custom.css          # brand override
  scripts/check-no-raw-html.mjs  # CI guard: no raw HTML/MDX tags, no ::: button
  docs/                      # all pages; route mirrors the tree (docs/x/y.md → /x/y, docs/index.md → /)
  _site/                     # build output (git-ignored)
```

## Commands (run inside `docs-site/`)

- `npm ci` — install from the committed lockfile (preferred; don't regenerate on Windows).
- `npm run check` — the raw-HTML/MDX guard. Must pass.
- `npm run build` — generate `_site/` (also builds the semantic index). Must be green.
- `npm run dev` — local preview.

Completion bar: `npm run check` and `npm run build` both green, `_site/index.html` present, 0 visible `:::`.

## Container syntax (pure Markdown, NEVER MDX/JSX — the guard rejects raw tags)

| Need | Syntax |
|---|---|
| Callout | `::: callout info "Title" icon:name` … `:::` (types: info, tip, warning, danger, success) |
| Tabs | `::: tabs` then `== tab "Label"` blocks, close `:::` |
| Steps | `::: steps` then a numbered list `1. **Title**` with body indented **3 spaces**, close `:::` |
| Collapsible | `::: collapsible "Title"` … `:::` (prefix `open` to expand by default) |
| Cards | `::: grids` › `::: grid` › `::: card "Title" icon:lucide-name` › body › `[Open →](/path)` › `:::` |
| Diagram | ` ```mermaid ` fence |
| Math | KaTeX `$…$` inline, `$$…$$` block (only outside code fences) |

Icons are [Lucide](https://lucide.dev) names in kebab-case. **Never** use `::: button` (the guard fails it) — use a Markdown link `[Open →](/path)` inside cards.

## docmd.config.json

`navigation[]` is the ONLY source of the sidebar — a new page must be added there or it won't appear.
Plugins active: `search` (semantic), `git` (repo + edit links), `seo`, `sitemap`, `mermaid`, `math`,
`llms` (generates llms.txt / llms-full.txt), `analytics` (off). Root `url` is required by seo/sitemap/llms.
Brand: `#0d9488` (teal, unified across the Laravel IAM ecosystem) in `assets/custom.css`.

## Semantic search

`plugins.search.semantic: true` uses `docmd-search`: embeddings are computed at build-time with ONNX
Runtime; the browser gets quantized Int8 vectors and does keyword-match + cosine (100% client-side).
The model is pinned in `.docmd-search/config.json` (`Xenova/all-MiniLM-L6-v2`) so the first build doesn't
launch the interactive model-picker wizard (which hangs CI). Keep that file committed; the rest of
`.docmd-search/` is git-ignored.

## Footer / branding

Footer credits the author (Lorenzo Padovani / Padosoft) and links GitHub + npm; `branding: true`.

## Deploy (the user does it — don't configure deploy CI)

Cloudflare Pages, Git integration: production branch `main`, root dir `docs-site`, build `npm run build`,
output `_site`, Node from `.node-version` (20). The committed cross-platform lockfile lets `npm ci`
resolve onnxruntime/sharp on CF.

## Doc-page structure standard (each deep page)

1. **Motivation** — the problem it solves.
2. **Theory** — definitions, KaTeX where it earns its place; academic but readable.
3. **Design + a Mermaid diagram** — architecture / flow / pipeline.
4. **Data model / contract** — input/output schema, tables, examples.
5. **ADR** — Problem → Decision → Consequences, inside `::: collapsible`.
6. **Worked example** — concrete end-to-end with code.
7. **Gotchas / limits** — in `::: callout warning`.

Sidebar groups for this SDK: Get Started, Guides, Concepts & Theory, Architecture, Best Practices, Reference.
Be accurate: document what the code in `src/` actually does (IamClient.check/can/listResources/verifyToken,
the fail-closed funnel, the mandatory audience, the opt-in cache, the Express/Fastify middleware). No invention.

## Gotchas

1. `docs/index.md` is mandatory (route `/`).
2. `::: button` is not a block — use a Markdown link inside cards.
3. Steps: re-indent item bodies to **3 spaces** so nested fences/callouts stay in the item.
4. KaTeX only renders outside code fences.
5. Use the committed lockfile; don't commit a lock that resolves only your OS's optional deps.
6. Every new page must be registered in `navigation[]`.
