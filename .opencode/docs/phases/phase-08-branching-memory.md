
# Phase 08 — Branching & Memory

**Status:** ✅ Done (`3412a04`, M8 completed)

## Goal

Two empty stubs live in `src/conversation/` (`BranchService.ts`,
`MemoryService.ts`), yet the schema already carries the needed columns
(`conversations.branch_id`, `conversations.parent_id`). Phase 08 makes
conversations forkable like git branches and gives the agent durable memory
across sessions.

## Deliverables

### BranchService (`src/conversation/BranchService.ts`)

- `fork(parentId, branchName?)` — new conversation with `parent_id = parentId`,
  a fresh `branch_id`, and a new workspace copy (or a lazy copy-on-write root).
- `list(conversationId)` — branch tree for a conversation lineage.
- `switch(conversationId, branchId)` — swaps the active conversation/worskpace
  binding at the service level (kept simple: one active branch at a time).
- `merge(sourceBranchId, targetBranchId)` — overlay source messages onto the
  target history; file-level merge reuses `ConflictResolver` from Phase 04 for
  workspace content conflicts.
- `diff(a, b)` — message-level diff of two branches for the UI.
- **Gateway routes**: `POST /conversations/:id/branch`,
  `GET /conversations/:id/branches`, `POST /branches/:id/merge`.
- **Frontend**: branch switcher in `ChatPanel`/`App`; badge showing current
  branch per conversation.
- **Tests**: fork isolation (parent untouched), lineage traversal, merge with
  and without conflicts.

### MemoryService (`src/conversation/MemoryService.ts`)

- `summarize(conversationId)` — asks the model for a compact summary of a
  conversation (decisions, files touched, open threads); stored as a
  `memory` record (SQLite `memory` table or `ConversationRepository` column).
- `recall(goal)` — retrieve the most relevant past summaries (keyword rank now,
  Phase 06 embeddings when available) and inject into the PromptBuilder context.
- `prune(retentionDays)` — drop summaries older than the retention window.
- **Tests**: summarize stores a record; recall returns the relevant summary
  for a matching goal; prune removes stale rows.

## Key decisions

- Branching is **conversation-level**, not git-level: branches share the
  underlying workspace until a file conflict occurs, then `ConflictResolver`
  arbitrates. (Full git-branch integration lives in Phase 10 with
  `GitWorkspace`.)
- Memory is **opt-in by default** — a conversation must be flagged
  `memory: true` (route param or UI toggle) to be summarized, controlling cost.
- Summaries are injected as a "Memory" block in the system prompt, newest
  first, capped at N entries.

## Acceptance criteria

- [x] Fork creates an isolated conversation + workspace
- [x] Merge surfaces conflicts via `ConflictResolver` (or succeeds)
- [x] Branch switcher works end-to-end in the UI
- [x] Summaries persist and recall for matching goals
- [x] All new tests green; full suite + typecheck + lint
- [x] Commit as `M8 completed` (`3412a04`)

## Verification

```bash
pnpm test src/conversation && pnpm test && pnpm typecheck && pnpm lint
```