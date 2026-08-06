# Phase 02 — Workspaces & Terminal

**Status:** ✅ Done — commit `4e8c6fa` ("Stage 2")

## Goal

Give each conversation a sandboxed filesystem and a live terminal. This is the
layer that keeps agent actions off the host: every command runs inside an
isolated workspace (local dir or Docker container), and the browser gets a real
interactive shell via a WebSocket bridge.

## Deliverables

- **Workspace layer** (`src/workspace/`):
  - `WorkspaceManager` — routes session creation to a backend, owns lifecycle
    (`create`/`get`/`destroy`/`destroyAll`).
  - `LocalWorkspace` — runs commands in a local scratch dir; `readFile`,
    `writeFile`, `listDir`, `execute`, `gitStatus`.
  - `DockerWorkspace` — `docker run` + `docker exec sh -lc` backend with
    command-timeout and output truncation guards.
- **Gateway terminal** (`src/gateway/terminal.ts`): `node-pty` → WebSocket
  bridge, token-authenticated, keyed to a session.
- **Frontend terminal** (`src/frontend/Terminal.tsx`): xterm.js with a Fit
  addon wired to the WS bridge.
- **Types**: `Workspace` contract added to `types/`.
- **Tests**: `LocalWorkspace.test.ts`, `DockerWorkspace.test.ts`,
  `terminal.test.ts`.

## Key decisions

- `Workspace` is an interface (listDir/readFile/writeFile/run/gitStatus) so
  backends are swappable; `WorkspaceManager` holds a map of `id → Workspace`.
- Docker commands are capped (`MAX_COMMAND_CHARS`, `MAX_OUTPUT`) and map
  non-zero exits / timeouts to a `CommandResult { exitCode, stdout, stderr }`.
- Terminal auth reuses the API bearer token; the pty is owned by the session.

## Acceptance criteria

- [x] Workspaces create/destroy cleanly in both local and docker modes
- [x] Interactive shell works in the browser over WS
- [x] Command failures surface with exit codes, not exceptions
- [x] All tests green (docker tests gated on docker availability)

## Verification

```bash
pnpm test && pnpm typecheck && pnpm lint
```