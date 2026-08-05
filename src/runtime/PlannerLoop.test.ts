import { describe, expect, it, vi } from "vitest";
import type { SseEvent } from "@ai-coding-agent/types";
import { MaxIterationsError } from "../llm";
import { createPlanner } from "../planner";
import { fileTools } from "../tools";
import { createAgentLoop, type AgentInteractions } from "./AgentLoop";
import { createContextLoader } from "./ContextLoader";
import { createPromptBuilder } from "./PromptBuilder";
import { createToolRegistry } from "./ToolRegistry";

const usage = { inputTokens: 1, outputTokens: 1, model: "fake", provider: "fake" };

function makeInteractions(events: SseEvent[]): AgentInteractions {
  return { emit: (e) => events.push(e), requestConfirmation: async () => true };
}

function makeLoop(planRouter: { complete: ReturnType<typeof vi.fn> }, events: SseEvent[], opts: { maxReplans?: number } = {}) {
  const registry = createToolRegistry();
  registry.registerAll(fileTools);
  const loop = createAgentLoop({
    router: planRouter as never,
    registry,
    promptBuilder: createPromptBuilder(),
    contextLoader: createContextLoader(),
    interactions: makeInteractions(events),
    maxIterations: 5,
    planner: createPlanner({ router: planRouter as never }),
    maxReplans: opts.maxReplans
  });
  return { loop, registry };
}

const runInput = {
  task: "ship the thing",
  history: [{ role: "user" as const, content: "ship the thing" }],
  workspace: {
    id: "ws-planner",
    kind: "local" as const,
    rootPath: process.cwd(),
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
  redact: (t: string) => t
};

describe("AgentLoop with planner", () => {
  it("emits a plan and executes tasks in dependency order", async () => {
    const events: SseEvent[] = [];
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ text: '{"plan":[{"title":"Inspect repo"},{"title":"Implement change","dependsOn":[1]}]}', toolCalls: [], usage })
        .mockResolvedValueOnce({ text: "inspected", toolCalls: [], usage })
        .mockResolvedValueOnce({ text: "change ready", toolCalls: [], usage })
    };
    const { loop } = makeLoop(router, events);

    const result = await loop.run(runInput);

    expect(router.complete).toHaveBeenCalledTimes(3);
    expect(events[0]).toEqual({ type: "agent.plan", steps: ["Inspect repo", "Implement change"] });
    expect(result.summary).toBe("inspected\n\nchange ready");
    const taskMessages = result.transcript.filter((m) => m.role === "user" && m.content?.startsWith("[Plan task"));
    expect(taskMessages.map((t) => t.content)).toHaveLength(2);
  });

  it("replans after a task failure and keeps going", async () => {
    const events: SseEvent[] = [];
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ text: '{"plan":[{"title":"Task A"},{"title":"Task B"}]}', toolCalls: [], usage })
        .mockRejectedValueOnce(new MaxIterationsError(5))
        .mockResolvedValueOnce({ text: '{"plan":[{"title":"Retry A"}]}', toolCalls: [], usage })
        .mockResolvedValueOnce({ text: "A fixed", toolCalls: [], usage })
    };
    const { loop } = makeLoop(router, events);

    const result = await loop.run(runInput);

    const planEvents = events.filter((e) => e.type === "agent.plan") as Array<{ steps: string[] }>;
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0]?.steps).toEqual(["Task A", "Task B"]);
    expect(planEvents[1]?.steps).toEqual(["Retry A"]);
    expect(result.summary).toBe("A fixed");
    const revision = result.transcript.find((m) => m.content?.startsWith("[Plan revision]"));
    expect(revision?.content).toMatch(/Task A/);
  });

  it("gives up when replans are exhausted", async () => {
    const events: SseEvent[] = [];
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ text: '{"plan":[{"title":"Task A"}]}', toolCalls: [], usage })
        .mockRejectedValueOnce(new MaxIterationsError(5))
    };
    const { loop } = makeLoop(router, events, { maxReplans: 0 });

    await expect(loop.run(runInput)).rejects.toThrow(/maximum of 5 iterations/);
  });

  it("never emits a plan when no planner is provided", async () => {
    const events: SseEvent[] = [];
    const router = { complete: vi.fn().mockResolvedValue({ text: "plain answer", toolCalls: [], usage }) };
    const registry = createToolRegistry();
    const loop = createAgentLoop({
      router: router as never,
      registry,
      promptBuilder: createPromptBuilder(),
      contextLoader: createContextLoader(),
      interactions: makeInteractions(events),
      maxIterations: 5
    });

    const result = await loop.run(runInput);
    expect(result.summary).toBe("plain answer");
    expect(events.some((e) => e.type === "agent.plan")).toBe(false);
  });
});