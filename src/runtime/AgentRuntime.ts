import { createDefaultRouter, type ModelRouter } from "../llm";
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
      maxIterations
    });
    return loop.run(input, signal);
  }

  return { registry, run };
}
