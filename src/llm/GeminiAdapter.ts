import { createOpenAICompatAdapter } from "./OpenAICompatAdapter";
import type { ModelAdapter } from "./types";

/** Google AI Studio exposes an OpenAI-compatible endpoint for Gemini. */
export function createGeminiAdapter(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  return createOpenAICompatAdapter({
    provider: "gemini",
    model: env.GEMINI_MODEL ?? "gemini-2.5-flash",
    apiKey: env.GOOGLE_API_KEY,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
  });
}
