import type { ChatMessage, SseEvent, Tool, ToolCall, ToolContext, Workspace } from "@ai-coding-agent/types";
import type { ContextLoader, LoadedContext } from "./ContextLoader";
import type { PromptBuilder } from "./PromptBuilder";
import type { ToolRegistry } from "./ToolRegistry";
import { MaxIterationsError, type ModelRouter } from "../llm";
import type { ExecutionPlan, PlannerEngine, TaskNode } from "../planner";
import { buildRepairPrompt, hasFailures, type RepairLoop } from "../validation";

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
  /** When set, the run is planned up-front and replanned on task failure. */
  planner?: PlannerEngine;
  maxReplans?: number;
  /** When set, tasks that mutate files are gated on validation before accepting. */
  validation?: RepairLoop;
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
const DEFAULT_MAX_REPLANS = 3;
const TOOL_RESULT_PREVIEW = 2000;
const MAX_PLAN_CONTEXT_CHARS = 2000;

/** Tools that change the workspace; only these trigger validation gates. */
const MUTATING_TOOLS = new Set(["write_file", "run_command", "git_commit"]);

/**
 * Fallback for models without native tool calling: if the reply is a single
 * JSON object {"name": "<tool>", "arguments": {...}} (optionally fenced in
 * ```json), treat it as a tool call. Returns null when the text is prose.
 */
export function tryParseJsonToolCall(text: string): ToolCall | null {
  return tryParseJsonToolCalls(text)[0] ?? null;
}

/**
 * Extended fallback that decodes one or more tool calls from a reply:
 * a single object, a JSON array of objects, or several newline-separated
 * objects (models like qwen2.5-coder emit one line per call). Returns an
 * empty array for prose or malformed replies.
 */
export function tryParseJsonToolCalls(text: string): ToolCall[] {
  const candidates: unknown[] = [];
  const whole = parseJsonText(text);
  if (whole !== undefined) {
    candidates.push(...(Array.isArray(whole) ? (whole as unknown[]) : [whole]));
  } else {
    for (const line of text.trim().split("\n")) {
      const candidate = parseJsonText(line);
      if (candidate !== undefined) candidates.push(candidate);
    }
  }
  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    const first = candidate as { name?: unknown; arguments?: unknown } | undefined;
    if (!first || typeof first.name !== "string" || !first.name) continue;
    const input = first.arguments && typeof first.arguments === "object" ? (first.arguments as Record<string, unknown>) : {};
    calls.push({ id: `json-${Date.now()}-${calls.length}`, name: first.name, input });
  }
  return calls;
}

function parseJsonText(text: string): unknown | undefined {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
}

function accumulateUsage(acc: Usage | null, next: Usage): Usage {
  if (!acc) return next;
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    model: next.model,
    provider: next.provider
  };
}

/**
 * The agent loop as a factory function. With a planner it orchestrates the
 * goal as an execution plan: tasks run in dependency order inside the shared
 * transcript, each with its own model loop; a failed task triggers a replan
 * (bounded) with the revised plan emitted over SSE. Without a planner the
 * whole run is one implicit task, exactly the unplanned behavior.
 */
export function createAgentLoop(options: AgentLoopOptions): AgentLoop {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxReplans = options.maxReplans ?? DEFAULT_MAX_REPLANS;
  const { router, registry, promptBuilder, contextLoader, interactions, planner } = options;

  function summarizeContext(loaded: LoadedContext): string {
    const parts = [loaded.fileTree ? `File tree:\n${loaded.fileTree}` : "", loaded.keyFiles ? `Relevant files:\n${loaded.keyFiles}` : ""];
    return parts.filter(Boolean).join("\n\n").slice(0, MAX_PLAN_CONTEXT_CHARS);
  }

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

    let plan: ExecutionPlan | null = null;
    if (planner) {
      plan = await planner.plan(input.task, summarizeContext(loaded));
      interactions.emit({ type: "agent.plan", steps: plan.steps() });
    }

    let replansLeft = maxReplans;
    let queue: TaskNode[] = plan ? plan.remaining() : [];
    const usageState: { usage: Usage | null } = { usage: null };
    const taskSummaries: string[] = [];

    if (!plan) {
      const finalText = await runTaskLoop(messages, ctx, signal, usageState);
      return {
        summary: finalText,
        usage: usageState.usage,
        transcript: messages.slice(historyStart).filter((m) => m.role !== "system")
      };
    }

    for (;;) {
      if (plan && !plan.isComplete()) queue = plan.remaining();
      const task = queue.shift();
      if (!task) break;

      if (plan) {
        plan.markRunning(task.id);
        messages.push({
          role: "user",
          content: `[Plan task ${task.id}] ${task.title}\n\n${task.description}`
        });
      }

      try {
        const finalText = await runTaskLoop(messages, ctx, signal, usageState);
        if (plan) {
          plan.markDone(task.id);
          taskSummaries.push(finalText);
        } else {
          const transcript = messages.slice(historyStart).filter((m) => m.role !== "system");
          return { summary: finalText, usage: usageState.usage, transcript };
        }
      } catch (err) {
        if (signal?.aborted || !plan || replansLeft <= 0) throw err;
        replansLeft -= 1;
        plan.markFailed(task.id);
        const failure = { taskTitle: task.title, reason: err instanceof Error ? err.message : String(err) };
        const revised = await planner!.replan(input.task, summarizeContext(loaded), failure);
        plan = revised;
        interactions.emit({ type: "agent.plan", steps: revised.steps() });
        messages.push({
          role: "user",
          content: `[Plan revision] Task "${task.title}" failed: ${failure.reason}. Continue with the revised remaining plan.`
        });
        queue = plan.remaining();
      }
    }

    if (!plan) throw new Error("Agent loop exited without completing");
    const transcript = messages.slice(historyStart).filter((m) => m.role !== "system");
    return {
      summary: taskSummaries.join("\n\n"),
      usage: usageState.usage,
      transcript
    };
  }

  /** One task's model loop: iterate tools until the model answers plainly. */
  async function runTaskLoop(
    messages: ChatMessage[],
    ctx: ToolContext,
    signal: AbortSignal | undefined,
    usageState: { usage: Usage | null }
  ): Promise<string> {
    let mutated = false;
    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) throw new Error("Agent run aborted");
      const response = await router.complete({ messages, tools: registry.list(), signal });
      usageState.usage = accumulateUsage(usageState.usage, response.usage);

      let toolCalls = response.toolCalls;
      if (toolCalls.length === 0 && response.text) {
        toolCalls = tryParseJsonToolCalls(response.text).filter((call) => registry.get(call.name));
      }

      if (toolCalls.length === 0) {
        if (options.validation && mutated) {
          const gate = await options.validation.run({ workspace: ctx.workspace, signal, mutated });
          if (gate.gated) {
            for (const result of gate.results) {
              interactions.emit({
                type: "agent.validation",
                checker: result.checker,
                status: result.status,
                output: result.output
              });
            }
            if (hasFailures(gate.results)) {
              const failed = gate.results.filter((r) => r.status === "failed").map((r) => r.checker).join(", ");
              interactions.emit({ type: "agent.thought", thought: `Validation failed (${failed}); fixing then re-validating.` });
              messages.push({ role: "user", content: buildRepairPrompt(gate.results) });
              continue;
            }
          }
        }
        interactions.emit({ type: "agent.text_delta", delta: response.text ?? "" });
        messages.push({ role: "assistant", content: response.text ?? "" });
        return response.text ?? "";
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
        if (MUTATING_TOOLS.has(call.name)) mutated = true;
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
