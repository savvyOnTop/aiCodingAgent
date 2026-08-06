# Phase 10 — GitWorkspace, Firecracker Workspaces & Hardening

**Status:** ⬜ Not started — `FirecrackerWorkspace.ts` and `GitWorkspace.ts`
are 0-line stubs

## Goal

Top out on isolation and production-readiness: a git-native workspace, a
firecracker microVM backend for real workload isolation, and a hardening pass
over auth, rate-limiting, redaction, and streaming so the agent behaves in
untrusted environments.

## Deliverables

### GitWorkspace (`src/workspace/GitWorkspace.ts`)

- Thin wrapper that materializes a repo (from `root` or a `gitUrl`) into the
  workspace and exposes git-native primitives used by GitTool:
  `commit`, `status`, `diff`, `log`, `branch`, `checkout`.
- Sits *on top of* Local/Docker/Firecracker roots (composition, not a new
  backend); records `branch`/`headSha` in the workspace record for
  rehydration.

### FirecrackerWorkspace (`src/workspace/FirecrackerWorkspace.ts`)

- Implement the third `Workspace` backend (currently throws in
  `WorkspaceManager.create` at `src/workspace/WorkspaceManager.ts:61`).
- Boot a microVM from a base snapshot; `run` executes inside the VM;
  `containerName`-style record becomes a VM id + snapshot id for re-attach.
- Lifecycle discipline: snapshot on `destroy` (state survives), teardown idle
  VMs after a TTL.
- **Rehydration**: `WorkspaceManager.rehydrate` gains a `firecracker` branch
  using the stored VM/snapshot ids (Phase 05 store record already has the
  `kind` column).
- **Tests**: boot → run command → snapshot → re-attach → teardown; gated on a
  `FIRECRACKER_BIN` env var so CI without the tool stays green.

### Hardening

- **Auth & rate limiting**: pre-handle counts per token/IP on RPC endpoints;
  bounded SSE fan-out; per-session connect caps.
- **Redaction audit**: extend the `SECRET_KEY_HINT` redaction (`Conversation
  Service`) to streamed tool output and terminal echoes; blocklist of vars;
  tests that assert secrets never escape.
- **Streaming backpressure**: pause AgentLoop emission when the client is slow
  (token buffer watermark) instead of buffering unboundedly.
- **Error taxonomy in gateway**: standardized `{ code, message, retriable }`
  error body on all routes, mapped from the Phase 05 diagnostics taxonomy.
- **E2E test**: conversation → plan → patch → validate ⇒ green in a docker
  workspace, simulating the full happy path plus a repair iteration.

## Key decisions

- Firecracker is opt-in (`FIRECRACKER_BIN`); local + docker remain defaults so
  the agent works without elevated privileges.
- GitWorkspace composes a root workspace, avoiding a 4th backend that would
  fragment `WorkspaceManager`.
- Hardening is measured: every new control ships with its own test or a
  documented negative test (auth without token → 401 etc.).

## Acceptance criteria

- [ ] GitWorkspace: clone → edit → commit → status from inside a root backend
- [ ] Firecracker: boot → run → snapshot → re-attach → teardown (gated)
- [ ] Rate limiting + authz verified by tests (401 / 429 paths)
- [ ] Redaction covers streamed tool output and terminal
- [ ] Streaming backpressure implemented
- [ ] Full suite green; `pnpm test && pnpm typecheck && pnpm lint`
- [ ] Commit as `M10 completed`

## Verification

```bash
FIRECRACKER_BIN=/path/to/firecracker pnpm test src/workspace && pnpm test && pnpm typecheck && pnpm lint
```