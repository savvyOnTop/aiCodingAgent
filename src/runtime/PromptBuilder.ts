import type { ChatMessage, ModelToolSchema } from "@ai-coding-agent/types";
import type { LoadedContext } from "./ContextLoader";

export interface PromptInput {
  task: string;
  context: LoadedContext;
  tools: ModelToolSchema[];
  history: ChatMessage[];
  workspaceRootName: string;
}

export interface PromptBuilderOptions {
  maxContextChars?: number;
}

export interface PromptBuilder {
  build(input: PromptInput): ChatMessage[];
}

const DEFAULT_MAX_CONTEXT_CHARS = 24_000;

/**
 * Builds the system prompt and workspace snapshot message that precede the
 * conversation history. Tool descriptions are also listed in the system text
 * so models without native tool-calling can still emit valid tool calls.
 */
export function createPromptBuilder(options: PromptBuilderOptions = {}): PromptBuilder {
  const maxContextChars = options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;

  function build(input: PromptInput): ChatMessage[] {
    const system = [
      "You are a software engineering agent working inside the user's repository.",
      "",
      "Rules:",
      "1. Inspect the workspace with tools before making changes; do not assume file contents.",
      "2. Prefer small, targeted edits. Read a file before writing it unless the write is a full rewrite.",
      "3. Tool output is truncated; adapt if something important may be missing.",
      "4. Run commands to verify your work (tests, typecheck). Report failures honestly.",
      "5. Destructive actions (shell commands, git commits) require user confirmation; wait for it.",
      "6. Respond in plain text. Do not wrap tool usage in code fences or markdown.",
      "7. If native tool invocation is unavailable to you, request a tool by replying with exactly one JSON object: {\"name\": \"<tool>\", \"arguments\": {...}}. Never fake a tool result.",
      "",
      "Available tools:",
      ...input.tools.map((t) => `- ${t.name}: ${t.description}`)
    ].join("\n");

    let contextText = `Workspace: ${input.workspaceRootName}\n\n`;
    if (input.context.fileTree) {
      contextText += `File tree:\n${input.context.fileTree}\n`;
    }
    if (input.context.keyFiles) {
      contextText += `\nRelevant files:\n${input.context.keyFiles}\n`;
    }
    if (contextText.length > maxContextChars) {
      contextText = contextText.slice(0, maxContextChars) + "\n[context truncated]";
    }

    return [
      { role: "system", content: system },
      { role: "user", content: contextText },
      ...input.history
    ];
  }

  return { build };
}
