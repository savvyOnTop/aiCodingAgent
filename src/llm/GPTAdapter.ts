import { createOpenAICompatAdapter } from "./OpenAICompatAdapter";
import type { ModelAdapter } from "./types";

export function createGPTAdapter(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  return createOpenAICompatAdapter({
    provider: "openai",
    model: env.GPT_MODEL ?? "gpt-4.1-mini",
    apiKey: env.OPENAI_API_KEY,
    baseUrl: "https://api.openai.com/v1"
  });
}
