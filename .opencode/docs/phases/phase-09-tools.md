# Phase 09 — Full Tool Suite

**Status:** ✅ Done (`c608be4`, M9 completed)

## Goal

Make the agent genuinely handy: a strong code-search index, a real browser for
web/repo research, richer diagnostics, and a permission-classified tool surface
so the runtime knows what deserves confirmation. Today every tool lives in
`src/tools/` next to a slim `ToolRegistry` — Phase 09 hardens and completes it.

## Current state

| Tool | Status | Notes |
|------|--------|-------|
| `FileTool` | ✅ | read/write/list; `write_file` confirm-gated + destructive-flagged |
| `GitTool` | ✅ | commit/status/diff; `git_commit` destructive-flagged |
| `TerminalTool` | ✅ | workspace `run` wrapper; destructive-flagged |
| `SearchTool` | ✅ | `search_code`/`search_symbol`/`search_imports`, rg --json + grep fallback |
| `DiagnosticsTool` | ✅ | `classify_failure` taxonomy + `attach_snippet` slices |
| `BrowserTool` | ✅ | `browser_open`/`browser_extract`/`browser_crawl`, markdown-first |

## Remaining deliverables

- **SearchTool → semantic-ready code search**:
  - `search.symbol(query)` — index-free symbol scan (regex for
    `function|class|const|export` etc.) with file:line results.
  - `search.code(query)` — ripgrep-backed (`rg --json`) running inside the
    workspace docker/local root, with ignore rules and max-results caps.
  - `search.imports(module)` — returns dependents of a module via the Phase 07
    import graph when available.
  - Result shape: `{ file, line, column, text, score }[]` usable by the model
    and the FileExplorer UI.
- **BrowserTool** — headless research: `open(url)`, `crawl(page, maxDepth)`,
  `extract(selector)`, `q` — return markdown pages while redacting `AUTH`/
  `TOKEN` headers and never leaking env. Docker-gated where network isolation
  matters (optional flag).
- **DiagnosticsTool** — structured taxonomization of command failures:
  - Classify (compile error / test failure / lint violation / runtime panic /
    network / timeout) and extract the first actionable message + file:line so
    RepairLoop (Phase 05) quotes precise failures.
  - `attach(file, line, col)` slice extraction for the editor.
- **ToolRegistry wiring** (`src/runtime/ToolRegistry.ts`): register the full
  suite; tool metadata gains `{ destructive, needsConfirmation }` flags;
  AgentLoop surfaces the flag during threat-confirmation so `FileTool.write`,
  `GitTool.commit`, and `TerminalTool` still require human confirmation while
  read-only search stays safe.
- **UI**: FileExplorer "search results" panel; DiagnosticsTool output shown in
  the diff/status area.
- **Tests**: search symbol/code/imports; browser content extraction against a
  local fixture server; diagnostics classification fixtures; registry
  permission flags flow through AgentLoop confirmation.

## Key decisions

- All host-side execution stays inside the workspace boundary (local root or
  container) — `SearchTool`, `TerminalTool` never touch the host FS.
- Browser is headless + markdown-first (reduce token cost); raw HTML only on
  explicit request.
- Permission flags are data (`{ tool, permission }`), not hardcoded if-chains,
  so new tools inherit confirmations automatically.

## Acceptance criteria

- [x] Code search returns ranked, ignore-respecting results with snippets
- [x] BrowserTool navigates and extracts markdown against a fixture page
- [x] Diagnostics classify errors into the RepairLoop error taxonomy
- [x] Permission flags gate write/git/terminal tools in AgentLoop
- [x] All new tests green; full suite + typecheck + lint
- [x] Commit as `M9 completed` (`c608be4`)

## Verification

```bash
pnpm test src/tools src/runtime && pnpm test && pnpm typecheck && pnpm lint
```