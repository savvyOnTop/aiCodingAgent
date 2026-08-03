import type { ModelCallResult } from "@ai-coding-agent/types";
import { createClaudeAdapter } from "./ClaudeAdapter";
import { createGeminiAdapter } from "./GeminiAdapter";
import { createGPTAdapter } from "./GPTAdapter";
import { createOllamaAdapter } from "./OllamaAdapter";
import { createOpenRouterAdapter } from "./OpenRouterAdapter";
import { LlmError, type CompleteParams, type ModelAdapter } from "./types";

export interface RouterOptions {
  adapters: ModelAdapter[];
  log?: (message: string) => void;
}

export interface ModelRouter {
  available(): ModelAdapter[];
  complete(params: CompleteParams): Promise<ModelCallResult>;
}

/**
 * Failover router as a factory function: tries adapters in priority order,
 * skipping unconfigured ones and falling through to the next provider on any
 * error. Per-adapter retry/backoff lives inside each adapter.
 */
export function createModelRouter(options: RouterOptions): ModelRouter {
  const log = options.log ?? (() => {});

  function available(): ModelAdapter[] {
    return options.adapters.filter((a) => a.isConfigured());
  }

  async function complete(params: CompleteParams): Promise<ModelCallResult> {
    let lastError: unknown = null;
    for (const adapter of options.adapters) {
      if (!adapter.isConfigured()) continue;
      try {
        log(`→ LLM call via ${adapter.provider}/${adapter.model}`);
        return await adapter.complete(params);
      } catch (err) {
        lastError = err;
        if (params.signal?.aborted) throw err;
        if (err instanceof LlmError && !err.retryable) {
          log(`✗ ${adapter.provider} failed (${err.statusCode ?? "?"}), failing over`);
        } else {
          log(`✗ ${adapter.provider} failed, failing over`);
        }
      }
    }
    if (params.signal?.aborted) throw new Error("aborted");
    if (lastError instanceof Error) throw lastError;
    throw new Error("No LLM provider configured. Set OPENROUTER_API_KEY or run a local Ollama.");
  }

  return { available, complete };
}

/** Default priority chain: OpenRouter (free) → Gemini → Ollama → GPT → Claude. */
export function createDefaultRouter(env: NodeJS.ProcessEnv = process.env): ModelRouter {
  return createModelRouter({
    adapters: [
      createOpenRouterAdapter(env),
      createGeminiAdapter(env),
      createOllamaAdapter(env),
      createGPTAdapter(env),
      createClaudeAdapter(env)
    ]
  });
}
