# AI Coding Agent — Implementation Plan

> Goal: build a self-improving AI coding agent that plans, edits code, validates
> changes, and iterates until green — sandboxed in isolated workspaces and
> surfaced through a streaming web UI.

The plan is derived from [`architecture.md`](./architecture.md) and executed in
10 phases. Each phase lands independently: it is testable, type-checks, lints,
and is committed as a single milestone commit.

## Status at a glance

| Phase | Title | Status | Reference |
|-------|-------|--------|-----------|
| 1 | Foundation & Gateway | ✅ Done | `253dc1b` (Stage 1) |
| 2 | Workspaces & Terminal | ✅ Done | `4e8c6fa` (Stage 2) |
| 3 | Planning & Agent Loop | ✅ Done | `bcc5fa7` (M3 completed) |
| 4 | Patch Engine | ✅ Done | `2a81aa6` (M4 completed) |
| 5 | Validation & Repair Loop | ✅ Done | `f867d3b` (M5 completed) |
| 6 | Persistence & Repositories | ✅ Done | `87901e8` (M6 completed) |
| 7 | Deep Context Loading | ⬜ Not started | see phases/phase-07 |
| 8 | Branching & Memory | ⬜ Not started | see phases/phase-08 |
| 9 | Full Tool Suite | 🟡 Partial (WIP) | see phases/phase-09 |
| 10 | Firecracker Workspaces & Hardening | ⬜ Not started | see phases/phase-10 |

## Rendering of phases 01–05

### Phase 01 — Foundation & Gateway (✅)
Monorepo (`pnpm` workspaces), shared `types`, LLM adapters + `ModelRouter`, the
Fastify gateway (routes/auth/session/streaming), in-memory `ConversationService`
and `MessageStore`, and the React chat shell with SSE streaming.

### Phase 02 — Workspaces & Terminal (✅)
Sandbox layer: `WorkspaceManager` routing to `LocalWorkspace` and
`DockerWorkspace`, plus a real shell in the browser via `node-pty` bridged over
a WebSocket (`gateway/terminal.ts`, `frontend/Terminal.tsx`).

### Phase 03 — Planning & Agent Loop (✅)
Planning layer: `TaskGraph`, `Planner`, and `ExecutionPlan` decompose a goal
into steps; `PlannerLoop` plans before doing; `AgentLoop` executes step-by-step
with tool calling, streaming, and redaction.

### Phase 04 — Patch Engine (✅ `2a81aa6`)
Editor layer: `PatchEngine` produces/validates line-based patches,
`ApplyPatch` applies them atomically with hunk tracing, `ASTEditor` provides
syntactic (targeted) edits, and `ConflictResolver` merges overlapping hunks.

### Phase 05 — Validation & Repair Loop (✅ `f867d3b`)
Quality gate: `BuildRunner`/`TestRunner`/`LintRunner` + `ValidationRunner`
execute project commands in the workspace and report a pass/fail summary;
`RepairLoop` feeds failures back to the model to patch and re-validate.

### Phase 06 — Persistence & Repositories (✅ `87901e8`)
SQLite store for conversations/messages/workspaces with boot rehydration;
`ConversationRepository` (soft-delete, paginated history), `CacheRepository`
(model+task-hash prompt cache wired into `ModelRouter`), `EmbeddingRepository`
(cosine vector search), and `TraceRepository` (run/tool traces).

Each phase contains goals, deliverables, file map, acceptance criteria, and the
verification command (`pnpm test`, `pnpm typecheck`, `pnpm lint`).

## Conventions

- **One commit per phase**, message `M<n> completed` (matches history).
- **No dead-serious stubs.** A phase is "done" only when its tests are green.
- **Verify before commit:** `pnpm test` && `pnpm typecheck` && `pnpm lint`.
- Completed phase files describe what was actually built; unstarted phases are
  prescriptive plans to execute.

Read the full detail for each milestone under
[`phases/`](./phases/phase-01-foundation.md).