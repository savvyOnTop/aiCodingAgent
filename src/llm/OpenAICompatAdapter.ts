import type { ChatMessage, ModelCallResult, ToolCall } from "@ai-coding-agent/types";
import { LlmError, type CompleteParams, type ModelAdapter } from "./types";

export interface OpenAICompatConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  maxRetries?: number;
  backoffMs?: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function convertToOpenAi(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input) }
              }))
            }
          : {})
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
    }
    return { role: m.role, content: m.content };
  });
}

export function parseOpenAiToolCalls(message: unknown): ToolCall[] {
  const calls = (message as { tool_calls?: unknown[] })?.tool_calls ?? [];
  return calls
    .map((c) => {
      const call = c as { id?: string; function?: { name?: string; arguments?: string } };
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        input = {};
      }
      return { id: call.id ?? "", name: call.function?.name ?? "", input };
    })
    .filter((c) => c.name);
}

/**
 * Factory for every provider exposing the OpenAI /chat/completions wire
 * format (OpenRouter, OpenAI, Google AI Studio, Ollama, ...). The returned
 * object closes over the config and is a plain function-shaped ModelAdapter.
 */
export function createOpenAICompatAdapter(config: OpenAICompatConfig): ModelAdapter {
  const resolved = { maxRetries: 2, backoffMs: 1500, ...config };

  async function complete(params: CompleteParams): Promise<ModelCallResult> {
    const body = {
      model: resolved.model,
      messages: convertToOpenAi(params.messages),
      tools: params.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      })),
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {})
    };

    let lastError: Error | null = null;
    const attempts = 1 + (resolved.maxRetries ?? 0);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(resolved.backoffMs! * 2 ** (attempt - 1));
      try {
        const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resolved.apiKey}`,
            ...resolved.extraHeaders
          },
          body: JSON.stringify(body),
          signal: params.signal
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new LlmError(
            `[${resolved.provider}] HTTP ${res.status}: ${text.slice(0, 300)}`,
            resolved.provider,
            RETRYABLE_STATUS.has(res.status),
            res.status
          );
        }
        const data = (await res.json()) as {
          choices?: { message?: unknown }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const message = data.choices?.[0]?.message;
        return {
          text: (message as { content?: string | null })?.content ?? null,
          toolCalls: parseOpenAiToolCalls(message),
          usage: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
            model: resolved.model,
            provider: resolved.provider
          }
        };
      } catch (err) {
        if (err instanceof LlmError && !err.retryable) throw err;
        if (params.signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new LlmError(`[${resolved.provider}] request failed`, resolved.provider, true);
  }

  return {
    provider: resolved.provider,
    model: resolved.model,
    isConfigured: () => Boolean(resolved.apiKey),
    complete
  };
}
