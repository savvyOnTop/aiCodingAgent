import { createDefaultRouter, type ModelRouter } from "../llm";
import { createPlanner, type PlannerEngine } from "../planner";
import { defaultTools } from "../tools";
import { createAgentLoop, type AgentInteractions, type RunInput, type RunResult } from "./AgentLoop";
import { createContextLoader } from "./ContextLoader";
import { createPromptBuilder } from "./PromptBuilder";
import { createToolRegistry, type ToolRegistry } from "./ToolRegistry";

export interface AgentRuntimeOptions {
  router?: ModelRouter;
  registry?: ToolRegistry;
  promptBuilder?: ReturnType<typeof createPromptBuilder>;
  contextLoader?: ReturnType<typeof createContextLoader>;
  maxIterations?: number;
  /** Enable goal planning; default on, backed by the same router. */
  planner?: PlannerEngine;
  /** Set false to disable planning entirely. */
  plan?: boolean;
}

export interface AgentRuntime {
  registry: ToolRegistry;
  run(input: RunInput, interactions: AgentInteractions, signal?: AbortSignal): Promise<RunResult>;
}

/**
 * Runtime layer facade: wires router + registry + prompt builder + context
 * loader together and exposes a single `run()` per conversation turn.
 */
export function createAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  const router = options.router ?? createDefaultRouter();
  const registry = options.registry ?? createToolRegistry();
  if (options.registry === undefined) registry.registerAll(defaultTools);
  const promptBuilder = options.promptBuilder ?? createPromptBuilder();
  const contextLoader = options.contextLoader ?? createContextLoader();
  const maxIterations = options.maxIterations ?? 30;
  const planner = options.plan === false ? undefined : (options.planner ?? createPlanner({ router }));

  async function run(
    input: RunInput,
    interactions: AgentInteractions,
    signal?: AbortSignal
  ): Promise<RunResult> {
    const loop = createAgentLoop({
      router,
      registry,
      promptBuilder,
      contextLoader,
      interactions,
      maxIterations,
      planner
    });
    return loop.run(input, signal);
  }

  return { registry, run };
}
