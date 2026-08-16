import type { Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

const gitStatus: Tool = {
  name: "git_status",
  description: "Show the git status of the workspace: current branch, modified and untracked files.",
  requiresConfirmation: false,
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const status = await ctx.workspace.gitStatus();
    const lines = [`branch: ${status.branch}`];
    if (status.modified.length) lines.push("modified:", ...status.modified.map((m) => `  ${m}`));
    if (status.untracked.length) lines.push("untracked:", ...status.untracked.map((u) => `  ${u}`));
    if (!status.modified.length && !status.untracked.length) lines.push("(clean)");
    return { status: "success", output: lines.join("\n") };
  }
};

const gitDiff: Tool = {
  name: "git_diff",
  description:
    "Show uncommitted changes in the workspace. Optional path restricts the diff to one file.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: []
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const diff = await ctx.workspace.gitDiff(input.path ? String(input.path) : undefined);
    return { status: "success", output: diff || "(no uncommitted changes)" };
  }
};

const gitCommit: Tool = {
  name: "git_commit",
  description: "Stage all changes and create a git commit with the given message.",
  requiresConfirmation: true,
  destructive: true,
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", description: "Commit message" } },
    required: ["message"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const add = await ctx.workspace.runCommand("git add -A");
    if (add.exitCode !== 0) return { status: "error", output: add.stderr || add.stdout };
    const commit = await ctx.workspace.runCommand(`git commit -m ${JSON.stringify(String(input.message ?? ""))}`);
    if (commit.exitCode !== 0) return { status: "error", output: commit.stderr || commit.stdout };
    return { status: "success", output: commit.stdout || "Committed." };
  }
};

export const gitTools: Tool[] = [gitStatus, gitDiff, gitCommit];
