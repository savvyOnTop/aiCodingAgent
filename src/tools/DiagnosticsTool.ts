import type { Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

const inspectEnvironment: Tool = {
  name: "inspect_environment",
  description:
    "Inspect the runtime environment the agent operates in: node/pnpm/git versions, git state, and workspace root contents.",
  requiresConfirmation: false,
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parts: string[] = [];
    const versions = await ctx.workspace.runCommand(
      "node -v 2>/dev/null; pnpm -v 2>/dev/null; git --version 2>/dev/null"
    );
    parts.push(`node/pnpm/git:\n${versions.stdout.trim() || "(none found)"}`);
    const status = await ctx.workspace.gitStatus();
    parts.push(
      `git: ${status.branch ? `branch ${status.branch}` : "not a git repo"} ` +
        `(${status.modified.length} modified, ${status.untracked.length} untracked)`
    );
    const entries = await ctx.workspace.listDir("");
    parts.push(`root entries: ${entries.map((e) => (e.type === "dir" ? e.name + "/" : e.name)).join(", ")}`);
    return { status: "success", output: parts.join("\n\n") };
  }
};

export const diagnosticsTool: Tool = inspectEnvironment;
