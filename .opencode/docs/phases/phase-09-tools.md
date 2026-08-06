# Phase 09 — Full Tool Suite

**Status:** 🟡 Partial — six tool files exist; `BrowserTool` is a 0-line stub and
`SearchTool` is a shallow glob wrapper

## Goal

Make the agent genuinely handy: a strong code-search index, a real browser for
web/repo research, richer diagnostics, and a permission-classified tool surface
so the runtime knows what deserves confirmation. Today every tool lives in
`src/tools/` next to a slim `ToolRegistry` — Phase 09 hardens and completes it.

## Current state

| Tool | Status | Notes |
|------|--------|-------|
| `FileTool` (69 ln) | ✅ | read/write/list/create with safe-paths guards |
| `GitTool` (52 ln) | 🟡 | commit/status/diff/log — add branch ops later |
| `TerminalTool` (29 ln) | ✅ | workspace `run` wrapper with output caps |
| `SearchTool` (35 ln) | 🟡 | shallow glob/keyword search only |
| `DiagnosticsTool` (26 ln) | 🟡 | naive string matches; no error taxonomy |
| `BrowserTool` (0 ln) | ⬜ | not implemented |

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

- [ ] Code search returns ranked, ignore-respecting results with snippets
- [ ] BrowserTool navigates and extracts markdown against a fixture page
- [ ] Diagnostics classify errors into the RepairLoop error taxonomy
- [ ] Permission flags gate write/git/terminal tools in AgentLoop
- [ ] All new tests green; full suite + typecheck + lint
- [ ] Commit as `M9 completed`

## Verification

```bash
pnpm test src/tools src/runtime && pnpm test && pnpm typecheck && pnpm lint
```