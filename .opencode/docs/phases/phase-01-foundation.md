# Phase 01 — Foundation & Gateway

**Status:** ✅ Done — commit `253dc1b` ("Stage 1")

## Goal

Stand up the monorepo skeleton, the shared type contract, the LLM routing
layer, the HTTP/SSE gateway, an in-memory conversation service, and the React
chat shell so a message can round-trip: browser → gateway → LLM → streamed
response.

## Deliverables

- **Monorepo**: pnpm workspaces with `@ai-coding-agent/types` as the shared
  contract package (`types/`), and the app in `src/`.
- **LLM layer** (`src/llm/`):
  - `ClaudeAdapter`, `GPTAdapter`, `GeminiAdapter`, `OllamaAdapter`,
    `OpenAICompatAdapter`, `OpenRouterAdapter` — provider adapters over a
    common `ModelMessage`/`ToolCall` shape (`types.ts`).
  - `ModelRouter` — picks a model/provider per request with fallback.
- **Gateway** (`src/gateway/`):
  - `routes.ts` — REST endpoints for conversations, history, confirmations,
    file listing.
  - `auth.ts` — bearer-token hook for the API.
  - `streaming.ts` — SSE event stream for `agent.token`, `tool.call`,
    `agent.done` events.
  - `session.ts` — session registry for terminal/SSE identity.
- **Conversation** (`src/conversation/`):
  - `ConversationService` — owns sessions, persists messages, streams runs,
    brokers tool confirmations with timeout.
  - `MessageStore` — in-memory conversation + message store.
- **Frontend** (`src/frontend/`):
  - `App.tsx`, `ChatPanel.tsx`, `FileExplorer.tsx`, `api.ts`, `styles.css` —
    chat UI with streaming token rendering and a file tree.
- **Tests**: `ModelRouter.test.ts`, `routes.test.ts`, `types` tests.

## Key decisions

- SSE chosen over WebSocket for one-way model streaming; WebSocket reserved for
  terminal I/O (Phase 02).
- Secret redaction: env values matching `KEY|TOKEN|SECRET|PASSWORD|AUTH` are
  replaced with `***` before anything leaves the process.
- Tool confirmations are pending-promise based with a 5-minute timeout.

## Acceptance criteria

- [x] `pnpm test` — gateway routes, model router, types green
- [x] `pnpm typecheck` — node + web configs green
- [x] `pnpm lint` green
- [x] Message round-trip works via SSE events

## Verification

```bash
pnpm test && pnpm typecheck && pnpm lint
```
