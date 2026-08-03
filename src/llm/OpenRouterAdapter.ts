import { createOpenAICompatAdapter } from "./OpenAICompatAdapter";
import type { ModelAdapter } from "./types";

/**
 * Free-tier workhorse. Default model id "openrouter/free" is OpenRouter's own
 * router that picks a working free model matching the requested capabilities
 * (including tools), which avoids "tool calling not supported on :free" 404s.
 */
export function createOpenRouterAdapter(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  return createOpenAICompatAdapter({
    provider: "openrouter",
    model: env.OPENROUTER_MODEL ?? "openrouter/free",
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    extraHeaders: {
      "HTTP-Referer": "https://github.com/ai-coding-agent",
      "X-Title": "AI Coding Agent"
    }
  });
}
