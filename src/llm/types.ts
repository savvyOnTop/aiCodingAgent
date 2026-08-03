import type { ChatMessage, ModelCallResult, ModelToolSchema } from "@ai-coding-agent/types";

export interface CompleteParams {
  messages: ChatMessage[];
  tools: ModelToolSchema[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Internal shape every provider adapter must implement. */
export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  isConfigured(): boolean;
  complete(params: CompleteParams): Promise<ModelCallResult>;
}

/** Provider error tagged with retryability so the router can decide failover. */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export class MaxIterationsError extends Error {
  constructor(public readonly iterations: number) {
    super(`Agent reached the maximum of ${iterations} iterations`);
    this.name = "MaxIterationsError";
  }
}
