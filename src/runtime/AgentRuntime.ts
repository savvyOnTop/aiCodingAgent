import { createDefaultRouter, type ModelRouter, type RouterOptions } from "../llm";
import { createPlanner, type PlannerEngine } from "../planner";
import { defaultTools } from "../tools";
import {
  createRepairLoop,
  createValidationRunner,
  validationFromEnv,
  type RepairLoop,
  type ValidationConfig
} from "../validation";
import { createAgentLoop, type AgentInteractions, type RunInput, type RunResult } from "./AgentLoop";
import { createContextLoader } from "./ContextLoader";
import { createPromptBuilder } from "./PromptBuilder";
import { createToolRegistry, type ToolRegistry } from "./ToolRegistry";

export interface AgentRuntimeOptions {
  router?: ModelRouter;
  /**
   * Phase 06: response cache threaded into the default router (ignored when a
   * custom router is provided).
   */
  cache?: RouterOptions["cache"];
  registry?: ToolRegistry;
  promptBuilder?: ReturnType<typeof createPromptBuilder>;
  contextLoader?: ReturnType<typeof createContextLoader>;
  maxIterations?: number;
  /** Enable goal planning; default on, backed by the same router. */
  planner?: PlannerEngine;
  /** Set false to disable planning entirely. */
  plan?: boolean;
  /**
   * Validation checks for mutating tasks. Defaults to the environment
   * (VALIDATE_BUILD_CMD / VALIDATE_TEST_CMD / VALIDATE_LINT_CMD); pass null
   * to disable, or a config to override.
   */
  validation?: ValidationConfig | null;
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
  const router = options.router ?? createDefaultRouter(process.env, options.cache);
  const registry = options.registry ?? createToolRegistry();
  if (options.registry === undefined) registry.registerAll(defaultTools);
  const promptBuilder = options.promptBuilder ?? createPromptBuilder();
  const contextLoader = options.contextLoader ?? createContextLoader();
  const maxIterations = options.maxIterations ?? 30;
  const planner = options.plan === false ? undefined : (options.planner ?? createPlanner({ router }));

  let repairLoop: RepairLoop | undefined;
  const validationConfig = options.validation === undefined ? validationFromEnv() : options.validation;
  if (validationConfig) {
    const runner = createValidationRunner(validationConfig);
    if (runner.enabled()) repairLoop = createRepairLoop({ validation: runner });
  }

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
      planner,
      validation: repairLoop
    });
    return loop.run(input, signal);
  }

  return { registry, run };
}
