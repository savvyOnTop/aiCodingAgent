import type { Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

const MAX_LINES = 4000;

const readFile: Tool = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Paths are relative to the workspace root. Returns up to 4000 lines.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to workspace root" } },
    required: ["path"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const p = String(input.path ?? "");
    const content = await ctx.workspace.readFile(p);
    const lines = content.split("\n");
    const truncated = lines.length > MAX_LINES;
    const body = truncated ? lines.slice(0, MAX_LINES).join("\n") : content;
    return {
      status: "success",
      output: truncated ? `${body}\n\n[truncated: ${lines.length - MAX_LINES} more lines]` : body
    };
  }
};

const writeFile: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a file in the workspace with the given content. Creates parent directories. Paths are relative to the workspace root.",
  requiresConfirmation: true,
  destructive: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Full file content to write" }
    },
    required: ["path", "content"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    await ctx.workspace.writeFile(String(input.path ?? ""), String(input.content ?? ""));
    return { status: "success", output: `Wrote ${input.path} (${String(input.content ?? "").length} bytes)` };
  }
};

const listDir: Tool = {
  name: "list_dir",
  description:
    "List entries in a directory of the workspace. Empty path lists the workspace root. Directories appear with a trailing slash.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to workspace root" } },
    required: []
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const entries = await ctx.workspace.listDir(String(input.path ?? ""));
    if (entries.length === 0) return { status: "success", output: "(empty directory)" };
    const maxName = Math.max(...entries.map((e) => e.name.length));
    const rows = entries.map((e) => {
      const name = e.type === "dir" ? `${e.name}/` : e.name;
      return name.padEnd(maxName + 1) + e.path;
    });
    return { status: "success", output: rows.join("\n") };
  }
};

export const fileTools: Tool[] = [readFile, writeFile, listDir];
