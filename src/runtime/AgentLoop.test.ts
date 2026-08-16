import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelCallResult, SseEvent } from "@ai-coding-agent/types";
import type { ModelAdapter } from "../llm";
import { fileTools, terminalTool } from "../tools";
import { createLocalWorkspace } from "../workspace";
import { createAgentLoop, type AgentInteractions } from "./AgentLoop";
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

function scriptedAdapter(turns: Array<() => ModelCallResult>): ModelAdapter {
  let i = 0;
  return {
    provider: "fake",
    model: "fake",
    isConfigured: () => true,
    complete: async () => turns[Math.min(i++, turns.length - 1)]!()
  };
}

async function makeLoop(router: ModelAdapter, interactions: AgentInteractions) {
  const registry = createToolRegistry();
  registry.registerAll([...fileTools, terminalTool]);
  const loop = createAgentLoop({
    router: router as never,
    registry,
    promptBuilder: createPromptBuilder(),
    contextLoader: createContextLoader(),
    interactions,
    maxIterations: 5
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "aca-loop-"));
  const ws = createLocalWorkspace({ id: "ws-loop", root });
  return { loop, ws, root, registry };
}

describe("AgentLoop", () => {
  it("executes tool calls then returns the final answer", async () => {
    const events: SseEvent[] = [];
    const interactions: AgentInteractions = {
      emit: (e) => events.push(e),
      requestConfirmation: async () => true
    };
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(modelResult(null, [{ id: "c1", name: "write_file", input: { path: "hello.txt", content: "hi" } }]))
        .mockResolvedValueOnce(modelResult("all done", []))
    };
    const { loop, ws, root, registry } = await makeLoop(router as never, interactions);
    registry.registerAll(fileTools);

    const result = await loop.run({
      task: "write hello.txt",
      history: [{ role: "user", content: "write hello.txt" }],
      workspace: ws,
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi");
    expect(events.map((e) => e.type)).toEqual([
      "agent.tool_start",
      "agent.confirm_request",
      "agent.tool_result",
      "agent.text_delta"
    ]);
    expect(result.summary).toBe("all done");
    expect(result.transcript.at(-1)?.content).toBe("all done");
    await rm(root, { recursive: true, force: true });
  });

  it("gates dangerous tools behind confirmation", async () => {
    const events: SseEvent[] = [];
    const interactions: AgentInteractions = {
      emit: (e) => events.push(e),
      requestConfirmation: vi.fn(async () => false)
    };
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(modelResult(null, [{ id: "c1", name: "run_command", input: { command: "touch pwned.txt" } }]))
        .mockResolvedValueOnce(modelResult("ok", []))
    };
    const { loop, ws, root, registry } = await makeLoop(router as never, interactions);
    registry.registerAll([terminalTool]);

    const result = await loop.run({
      task: "run it",
      history: [{ role: "user", content: "run it" }],
      workspace: ws,
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    expect(interactions.requestConfirmation).toHaveBeenCalledOnce();
    expect(events.filter((e) => e.type === "agent.tool_result")).toHaveLength(1);
    expect(events.find((e) => e.type === "agent.tool_result")?.output).toMatch(/denied/i);
    await expect(readFile(path.join(root, "pwned.txt"), "utf8")).rejects.toThrow();
    expect(result.summary).toBe("ok");
    await rm(root, { recursive: true, force: true });
  });

  it("gates write_file behind confirmation via its permission flag", async () => {
    const events: SseEvent[] = [];
    const interactions: AgentInteractions = {
      emit: (e) => events.push(e),
      requestConfirmation: vi.fn(async () => false)
    };
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(modelResult(null, [{ id: "c1", name: "write_file", input: { path: "no.txt", content: "x" } }]))
        .mockResolvedValueOnce(modelResult("ok", []))
    };
    const { loop, ws, root, registry } = await makeLoop(router as never, interactions);

    await loop.run({
      task: "write it",
      history: [{ role: "user", content: "write it" }],
      workspace: ws,
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    expect(interactions.requestConfirmation).toHaveBeenCalledOnce();
    await expect(readFile(path.join(root, "no.txt"), "utf8")).rejects.toThrow();
    const flags = registry.permissions().find((p) => p.tool === "write_file");
    expect(flags).toEqual({ tool: "write_file", destructive: true, needsConfirmation: true });
    const readFlags = registry.permissions().find((p) => p.tool === "read_file");
    expect(readFlags).toEqual({ tool: "read_file", destructive: false, needsConfirmation: false });
    await rm(root, { recursive: true, force: true });
  });

  it("feeds tool results back into history", async () => {
    const seen: ChatMessage[][] = [];
    const adapter = scriptedAdapter([
      () => modelResult(null, [{ id: "c1", name: "write_file", input: { path: "x.txt", content: "y" } }]),
      () => modelResult("done", [])
    ]);
    const registry = createToolRegistry();
    registry.registerAll(fileTools);
    const loop = createAgentLoop({
      router: {
        complete: async (params: Parameters<ModelAdapter["complete"]>[0]) => {
          seen.push(params.messages);
          return adapter.complete(params);
        }
      } as never,
      registry,
      promptBuilder: createPromptBuilder(),
      contextLoader: createContextLoader(),
      interactions: { emit: () => {}, requestConfirmation: async () => true },
      maxIterations: 5
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "aca-loop2-"));
    const ws = createLocalWorkspace({ id: "ws-loop2", root });

    await loop.run({
      task: "do it",
      history: [{ role: "user", content: "do it" }],
      workspace: ws,
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    const secondTurn = seen[1]!;
    const toolMsg = secondTurn.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("Wrote x.txt");
    const assistantMsg = secondTurn.find((m) => m.role === "assistant");
    expect(assistantMsg?.toolCalls?.[0]?.name).toBe("write_file");
    await rm(root, { recursive: true, force: true });
  });

  it("parses JSON text tool calls when the model has no native tool calling", async () => {
    const events: SseEvent[] = [];
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          modelResult(JSON.stringify({ name: "write_file", arguments: { path: "json.txt", content: "hi" } }), [])
        )
        .mockResolvedValueOnce(modelResult("done", []))
    };
    const { loop, ws, root, registry } = await makeLoop(router as never, {
      emit: (e) => events.push(e),
      requestConfirmation: async () => true
    });
    registry.registerAll(fileTools);

    const result = await loop.run({
      task: "write json.txt",
      history: [{ role: "user", content: "write json.txt" }],
      workspace: ws,
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    expect(await readFile(path.join(root, "json.txt"), "utf8")).toBe("hi");
    expect(events.map((e) => e.type)).toContain("agent.tool_start");
    expect(events.find((e) => e.type === "agent.thought")?.type).toBe("agent.thought");
    expect(result.summary).toBe("done");
    await rm(root, { recursive: true, force: true });
  });

  it("parses multiple newline-separated JSON tool calls from one reply", async () => {
    const events: SseEvent[] = [];
    const blob =
      '{"name": "write_file", "arguments": {"path": "multi_a.txt", "content": "a"}}\n' +
      '{"name": "write_file", "arguments": {"path": "multi_b.txt", "content": "b"}}';
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(modelResult(blob, []))
        .mockResolvedValueOnce(modelResult("both written", []))
    };
    const { loop, ws, root, registry } = await makeLoop(router as never, {
      emit: (e) => events.push(e),
      requestConfirmation: async () => true
    });
    registry.registerAll(fileTools);

    const result = await loop.run({
      task: "write two files",
      history: [{ role: "user", content: "write two files" }],
      workspace: ws,
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    });

    expect(await readFile(path.join(root, "multi_a.txt"), "utf8")).toBe("a");
    expect(await readFile(path.join(root, "multi_b.txt"), "utf8")).toBe("b");
    expect(events.filter((e) => e.type === "agent.tool_start")).toHaveLength(2);
    expect(result.summary).toBe("both written");
    await rm(root, { recursive: true, force: true });
  });
});
