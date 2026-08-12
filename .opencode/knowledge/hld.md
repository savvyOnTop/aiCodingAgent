# AI Coding Agent — High-Level Design (HLD)

## 1. Overview

**Purpose.** An AI coding agent that takes a natural-language goal, plans it,
edits code in a sandboxed workspace, runs build/test/lint, repairs failures,
and reports results through a streaming web UI.

**Guiding principles.**

- **Isolation-first** — all agent side effects run inside a workspace
  (local root, Docker container, later Firecracker microVM), never on the host.
- **Confirm-what-is-destructive** — read-only actions are free; writes, commits,
  and terminals require human confirmation.
- **Plan → act → validate → repair** — the core loop, bounded at every stage.
- **Secrets never leave the process** — env-derived secrets are redacted in all
  streams (SSE, tool output, terminal).
- **Everything model-visible is structured** — context, patches, validation
  results, and errors are shaped so the model can act on them.

---

## 2. Logical architecture (layered)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND (React SPA)                                                          │
│  App · ChatPanel · Editor · DiffViewer · Terminal · FileExplorer · api.ts      │
│  renders: streamed tokens · plan/steps · tool events · confirm dialogs ·       │
│  xterm (WS) · file tree · patch diff review                                    │
└───────┬───────────────────────────┬────────────────────────────┬──────────────┘
        │ REST (control)            │ SSE (model events)         │ WS (terminal)
        │ conversations · history · │ agent.plan · agent.step ·  │ pty I/O
        │ confirm · terminate ·     │ agent.token · tool.call ·  │
        │ listFiles                 │ agent.done                 │
┌───────▼───────────────────────────▼────────────────────────────▼──────────────┐
│  GATEWAY (Fastify)                                                            │
│  routes.ts · auth.ts · streaming.ts · session.ts · terminal.ts (node-pty)     │
│  bearer-token auth · SSE fan-out · session registry · WS→pty bridge ·         │
│  confirmation broker (approve / deny / 5-min timeout)                         │
└───────┬───────────────────────────────────────────────────────────────────────┘
        │ streamMessage · confirm · terminate · destroy · listFiles
┌───────▼───────────────────────────────────────────────────────────────────────┐
│  APPLICATION                                                                  │
│  conversation : ConversationService · MessageStore · BranchService* ·         │
│                 MemoryService*                                                │
│  runtime      : AgentRuntime · AgentLoop · PlannerLoop · PromptBuilder ·      │
│                 ContextLoader · ToolRegistry · ValidationLoop                 │
│  planner      : Planner → TaskGraph → ExecutionPlan                           │
│  loop         : task → context → plan → act → patch → validate → repair(6)   │
└──────────┬───────────────────────────────┬────────────────────────┬──────────┘
           │ tool calls / results          │ patch · validation     │ model calls
           ▼                               ▼                        ▼
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  TOOLS                │   │  PATCH + VALIDATION   │   │  LLM                  │
│  FileTool · GitTool · │   │  PatchEngine→Apply    │   │  ModelRouter          │
│  TerminalTool ·       │   │  Patch · ASTEditor ·  │   │  (fallback)           │
│  SearchTool ·         │   │  ConflictResolver     │   │  ClaudeAdapter · GPT  │
│  BrowserTool ·        │   │  Build/Test/Lint →    │   │  Gemini · Ollama ·    │
│  DiagnosticsTool      │   │  ValidationRunner →   │   │  OpenAICompat ·       │
│  rw tools = confirm   │   │  RepairLoop (bounded) │   │  OpenRouter           │
└──────────┬────────────┘   └──────────┬───────────┘   └──────────┬───────────┘
           │ run in workspace          │ apply patches · validate │ ↓ request
           │                           │ validate in workspace   │ ↑ response
           ▼                           ▼
┌──────────▼──────────────────────────▼───────────────────────────────────────┐
│  WORKSPACE — isolation boundary (nothing escapes to the host)                │
│  WorkspaceManager: create · get · destroy · destroyAll · rehydrate(records) │
│  LocalWorkspace · DockerWorkspace · GitWorkspace* · FirecrackerWorkspace*   │
└───────┬───────────────────────────────────────────────▲───────────────────────┘
        │ read/write/run (files & commands)             │ re-attach on boot
        ▼                                               ▼
┌───────▼───────────────────────────────────────────────▼───────────────────────┐
│  PERSISTENCE (node:sqlite · WAL · sync interface = drop-in MessageStore)      │
│  SqliteStore: conversations · messages · workspaces                            │
│  ConversationRepository · TraceRepository · EmbeddingRepository ·             │
│  CacheRepository (phase 06)                                                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

