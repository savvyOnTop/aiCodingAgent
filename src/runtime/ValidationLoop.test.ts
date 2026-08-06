import { describe, expect, it, vi } from "vitest";
import type { ModelCallResult, SseEvent } from "@ai-coding-agent/types";
import { createRepairLoop, createValidationRunner } from "../validation";
import { fileTools } from "../tools";
import { createAgentLoop } from "./AgentLoop";
import { createContextLoader } from "./ContextLoader";
import { createPromptBuilder } from "./PromptBuilder";
import { createToolRegistry } from "./ToolRegistry";

function modelResult(text: string | null, toolCalls: ModelCallResult["toolCalls"] = []): ModelCallResult {
  return {
    text,
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5, model: "fake", provider: "fake" }
  };
}

describe("AgentLoop validation gate", () => {
  it("gates a mutating task on validation and repairs until green", async () => {
    const events: SseEvent[] = [];
    const registry = createToolRegistry();
    registry.registerAll(fileTools);

    let checkRun = 0;
    const files = new Map<string, string>();
    const workspace = {
      id: "ws-val",
      kind: "local" as const,
      rootPath: ".",
      readFile: async (p: string) => {
        if (!files.has(p)) throw new Error(`no ${p}`);
        return files.get(p)!;
      },
      writeFile: async (p: string, c: string) => void files.set(p, c),
      listDir: async () => [],
      runCommand: async () => {
        checkRun += 1;
        if (checkRun === 1) return { exitCode: 1, stdout: "", stderr: "test failed" };
        return { exitCode: 0, stdout: "all green", stderr: "" };
      },
      gitStatus: async () => ({ branch: "", modified: [], untracked: [] }),
      gitDiff: async () => "",
      destroy: async () => {}
    };

    const loop = createAgentLoop({
      router: {
        complete: vi
          .fn()
          .mockResolvedValueOnce(
            modelResult(null, [{ id: "c1", name: "write_file", input: { path: "v.txt", content: "x" } }])
          )
          .mockResolvedValueOnce(modelResult("first answer", []))
          .mockResolvedValueOnce(modelResult("fixed", []))
      } as never,
      registry,
      promptBuilder: createPromptBuilder(),
      contextLoader: createContextLoader(),
      interactions: { emit: (e) => events.push(e), requestConfirmation: async () => true },
      maxIterations: 5,
      validation: createRepairLoop({ validation: createValidationRunner({ test: { command: "vitest run" } }) })
    });

    const result = await loop.run({
      task: "make v.txt",
      history: [{ role: "user", content: "make v.txt" }],
      workspace,
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    expect(files.get("v.txt")).toBe("x");
    expect(checkRun).toBe(2);
    const validation = events.filter((e) => e.type === "agent.validation") as Array<{ checker: string; status: string }>;
    expect(validation).toHaveLength(2);
    expect(validation[0]?.status).toBe("failed");
    expect(validation[1]?.status).toBe("passed");
    expect(result.summary).toBe("fixed");
  });

  it("does not gate read-only tasks", async () => {
    const events: SseEvent[] = [];
    const seen: string[] = [];
    const loop = createAgentLoop({
      router: {
        complete: vi.fn().mockResolvedValue({ text: "answer", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, model: "f", provider: "f" } })
      } as never,
      registry: createToolRegistry(),
      promptBuilder: createPromptBuilder(),
      contextLoader: createContextLoader(),
      interactions: { emit: (e) => events.push(e), requestConfirmation: async () => true },
      maxIterations: 5,
      validation: createRepairLoop({
        validation: {
          enabled: () => true,
          validate: async () => {
            seen.push("validated");
            return [];
          }
        }
      })
    });

    const result = await loop.run({
      task: "hello",
      history: [],
      workspace: {
        id: "ws-x",
        kind: "local" as const,
        rootPath: ".",
        readFile: async () => "",
        writeFile: async () => {},
        listDir: async () => [],
        runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        gitStatus: async () => ({ branch: "", modified: [], untracked: [] }),
        gitDiff: async () => "",
        destroy: async () => {}
      },
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    expect(result.summary).toBe("answer");
    expect(seen).toHaveLength(0);
  });
});