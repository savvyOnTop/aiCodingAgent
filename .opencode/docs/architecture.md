
├── frontend/
│
│   ├── app.tsx
│   ├── ChatPanel.tsx
│   ├── Editor.tsx
│   ├── DiffViewer.tsx
│   ├── Terminal.tsx
│   └── FileExplorer.tsx
│
├── gateway/
│
│   ├── routes.ts
│   ├── auth.ts
│   ├── streaming.ts
│   └── session.ts
│
├── conversation/
│
│   ├── ConversationService.ts
│   ├── MessageStore.ts
│   ├── BranchService.ts
│   └── MemoryService.ts
│
├── runtime/
│
│   ├── AgentRuntime.ts
│   ├── PromptBuilder.ts
│   ├── ToolRegistry.ts
│   ├── ContextLoader.ts
│   └── AgentLoop.ts
│
├── planner/
│
│   ├── Planner.ts
│   ├── TaskGraph.ts
│   └── ExecutionPlan.ts
│
├── tools/
│
│   ├── FileTool.ts
│   ├── GitTool.ts
│   ├── TerminalTool.ts
│   ├── SearchTool.ts
│   ├── BrowserTool.ts
│   └── DiagnosticsTool.ts
│
├── workspace/
│
│   ├── WorkspaceManager.ts
│   ├── GitWorkspace.ts
│   ├── DockerWorkspace.ts
│   ├── FirecrackerWorkspace.ts
│   └── LocalWorkspace.ts
│
├── patch/
│
│   ├── PatchEngine.ts
│   ├── ApplyPatch.ts
│   ├── ASTEditor.ts
│   └── ConflictResolver.ts
│
├── validation/
│
│   ├── BuildRunner.ts
│   ├── TestRunner.ts
│   ├── LintRunner.ts
│   └── RepairLoop.ts
│
├── persistence/
│
│   ├── ConversationRepository.ts
│   ├── TraceRepository.ts
│   ├── EmbeddingRepository.ts
│   └── CacheRepository.ts
│
└── llm/
    ├── ClaudeAdapter.ts
    ├── GPTAdapter.ts
    └── ModelRouter.ts 