`*` = planned in phases 06–10 (see `.opencode/docs`). Every egress path (SSE,
terminal, tool output) passes through the redaction filter; every route passes
through bearer-token auth.

### 2.1 Key data flows

1. **Control (REST)** — create conversation, send message, approve/deny tool
   confirmation, terminate run, list history/files: browser → gateway routes →
   `ConversationService`.
2. **Model streaming (SSE)** — `agent.plan` / `agent.step` / `agent.token` /
   `tool.call` / `tool.result` / `agent.done` fan out to the browser; confirm
   dialogs are driven by `tool.call` events and answered via REST.
3. **Terminal (WS)** — xterm in the browser ↔ `gateway/terminal.ts` ↔
   `node-pty` spawned in the workspace workdir.
4. **Agent loop** — `ContextLoader` context → `Planner` → `TaskGraph` →
   `ExecutionPlan` → `AgentLoop` dispatches tool calls through `ToolRegistry`;
   destructive tools (write/commit/terminal) block on human confirmation
   (5-min timeout in `ConversationService`).
5. **Edit path** — model patches → `PatchEngine` → `ApplyPatch` / `ASTEditor` /
   `ConflictResolver` → `Workspace.writeFile` inside the sandbox.
6. **Validation & repair** — `BuildRunner`/`TestRunner`/`LintRunner` →
   `ValidationRunner` in the workspace; on failure `RepairLoop` sends the
   structured failure summary back to the model for a new patch, bounded by
   `maxBuildAttempts`.
7. **Isolation** — every tool command executes via `Workspace.run` inside the
   local/docker root; outputs are truncated and redacted before reaching the
   model or the browser.
8. **Persistence** — conversations/messages/workspaces via `SqliteStore`;
   repositories (phase 06) for cache/embeddings/traces; `rehydrate(records)`
   re-attaches live workspaces on boot.
9. **Cross-cutting** — env-secret redaction on every exported path · bearer
   token auth at the gateway · iteration caps in planner, agent loop, and
   repair loop.

---

## 3. Component design

### 3.1 Frontend (`src/frontend`)

React SPA talking to the gateway over REST + SSE + WS.

| Component | Responsibility |
|---|---|
| `App` | Layout: panel routing, session-level state |
| `ChatPanel` | Message list, streaming token rendering, confirmation prompts (`tool.call`), send |
| `Editor` | File edit view (planned phase) |
| `DiffViewer` | Render patch engine output (planned phase) |
| `Terminal` | xterm.js + `@xterm/addon-fit`, WS bridge to pty |
| `FileExplorer` | Tree + file listing via conversation file routes |
| `api.ts` | Typed gateway client (fetch over REST, EventSource over SSE) |

### 3.2 Gateway (`src/gateway`)

Fastify server. Auth via `authHook` (bearer token, optional). Registers
`registerRoutes` + `registerTerminal`.

- `routes.ts` — conversations CRUD, `POST /conversations/:id/messages` (SSE
  streaming), confirmation approve/deny, terminate, file listing.
- `streaming.ts` — SSE transport: bridges server-side events to HTTP.
- `session.ts` — session registry shared by routes + terminal.
- `terminal.ts` — `node-pty` process bound to a workspace, bridged over WS,
  token-authenticated, per-session.

### 3.3 Conversation layer (`src/conversation`)

- `ConversationService` — facade over runtime + storage: `create`, `list`,
  `streamMessage` (append user msg, build history, orchestrate agent run with
  confirm/abort), `confirm`, `terminate`, `history`, `listFiles`, `destroy`.
  Holds the pending-confirmation promise map (5 min timeout) and abort
  controllers.
- `MessageStore` — `ConversationRecord[]` / `MessageRecord[]` store; in-memory
  default, `SqliteStore` implements the same sync interface for persistence.
- `BranchService` / `MemoryService` — phase 08 (stubs today).

### 3.4 Runtime (`src/runtime`)

The agent's reasoning core.

- `AgentRuntime` — entry/policy: wires a conversation to an `AgentLoop` run,
  supplies history, redaction, abort signal.
- `AgentLoop` — model↔tool transaction: emits `agent.token` / `tool.call` /
  `tool.result` events; requests confirmation for destructive `ToolDefinition`
  calls; terminates on budget (`maxIterations`).
- `PlannerLoop` — calls Planner before any step; verifies the step until
  compliant.
- `PromptBuilder` — model prompt: system card + tools schema (Llama‑Tool‑Call
  format) + conversation transcript; optional memory block (phase 08).
- `ContextLoader` — repo context: shallow tree + manifest key files; deep
  load in phase 07.
