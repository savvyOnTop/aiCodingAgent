# Phase 03 — Planning & Agent Loop

**Status:** ✅ Done — commit `bcc5fa7` ("M3 completed")

## Goal

Give the agent the ability to decompose a goal into a plan before acting, then
execute that plan step-by-step against a workspace with tool calling, streaming
increments, and secret redaction.

## Deliverables

- **Planner layer** (`src/planner/`):
  - `Planner` — asks the model for a `TaskGraph` (tasks, dependencies,
    ordering feedback).
  - `TaskGraph` — graph model over tasks with topological accessors and
    mutable status transitions.
  - `ExecutionPlan` — converts a `TaskGraph` into an ordered list of steps with
    status tracking.
- **Runtime** (`src/runtime/`):
  - `AgentRuntime` — top-level orchestrator entry pointed at one conversation:
    build history, wire tools, run with a controller signal.
  - `AgentLoop` — the executor: manage a transaction with the model, dispatch
    tool calls, stream tokens/tool events, request confirmation for unsafe
    tools.
  - `PlannerLoop` — establishes/executes plan from user's request before
    procedural action.
  - `ToolRegistry` — named tool function dispatcher; validated per-call.
- **Tests**: `Planner.test.ts` (10), `TaskGraph.test.ts` (6),
  `PlannerLoop.test.ts` (4), `AgentLoop.test.ts` (5).

## Key decisions

- **Plan-then-execute**: PlannerLoop produces a plan first; AgentLoop walks it;
  loop iterations are capped (no infinite retries).
- **Streaming events** (`agent.plan`, `agent.step`, `agent.token`,
  `tool.call`, `agent.done`) drive the UI without a second transport.
- **Confirmation**: tools marked unsafe pause the loop until a promise resolves
  (approved/denied), matching the `ConversationService` confirmation broker.

## Acceptance criteria

- [x] A goal becomes a TaskGraph, then an ordered ExecutionPlan
- [x] AgentLoop executes plan steps with real tool calls
- [x] Plan/step/token/tool events stream to the client
- [x] All planner + runtime tests green

## Verification

```bash
pnpm test && pnpm typecheck && pnpm lint
```