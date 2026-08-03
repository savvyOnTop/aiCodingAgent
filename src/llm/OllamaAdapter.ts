import type { ChatMessage, ModelCallResult, ToolCall } from "@ai-coding-agent/types";
import { LlmError, type CompleteParams, type ModelAdapter } from "./types";

export interface OllamaAdapterOptions {
  baseUrl?: string;
  model?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function convertToOllama(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                function: { name: c.name, arguments: c.input }
              }))
            }
          : {})
      };
    }
    return { role: m.role, content: m.content };
  });
}

function parseOllamaToolCalls(message: unknown, index: number): ToolCall[] {
  const calls = (message as { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] })?.tool_calls;
  if (!calls?.length) return [];
  return calls
    .map((c, i) => {
      let input: Record<string, unknown> = {};
      const raw = c.function?.arguments;
      if (typeof raw === "string") {
        try {
          input = JSON.parse(raw);
        } catch {
          input = {};
        }
      } else if (raw && typeof raw === "object") {
        input = raw as Record<string, unknown>;
      }
      return { id: `ollama-${index}-${i}`, name: c.function?.name ?? "", input };
    })
    .filter((c) => c.name);
}

/**
 * Local Ollama adapter using the native /api/chat endpoint (older Ollama
 * builds do not expose the OpenAI-compatible /v1 route). No API key needed;
 * always "configured" so it acts as the last-resort fallback.
 */
export function createOllamaAdapter(
  env: NodeJS.ProcessEnv = process.env,
  options: OllamaAdapterOptions = {}
): ModelAdapter {
  const baseUrl = options.baseUrl ?? env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = options.model ?? env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";

  async function complete(params: CompleteParams): Promise<ModelCallResult> {
    const body = {
      model,
      messages: convertToOllama(params.messages),
      tools: params.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      })),
      stream: false
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: params.signal
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new LlmError(
            `[ollama] HTTP ${res.status}: ${text.slice(0, 300)}`,
            "ollama",
            [429, 500, 502, 503, 504].includes(res.status),
            res.status
          );
        }
        const data = (await res.json()) as {
          message?: { content?: string | null; tool_calls?: unknown };
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const message = data.message ?? {};
        return {
          text: message.content ?? null,
          toolCalls: parseOllamaToolCalls(message, attempt),
          usage: {
            inputTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0,
            model,
            provider: "ollama"
          }
        };
      } catch (err) {
        if (err instanceof LlmError && !err.retryable) throw err;
        if (params.signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new LlmError(`[ollama] request failed`, "ollama", true);
  }

  return {
    provider: "ollama",
    model,
    isConfigured: () => true,
    complete
  };
}
