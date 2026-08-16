import type { Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

const runCommand: Tool = {
  name: "run_command",
  description:
    "Run a shell command inside the workspace (e.g. install dependencies, run tests, inspect files). Output is truncated at 200KB. Secrets are redacted.",
  requiresConfirmation: true,
  destructive: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: { type: "string", description: "Optional subdirectory relative to workspace root" }
    },
    required: ["command"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const res = await ctx.workspace.runCommand(
      String(input.command ?? ""),
      input.cwd ? String(input.cwd) : undefined
    );
    const out = ctx.redact(`${res.stdout}${res.stderr}`).trim();
    return {
      status: res.exitCode === 0 ? "success" : "error",
      output: `exit ${res.exitCode}${out ? `\n${out}` : ""}${res.truncated ? "\n[output truncated]" : ""}`
    };
  }
};

export const terminalTool: Tool = runCommand;
