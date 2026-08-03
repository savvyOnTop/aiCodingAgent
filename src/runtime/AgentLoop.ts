import type { ChatMessage, SseEvent, Tool, ToolCall, ToolContext, Workspace } from "@ai-coding-agent/types";
import type { ContextLoader, LoadedContext } from "./ContextLoader";
import type { PromptBuilder } from "./PromptBuilder";
import type { ToolRegistry } from "./ToolRegistry";
import { MaxIterationsError, type ModelRouter } from "../llm";

export interface AgentInteractions {
  emit(event: SseEvent): void;
  /** Resolves true when the user approves a dangerous tool call. */
  requestConfirmation(call: ToolCall, tool: Tool): Promise<boolean>;
}

export interface AgentLoopOptions {
  router: ModelRouter;
  registry: ToolRegistry;
  promptBuilder: PromptBuilder;
  contextLoader: ContextLoader;
  interactions: AgentInteractions;
  maxIterations?: number;
}

export interface RunInput {
  task: string;
  /** Conversation history ending with the task as the last user message. */
  history: ChatMessage[];
  workspace: Workspace;
  sessionId: string;
  cwd: string;
  redact(text: string): string;
}

export interface RunResult {
  summary: string;
  usage: NonNullable<SseEvent & { type: "agent.done" }>["usage"];
  /** Full message transcript including tool calls/results (no system). */
  transcript: ChatMessage[];
}

export interface AgentLoop {
  run(input: RunInput, signal?: AbortSignal): Promise<RunResult>;
}

const DEFAULT_MAX_ITERATIONS = 30;
const TOOL_RESULT_PREVIEW = 2000;

/**
 * Fallback for models without native tool calling: if the reply is a single
 * JSON object {"name": "<tool>", "arguments": {...}} (optionally fenced in
 * ```json), treat it as a tool call. Returns null when the text is prose.
 */
export function tryParseJsonToolCall(text: string): ToolCall | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const first = candidates[0] as { name?: unknown; arguments?: unknown } | undefined;
  if (!first || typeof first.name !== "string" || !first.name) return null;
  const input =
    first.arguments && typeof first.arguments === "object"
      ? (first.arguments as Record<string, unknown>)
      : {};
  return { id: `json-${Date.now()}`, name: first.name, input };
}

/**
 * The agent loop as a factory function: build prompt → call model → if tool
 * calls arrive, gate and execute them → append results → repeat until the
 * model answers without tool calls or the iteration cap is hit.
 */
export function createAgentLoop(options: AgentLoopOptions): AgentLoop {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const { router, registry, promptBuilder, contextLoader, interactions } = options;

  async function run(input: RunInput, signal?: AbortSignal): Promise<RunResult> {
    const loaded: LoadedContext = await contextLoader.load(input.workspace);
    const messages: ChatMessage[] = promptBuilder.build({
      task: input.task,
      context: loaded,
      tools: registry.list(),
      history: input.history,
      workspaceRootName: input.workspace.id
    });
    const historyStart = messages.length;
    const ctx: ToolContext = {
      workspace: input.workspace,
      sessionId: input.sessionId,
      cwd: input.cwd,
      redact: input.redact
    };

    let usage: RunResult["usage"] = null;
    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) throw new Error("Agent run aborted");
      const response = await router.complete({ messages, tools: registry.list(), signal });
      usage = response.usage;

      let toolCalls = response.toolCalls;
      if (toolCalls.length === 0 && response.text) {
        const parsed = tryParseJsonToolCall(response.text);
        if (parsed && registry.get(parsed.name)) toolCalls = [parsed];
      }

      if (toolCalls.length === 0) {
        interactions.emit({ type: "agent.text_delta", delta: response.text ?? "" });
        messages.push({ role: "assistant", content: response.text ?? "" });
        const transcript = messages.slice(historyStart).filter((m) => m.role !== "system");
        return { summary: response.text ?? "", usage, transcript };
      }

      if (response.text && toolCalls.length > 0 && !response.toolCalls.length) {
        interactions.emit({ type: "agent.thought", thought: response.text });
      }
      messages.push({ role: "assistant", content: "", toolCalls });

      for (const call of toolCalls) {
        const tool = registry.get(call.name);
        if (!tool) {
          interactions.emit({
            type: "agent.tool_result",
            callId: call.id,
            status: "error",
            output: `Unknown tool: ${call.name}`
          });
          messages.push({ role: "tool", toolCallId: call.id, content: `Unknown tool: ${call.name}` });
          continue;
        }

        interactions.emit({ type: "agent.tool_start", callId: call.id, tool: call.name, input: call.input });

        let approved = true;
        if (tool.requiresConfirmation) {
          interactions.emit({
            type: "agent.confirm_request",
            callId: call.id,
            tool: call.name,
            input: call.input
          });
          approved = await interactions.requestConfirmation(call, tool);
        }
        if (!approved) {
          interactions.emit({
            type: "agent.tool_result",
            callId: call.id,
            status: "error",
            output: "User denied this tool call."
          });
          messages.push({ role: "tool", toolCallId: call.id, content: "[user denied this tool call]" });
          continue;
        }

        const result = await registry.execute(call.name, call.input, ctx);
        const preview = result.output.slice(0, TOOL_RESULT_PREVIEW);
        interactions.emit({
          type: "agent.tool_result",
          callId: call.id,
          status: result.status,
          output: preview
        });
        messages.push({ role: "tool", toolCallId: call.id, content: `[${result.status}] ${result.output}` });
      }
    }

    throw new MaxIterationsError(maxIterations);
  }

  return { run };
}
