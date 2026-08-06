# Phase 06 — Persistence & Repositories

**Status:** 🟡 In progress — SQLite store + workspace rehydration done

## Goal

Replace throwing away state with durable persistence: conversations, messages,
workspace records, and the four repository surfaces (conversation, cache,
embedding, trace) so a server restart re-attaches live workspaces and history
survives.

## What is already done (working tree)

- **`src/persistence/SqliteStore.ts`** — `node:sqlite` (`DatabaseSync`) store
  implementing `MessageStore` plus workspace records:
  - tables: `conversations` (id, workspace_id, created_at, branch_id,
    parent_id), `messages` (id, conversation_id, role, content, tool_calls,
    created_at, seq, indexed), `workspaces` (id, kind, root, container_name,
    created_at).
  - `saveWorkspace`/`getWorkspaceRecord`/`listWorkspaceRecords`/
    `deleteWorkspaceRecord`, WAL mode, FK cascade delete.
- **`WorkspaceManager.rehydrate(records)`** — re-attaches docker containers
  (`attachDockerWorkspace`) and local roots at boot; failed re-attaches drop
  the stale record instead of blocking startup.
- **Gateway wiring** — `buildServer({ dbPath })` builds the sqlite store,
  rehydrates workspaces, and passes the save/delete hooks to the manager
  (`src/gateway/index.ts:31`).
- **Tests**: `SqliteStore.test.ts` (7), `WorkspaceManager.test.ts` (3).

## Remaining deliverables

- **`ConversationRepository.ts`** — typed CRUD over conversations/messages on
  top of SqliteStore: soft-delete, archival, paginated history. The primary
  API for the gateway beyond the raw `MessageStore`.
- **`CacheRepository.ts`** — prompt/response cache keyed by
  `model + normalized task hash`; TTL and cap; consulted before an LLM call in
  `ModelRouter` (cache hit = return stored response, else record).
- **`EmbeddingRepository.ts`** — append/query real-number vectors per code
  chunk; feeds Phase 07 semantic search and Phase 08 memory
  (schema `embedding (id, content_ref, model, dimensions, vector blob)`).
- **`TraceRepository.ts`** — append-run/tool-call traces (conversation_id,
  step, tool, args-summary, latency, outcome) with list/filter for an
  observability endpoint; feeds Phase 10 hardening.
- Update `persistence/index.ts` to export all four.
- Extend `SqliteStore` schema + store tests for the new tables.

## Key decisions

- One SQLite file per server (`dbPath`), WAL mode; in-memory default when no
  path given (tests stay hermetic, no files).
- Repositories are thin query layers over `DatabaseSync` — no ORM, consistent
  with the existing synchronous `MessageStore` contract.
- `TraceRepository` and `EmbeddingRepository` accept optional writes so runs
  without tracing are not penalized.

## Acceptance criteria

- [ ] All four repositories implemented with SQLite-backed tests
- [ ] Cache hits short-circuit `ModelRouter`
- [ ] Embedding rows round-trip (store → query)
- [ ] Traces queryable for a conversation
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` all green
- [ ] Commit as `M6 completed`

## Verification

```bash
pnpm test src/persistence && pnpm test && pnpm typecheck && pnpm lint
```