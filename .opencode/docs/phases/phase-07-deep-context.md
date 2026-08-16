# Phase 07 — Deep Context Loading

**Status:** ✅ Done (`d0def6c`, M7 completed)

## Goal

`ContextLoader` today returns a shallow file tree (depth 2, ≤200 entries) plus
root-level manifest files (`src/runtime/ContextLoader.ts`). Phase 07 upgrades it
into a budget-aware repository comprehension engine so the model sees the code
that matters for the task — not 8k chars of every manifest — before planning.

## Deliverables

- **`ContextLoader.load(workspace, { task })`** — scope-aware loading:
  - Respect `.gitignore` (and `AGENTS.md`/`CLAUDE.md`) while walking, not a
    hardcoded ignore list.
  - Rank candidate files by relevance to the task: filename/extension match,
    string + symbol token overlap with the task, recency (mtime).
  - Enforce a total character budget (`maxContextChars`, default e.g. 40k);
    fill with the highest-ranked files, truncate per-file, mark truncation.
  - Return a ranked index (`ctx.index`): `file → { rank, chars, truncated }`
    alongside the rendered context.
- **Import graph** (`src/runtime/ImportGraph.ts`): static scan of
  `import`/`require` statements; walk from the task-matched entrypoints into
  transitively imported modules — the difference between "reads the tree" and
  "understands the codebase".
- **PromptBuilder integration** (`src/runtime/PromptBuilder.ts`): context is
  injected with a manifest block, budget accounting, and a "context truncated
  at N files" footer so the model knows what it is missing.
- **Semantic search hook** (optional, requires Phase 06 embeddings): rank with
  cosine similarity over `EmbeddingRepository` when vectors exist; fall back to
  lexical ranking otherwise.
- **Tests**: ignore rules, budget capping, keyword ranking, import-graph
  traversal, truncation flags.

## Key decisions

- Deterministic lexical ranking first; semantic ranking only as an enhancement
  when embeddings exist (keeps the phase runnable without an embedding model).
- Context loading is **one-shot per plan** (per PlannerLoop invocation), not
  re-loaded on every step.
- Ignore sources are layered: built-in defaults ∪ workspace `.gitignore` ∪
  `AGENTS.md`-declared ignores.

## Acceptance criteria

- [x] Ignore rules (built-in + workspace) respected
- [x] Task-keyword ranking beats plain tree order in a fixture repo
- [x] Total context stays within budget; per-file truncation flagged
- [x] Import graph returns transitive modules for a seed file
- [x] Prompt includes manifest + budget footer
- [x] All new tests green; `pnpm test && pnpm typecheck && pnpm lint`
- [x] Commit as `M7 completed` (`d0def6c`)

## Verification

```bash
pnpm test src/runtime && pnpm test && pnpm typecheck && pnpm lint
```