# Phase 05 — Validation & Repair Loop

**Status:** ✅ Done — uncommitted (working tree)

## Goal

Close the loop: after the agent edits code, the system must prove the change is
sound (builds, tests, lints) and, when it is not, feed the failure back to the
model for repair — iterating until green or giving up after N attempts.

## Deliverables

- **Validation layer** (`src/validation/`):
  - `ValidationRunner` — runs a suite of runner steps against the workspace and
    produces a pass/fail summary with captured output.
  - `Runners` — wires up the concrete checkers:
    - `BuildRunner` (phase 05 placeholder in `Runners.ts`; dedicated file in
      Phase 05 completion — see note) — executes the project build command.
    - `TestRunner` — executes the test command.
    - `LintRunner` — executes the lint command.
  - `RepairLoop` — given a failure summary, asks the model for a patch, applies
    it through the PatchEngine, re-validates; caps iterations.
- **Runtime hook**: `ValidationLoop` — after AgentLoop finishes a task,
  validation runs automatically and its output is fed back into the loop.
- **Tests**: `Validation.test.ts` (8), `ValidationLoop.test.ts` (2).

> Note: `BuildRunner.ts`, `TestRunner.ts`, `LintRunner.ts` exist as thin
> `CommandRunner` factories today via `Runners.ts`; if dedicated per-command
> logic (artifacts, retry, coverage parsing) is wanted, it lands in Phase 06.

## Key decisions

- Validation output is **structured** (per-command `{ name, command, exitCode,
  stdout, stderr }`) so the RepairLoop can quote failures to the model instead
  of dumping raw output.
- The repair loop is bounded (`MAX_REPAIR_ATTEMPTS`) and terminates with a
  summary when validation finally passes — mirroring AgentLoop's iteration cap.
- Validation always runs in the workspace (docker or local), never on the host.

## Acceptance criteria

- [x] Build/test/lint commands run per-workspace with captured results
- [x] Failure summaries feed the repair prompt
- [x] Repair loop applies model patches and re-validates, bounded
- [x] `Validation.test.ts` + `ValidationLoop.test.ts` green

## Verification

```bash
pnpm test src/validation src/runtime && pnpm typecheck && pnpm lint
```

## Next step

Commit this phase (`M5 completed`), then proceed to Phase 06.