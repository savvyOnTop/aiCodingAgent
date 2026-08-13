import { describe, expect, it } from "vitest";
import type { LoadedContext } from "./ContextLoader";
import { createPromptBuilder } from "./PromptBuilder";

function loaded(overrides: Partial<LoadedContext> = {}): LoadedContext {
  return {
    fileTree: "src/\n  a.ts",
    keyFiles: "--- src/a.ts (rank 0) ---\nconst a = 1;",
    index: { "src/a.ts": { rank: 0, score: 14, chars: 40, truncated: false } },
    skippedFiles: 3,
    maxContextChars: 40_000,
    truncatedFileCount: 1,
    ...overrides
  };
}

describe("PromptBuilder", () => {
  it("renders a budget footer when a phase-07 index is present", () => {
    const messages = createPromptBuilder().build({
      task: "fix config",
      context: loaded(),
      tools: [],
      history: [],
      workspaceRootName: "ws-1"
    });

    const contextMessage = messages[1]!.content;
    expect(contextMessage).toContain("File tree:");
    expect(contextMessage).toContain("Relevant files:");
    expect(contextMessage).toMatch(/context: 40 of 40000 chars budget across 1 indexed files/);
    expect(contextMessage).toContain("3 files skipped");
    expect(contextMessage).toContain("1 truncated");
  });

  it("works with legacy context (no index) without a footer", () => {
    const messages = createPromptBuilder().build({
      task: "x",
      context: loaded({ index: {} }),
      tools: [],
      history: [],
      workspaceRootName: "ws-1"
    });

    expect(messages[1]!.content).not.toContain("chars budget");
  });

  it("caps the context message at its own budget", () => {
    const builder = createPromptBuilder({ maxContextChars: 100 });
    const messages = builder.build({
      task: "x",
      context: loaded({
        fileTree: "a\n".repeat(200),
        keyFiles: "content\n".repeat(200),
        index: {}
      }),
      tools: [],
      history: [],
      workspaceRootName: "ws-1"
    });

    expect(messages[1]!.content.length).toBeLessThanOrEqual(200);
    expect(messages[1]!.content).toContain("[context truncated]");
  });

  it("prepends system message and appends history", () => {
    const messages = createPromptBuilder().build({
      task: "t",
      context: loaded(),
      tools: [{ name: "search", description: "find code", inputSchema: {} }],
      history: [{ role: "user", content: "hi" }],
      workspaceRootName: "ws-1"
    });

    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("search: find code");
    expect(messages[2]).toEqual({ role: "user", content: "hi" });
  });
});