- `ToolRegistry` — centralized tool function dispatch + metadata, validated
  per-call.
- `ValidationLoop` — auto-run after patches (phase 05).
- Budget guards — iteration caps and error taxonomy for the loop.

### 3.5 Planner (`src/planner`)

- `Planner` — asks the model for a `TaskGraph` JSON with bounded re-try.
- `TaskGraph` — DAG of tasks (deps, status), topological iteration, cycle
  avoidance.
- `ExecutionPlan` — linearized ordered steps derived from the graph;
  `Progress` per step for the UI.

### 3.6 Tools (`src/tools`)

Tools are impure command/query functions; each pulled into `ToolRegistry` with
a name, description, input schema, and permission metadata.

| Tool | Purpose |
|---|---|
| `FileTool` | read / write / list / delete within workspace root |
| `GitTool` | status / diff / commit / log inside workspace |
| `TerminalTool` | run shell command in workspace, apply result caps |
| `SearchTool` | symbolic + ripgrep-backed code search (phase 09) |
| `BrowserTool` | headless fetch/extract (phase 09) |
| `DiagnosticsTool` | classify command failures into repair taxonomy (phase 09) |

### 3.7 Patch + Validation (the edit loop)

- `PatchEngine` — orchestrates a `PatchRequest[]`: for each file, normalize
  hunks, validate (context match), run conflict resolution, mark applied/skipped/
  conflicted, return a `PatchReport`.
- `ApplyPatch` — unified-diff applicator: header parsing, context matching,
  hunk line offset adjustment, transactionality (message stream produced only
  when the whole patch is valid).
- `ASTEditor` — syntactic edits (declaration-level) when the model specifies a
  symbol instead of lines.
- `ConflictResolver` — merges overlapping hunks or flags `conflicted`.
- `BuildRunner`/`TestRunner`/`LintRunner` → `ValidationRunner` runs
  build/test/lint in the workspace and returns `{ name, command, exitCode,
  stdout, stderr }` per command.
- `RepairLoop` — on failure, `AgentPatchRequest` via model, apply, re-validate;
  bounded (`maxBuildAttempts`).

### 3.8 Workspace (`src/workspace`)

Common contract (interface):

```ts
interface Workspace {
  id: string; kind: "local" | "docker" | "firecracker";
  listDir(path): FileEntry[];  readFile(rel): string;
  writeFile(rel, content, errCb): void;
  exists(rel): boolean; run(command, opts): CommandResult;
  gitStatus(): GitStatus; destroy(): Promise<void>;
}
```

- `WorkspaceManager` — backend selection on `create`, in-memory registry,
  `destroy`/`destroyAll`, and `rehydrate(records)` to re-attach persisted
  workspaces after restart (docker attach, local mkdir; firecracker in
  phase 10).
- `LocalWorkspace` — runs in a real scratch dir; `run` with env override.
- `DockerWorkspace` — container via `createContainer` + `exec` `sh -lc`,
  maps to `CommandResult` (exitCode/stdout/stderr, truncation caps).

### 3.9 Persistence (`src/persistence`)

- `SqliteStore` — `node:sqlite` `DatabaseSync`; tables `conversations`,
  `messages`, `workspaces`; implements both `MessageStore` and
  `WorkspaceStoreRecord` CRUD; WAL. Synchronous (matches in-memory API) so it
  drops into `ConversationService` unchanged.
- Repos (phase 06): `ConversationRepository`, `TraceRepository`,
  `EmbeddingRepository`, `CacheRepository`.

### 3.10 LLM (`src/llm`)

Stateless adapters over a common chat/tool type.

| Adapter | Provider |
|---|---|
| `ClaudeAdapter` | Anthropic |
| `GPTAdapter` | OpenAI GPT |
| `GeminiAdapter` | Google Gemini |
| `OllamaAdapter` | Local Ollama |
| `OpenAICompatAdapter` | Any OpenAI-compatible endpoint |
| `OpenRouterAdapter` | OpenRouter meta-provider |

`ModelRouter` — per-message model resolution, warmup, failure fallback
(attempts → emit error). `ModelRouter` test asserts fallbacks.

---

## 4. Runtime flows

### 4.1 Message round-trip (happy path)

1. User `POST /conversations/:id/messages` with `{ content }`.
2. `ConversationService.streamMessage` stores the user message, loads stored
   history → `ChatMessage[]`, creates an `AbortController`, derives `redact`.
3. `AgentRuntime.run({ task, history, workspace, sessionId, cwd, redact },
   { emit, requestConfirmation })` invoked with `AbortSignal`.
