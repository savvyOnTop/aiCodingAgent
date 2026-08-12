# Phase 06 — Persistence & Repositories

**Status:** ✅ Done — commit `87901e8` ("M6 completed"); SQLite store +
rehydration shipped with `f867d3b` ("M5 completed")

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

## Delivered

- **`ConversationRepository.ts`** — typed CRUD over conversations on top of
  SqliteStore: `create`/`get`/`list` (newest-first, excludes soft-deleted by
  default, `includeDeleted` option), `softDelete`/`restore`, cascade
  `hardDelete`, and paginated `history(conversationId, { limit, offset })`
  sharing the same tables as `SqliteMessageStore`.
- **`CacheRepository.ts`** — prompt/response cache keyed by
  `provider/model + sha256(message+tools)` via `computeCacheKey`; TTL expiry
  (pruned lazily on access and on write), hard cap with oldest-entry eviction
  (configurable `maxEntries`), persistence across reopen.
- **`EmbeddingRepository.ts`** — per model+contentRef vector rows
  (`content_hash` for staleness detection), upsert-on-conflict, and
  `similar(vec, model, k)` cosine ranking in-process (no sqlite vector
  extension needed); feeds Phase 07 semantic ranking and Phase 08 memory.
- **`TraceRepository.ts`** — one row per dispatched tool call / model turn
  (`conversation_id`, `step`, `tool`, `tool_args`, `outcome`, `latency_ms`);
  per-conversation listing and paginated global listing newest-first.
- **Schema** — `src/persistence/schema.ts` is now the single source of truth
  (shared with `SqliteStore`); adds `conversations.deleted_at` (soft delete)
  and the `llm_cache` / `embeddings` / `traces` tables.
- **`ModelRouter` integration** — optional `cache` in `RouterOptions`;
  `complete()` checks the cache per adapter before calling and stores results
  on success; `createDefaultRouter(env, cache)` threads it through
  `AgentRuntime({ cache })` and the gateway (`buildServer` creates a cache
  repository on the same dbPath).
- **Tests**: repository tests (conversation 6, cache 7, embeddings 6, traces
  4) + 2 `ModelRouter` cache tests (hit short-circuits the adapter; failover
  caches per provider).

## Key decisions

- One SQLite file per server (`dbPath`), WAL mode; in-memory default when no
  path given (tests stay hermetic, no files).
- Repositories are thin query layers over `DatabaseSync` — no ORM, consistent
  with the existing synchronous `MessageStore` contract.
- `TraceRepository` and `EmbeddingRepository` accept optional writes so runs
  without tracing are not penalized.

## Acceptance criteria

- [x] All four repositories implemented with SQLite-backed tests
- [x] Cache hits short-circuit `ModelRouter`
- [x] Embedding rows round-trip (store → query)
- [x] Traces queryable for a conversation
- [x] `pnpm test` / `pnpm typecheck` / `pnpm lint` all green
- [x] Committed as `M6 completed` (`87901e8`)

## Verification

```bash
pnpm test src/persistence && pnpm test && pnpm typecheck && pnpm lint
```