import type { ModelToolSchema, Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

export interface ToolRegistryOptions {
  maxOutputChars?: number;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  registerAll(tools: Tool[]): void;
  get(name: string): Tool | undefined;
  list(): ModelToolSchema[];
  validate(tool: Tool, input: Record<string, unknown>): string | null;
  execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const TOOL_NOT_FOUND = "Tool not found";

/**
 * Name → handler registry as a factory function. Validates inputs against
 * each tool's schema (required fields + string types) and truncates oversized
 * outputs before they reach the model prompt.
 */
export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const tools = new Map<string, Tool>();
  const maxOutputChars = options.maxOutputChars ?? 8000;

  function register(tool: Tool): void {
    tools.set(tool.name, tool);
  }

  function registerAll(toolList: Tool[]): void {
    for (const tool of toolList) register(tool);
  }

  function get(name: string): Tool | undefined {
    return tools.get(name);
  }

  function list(): ModelToolSchema[] {
    return [...tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
  }

  function validate(tool: Tool, input: Record<string, unknown>): string | null {
    const schema = tool.inputSchema as {
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    for (const key of schema.required ?? []) {
      if (input[key] === undefined || input[key] === null || input[key] === "") {
        return `Missing required field "${key}"`;
      }
    }
    for (const [key, value] of Object.entries(input)) {
      const expected = schema.properties?.[key]?.type;
      if (expected && value !== undefined) {
        if (expected === "string" && typeof value !== "string") {
          return `Field "${key}" must be a string, got ${typeof value}`;
        }
      }
    }
    return null;
  }

  async function execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = tools.get(name);
    if (!tool) return { status: "error", output: `${TOOL_NOT_FOUND}: ${name}` };
    const validationError = validate(tool, input);
    if (validationError) return { status: "error", output: validationError };
    try {
      const result = await tool.execute(input, ctx);
      if (result.output.length > maxOutputChars) {
        return {
          ...result,
          output: result.output.slice(0, maxOutputChars) + "\n[output truncated]",
          truncated: true
        };
      }
      return result;
    } catch (err) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }

  return { register, registerAll, get, list, validate, execute };
}
