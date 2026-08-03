import type { Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

const MAX_MATCHES = 100;

const searchCode: Tool = {
  name: "search_code",
  description:
    "Case-insensitive regex search across workspace files (uses ripgrep; node_modules and .git are skipped). Returns up to 100 matches as path:line:content.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Optional subdirectory to restrict the search to" }
    },
    required: ["query"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(input.query ?? "");
    const target = input.path ? String(input.path) : ".";
    const command = `rg --no-heading --line-number -i --max-count 50 --max-filesize 2M --glob '!node_modules' --glob '!.git' --glob '!dist' ${JSON.stringify(query)} ${JSON.stringify(target)} 2>/dev/null | head -n ${MAX_MATCHES}`;
    const res = await ctx.workspace.runCommand(command);
    if (res.exitCode !== 0) {
      return { status: "success", output: "(no matches)" };
    }
    const lines = res.stdout.split("\n").filter(Boolean);
    if (!lines.length) return { status: "success", output: "(no matches)" };
    return {
      status: "success",
      output: `${lines.length} match${lines.length === 1 ? "" : "es"}:\n${lines.join("\n")}`
    };
  }
};

export const searchTool: Tool = searchCode;
