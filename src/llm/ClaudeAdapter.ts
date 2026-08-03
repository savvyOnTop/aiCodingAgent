import type { ChatMessage, ModelCallResult, ToolCall } from "@ai-coding-agent/types";
import { LlmError, type CompleteParams, type ModelAdapter } from "./types";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function convertToAnthropic(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  let buffer: Record<string, unknown> | null = null;
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      if (!buffer) {
        buffer = { role: "user", content: [] as AnthropicBlock[] };
        out.push(buffer);
      }
      (buffer.content as unknown[]).push({
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content
      });
      continue;
    }
    buffer = null;
    if (m.role === "assistant") {
      const content: AnthropicBlock[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      out.push({ role: "assistant", content });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

/** Anthropic Messages API adapter as a factory function. */
export function createClaudeAdapter(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.CLAUDE_MODEL ?? "claude-sonnet-4-5";

  async function complete(params: CompleteParams): Promise<ModelCallResult> {
    const system = params.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const body = {
      model,
      ...(system ? { system } : {}),
      max_tokens: params.maxTokens ?? 8192,
      messages: convertToAnthropic(params.messages),
      tools: params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
      }))
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1500 * 2 ** (attempt - 1));
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey!,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify(body),
          signal: params.signal
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new LlmError(
            `[anthropic] HTTP ${res.status}: ${text.slice(0, 300)}`,
            "anthropic",
            [429, 500, 502, 503, 504].includes(res.status),
            res.status
          );
        }
        const data = (await res.json()) as {
          content?: AnthropicBlock[];
          usage?: { input_tokens?: number; output_tokens?: number };
          stop_reason?: string;
        };
        const toolCalls: ToolCall[] = [];
        let text = "";
        for (const block of data.content ?? []) {
          if (block.type === "text") text += block.text;
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>
            });
          }
        }
        return {
          text: text || null,
          toolCalls,
          usage: {
            inputTokens: data.usage?.input_tokens ?? 0,
            outputTokens: data.usage?.output_tokens ?? 0,
            model,
            provider: "anthropic"
          }
        };
      } catch (err) {
        if (err instanceof LlmError && !err.retryable) throw err;
        if (params.signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new LlmError(`[anthropic] request failed`, "anthropic", true);
  }

  return {
    provider: "anthropic",
    model,
    isConfigured: () => Boolean(apiKey),
    complete
  };
}
