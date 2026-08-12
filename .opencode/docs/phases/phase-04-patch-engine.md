# Phase 04 — Patch Engine

**Status:** ✅ Done — commit `2a81aa6` ("M4 completed")

## Goal

Turn model edit requests into safe, reviewable filesystem changes. The agent
must never paste raw blobs blind: it produces structured patches, applies them
atomically, keeps line provenance for later conflict resolution, and offers a
syntactic edit path for precise single-symbol changes.

## Deliverables

- **Patch layer** (`src/patch/`):
  - `PatchEngine` — orchestration: generate a diff for target files, validate
    context lines, run hunks through the conflict resolver, and return an
    apply report (applied / skipped / conflicted).
  - `ApplyPatch` — the core unified-diff applicator: context matching, hunk
    line adjustment after each application, atomic result construction,
    new-file and delete-file support.
  - `ASTEditor` — syntax-aware targeted edits (declaration-level replacements
    with format preservation) used when the model specifies a symbol, not raw
    lines.
  - `ConflictResolver` — merges overlapping hunks; if two patches touch the
    same lines, either auto-merges when compatible or marks the hunk conflicted
    for the loop to repair.
- **Tests**: `Patch.test.ts` (12) covering apply, offset correction, conflicts,
  new files, deletes.

## Key decisions

- Patches are line-based (unified diff) rather than regex-replace: they apply
  at any file state and can be presented to the user in a diff viewer.
- Apply is **transactional**: one file in → one file out; nothing is written
  until the whole patch validates, so a bad hunk never corrupts a file.
- `ASTEditor` is the "gentle" path: a symbol change produces a minimal,
  context-safe edit; it also feeds the ConflictResolver when hunks collide.

## Acceptance criteria

- [x] Valid patches apply with context verification
- [x] Later hunks adjust line numbers after earlier ones apply
- [x] Overlapping edits resolve or flag as conflict, never silently corrupt
- [x] New-file creation and file deletion apply cleanly
- [x] `Patch.test.ts` green (12 tests)

## Verification

```bash
pnpm test src/patch && pnpm typecheck && pnpm lint
```