4. `PlannerLoop` establishes a plan (Planner → TaskGraph → ExecutionPlan);
   `AgentLoop` iterates, emitting `agent.token` chunks and dispatching tool
   calls via `ToolRegistry`; destructive calls block on `requestConfirmation`
   (which the gateway surfaces as an SSE `tool.call` + `confirm` channel).
5. On completion, transcript append + `agent.done` SSE + store flush.

### 4.2 Tool execution & workspace isolation

1. `AgentLoop` takes a `ToolCall` → `ToolRegistry.execute`.
2. Tool commands are passed to `Workspace.run` → docker `docker exec sh -lc` /
   local spawn, in the workspace root; outputs capped
   (`MAX_COMMAND_CHARS`, `MAX_OUTPUT`).
3. Output redacted (env secrets) then returned as the tool result message.

### 4.3 Patch → validation → repair

1. `PatchEngine` applies model-generated patches to workspace files
   (`writeFile`).
2. `RepairLoop` runs validation commands; structured failure summary fed to
   the model with error taxonomy.
3. Repeat until green or `maxAttempts`; final result → summary + `agent.done`

### 4.4 Terminal

Browser xterm → WS → `gateway/terminal.ts` → `node-pty.spawn(shell)` in the
workspace workdir; output streamed back over WS. Token-gated.

---

## 5. Data model

```
conversations            messages
  id         PK            id          PK
  workspace_id NOT NULL    conversation_id FK (CASCADE)
  created_at               role        TEXT
  branch_id                content
  parent_id                tool_calls  TEXT JSON
                           seq         created_at

workspaces
  id PK, kind, root, container_name, created_at

(phase 06 repositories: cache, traces, embeddings)
```

`MessageRecord`: `{ id, conversationId, role, content, toolCalls, createdAt }`
`ConversationRecord`: `{ id, workspaceId, createdAt, branchId, parentId }`

---

## 6. LLM tool-call contract

Tool calls flow through the community `"tool_call"` message shape (OpenAI
function-call JSON): `{ tool, args, id }`. `PromptBuilder` renders tools in the
system‑prompt section; `AgentRuntime` parses them per provider format. See
`src/runtime/PromptBuilder.ts` + `src/llm/types.ts`.

---

## 7. Non-functional requirements

| Concern | Approach |
|---|---|
| Isolation | Workspace-local execution only; `root` jail for file/terminal tools; host shell never invoked directly |
| Security / auth | Bearer token hook on all routes + terminal (`.env` `PORT`/token) |
| Redaction | env values matching `KEY|TOKEN|SECRET|PASSWORD|AUTH` replaced with `***` in ALL exported text paths (SSE, terminal, tool output) |
| Observability | Per-command structured results; trace repository (phase 06) |
| Reliability | Planner/loop iteration caps; repair-loop caps; confirmation timeouts; agent loop abort (`AbortController`) |
| Performance | SSE streaming (no HTTP poll); WS for terminal; workspace `run` output capping; SQLite WAL |
| Extensibility | `Workspace`/`ModelAdapter`/`ToolDefinition` interfaces → new backends/providers/tools |

---

## 8. Deployment & runtime

- **Build**: `pnpm dev:server` (tsx w/ `.env`), `pnpm dev:web` (vite),
  `pnpm build:web` (tsc + vite).
- **Runtime**: single Fastify process; terminal in-process pty; SSE streamed
  over keep-alive.
- **Env**: `.env.example` documents `PORT`, provider keys, model ids, docker
  image hints.
- **CI**: `pnpm test` (vitest), `pnpm typecheck` (node + web configs),
  `pnpm lint` (eslint). All landmark commits pass all three.

---

## 9. Milestone mapping

Implemented / planned milestones mapped to layers:

| Phase | Layer(s) | Status |
|---|---|---|
| 01 Foundation | frontend, gateway, conversation, llm | ✅ `253dc1b` |
| 02 Workspaces+Terminal | workspace, terminal | ✅ `4e8c6fa` |
| 03 Planning | planner, runtime | ✅ `bcc5fa7` |
| 04 Patch | patch | ✅ `2a81aa6` |
| 05 Validation+Repair | validation, runtime | ✅ `f867d3b` |
| 06 Persistence | persistence, gateway, llm | ✅ `87901e8` |
| 07 Deep context | runtime | ⬜ |
| 08 Branching+Memory | conversation | ⬜ |
| 09 Tools | tools | 🟡 partial |
| 10 Firecracker+Git | workspace | ⬜ |

Phase-by-phase plans: see `.opencode/docs/implementation-plan.md` and
`.opencode/docs/phases/`.