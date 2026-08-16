import type { Tool, ToolContext, ToolResult, Workspace } from "@ai-coding-agent/types";

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  /** Matches in the same file (denser file = more relevant). */
  score: number;
}

export interface SearchOptions {
  /** Subdirectory (relative) to restrict the search to. */
  path?: string;
  maxResults?: number;
}

const MAX_RESULTS = 100;
const IGNORE_GLOBS = "--glob '!node_modules' --glob '!.git' --glob '!dist' --glob '!coverage' --glob '!build'";

interface RgMatchEvent {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
    submatches?: Array<{ start?: number }>;
  };
}

/**
 * Ripgrep-backed workspace search (phase 09). Runs inside the workspace
 * boundary via runCommand (local root or container), falls back to grep when
 * rg is unavailable, and returns structured, score-ranked matches.
 */
export async function searchWorkspace(
  workspace: Workspace,
  query: string,
  options: SearchOptions = {}
): Promise<SearchMatch[]> {
  const target = options.path ?? ".";
  const maxResults = options.maxResults ?? MAX_RESULTS;
  const rg = `rg --json -i --max-count 50 --max-filesize 2M ${IGNORE_GLOBS} -e ${JSON.stringify(query)} ${JSON.stringify(target)} 2>/dev/null`;
  const res = await workspace.runCommand(rg);

  let matches: SearchMatch[];
  if (res.exitCode === 127) {
    matches = await grepFallback(workspace, query, target);
  } else {
    matches = parseRgJson(res.stdout);
  }

  // score = per-file match density; stable order within a file
  const perFile = new Map<string, number>();
  for (const m of matches) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
  for (const m of matches) m.score = perFile.get(m.file)!;
  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return matches.slice(0, maxResults);
}

function parseRgJson(stdout: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: RgMatchEvent;
    try {
      event = JSON.parse(line) as RgMatchEvent;
    } catch {
      continue;
    }
    if (event.type !== "match" || !event.data) continue;
    const file = event.data.path?.text;
    const lineNumber = event.data.line_number;
    if (!file || lineNumber === undefined) continue;
    matches.push({
      file: file.replace(/^\.\//, ""),
      line: lineNumber,
      column: (event.data.submatches?.[0]?.start ?? 0) + 1,
      text: (event.data.lines?.text ?? "").replace(/\n$/, ""),
      score: 0
    });
  }
  return matches;
}

async function grepFallback(workspace: Workspace, query: string, target: string): Promise<SearchMatch[]> {
  const cmd = `grep -rniE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -e ${JSON.stringify(query)} ${JSON.stringify(target)} 2>/dev/null | head -n ${MAX_RESULTS}`;
  const res = await workspace.runCommand(cmd);
  const matches: SearchMatch[] = [];
  for (const row of res.stdout.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    matches.push({ file: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), column: 1, text: m[3]!, score: 0 });
  }
  return matches;
}

function formatMatches(matches: SearchMatch[]): string {
  if (matches.length === 0) return "(no matches)";
  const rows = matches.map((m) => `${m.file}:${m.line}:${m.column}: ${m.text.trim()}`);
  return `${matches.length} match${matches.length === 1 ? "" : "es"}:\n${rows.join("\n")}`;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

const searchCode: Tool = {
  name: "search_code",
  description:
    "Case-insensitive regex search across workspace files (ripgrep-backed; node_modules/.git/dist skipped). Returns ranked file:line:column matches.",
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
    const matches = await searchWorkspace(ctx.workspace, String(input.query ?? ""), {
      path: input.path ? String(input.path) : undefined
    });
    return { status: "success", output: formatMatches(matches) };
  }
};

const searchSymbol: Tool = {
  name: "search_symbol",
  description:
    "Find where a symbol (function, class, interface, type, enum, const, def) is declared. Returns file:line:column matches.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Symbol name (or part of it) to locate" }
    },
    required: ["name"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = escapeRegex(String(input.name ?? ""));
    const pattern = `(export\\s+)?(default\\s+)?(async\\s+)?(function|class|interface|type|enum|const|let|var|def)\\s+[A-Za-z0-9_]*${name}`;
    const matches = await searchWorkspace(ctx.workspace, pattern, {});
    return { status: "success", output: formatMatches(matches) };
  }
};

const searchImports: Tool = {
  name: "search_imports",
  description:
    "Find the files that import or require a module (its dependents). Returns file:line:column matches.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      module: { type: "string", description: "Module name or path fragment, e.g. \"react\" or \"./ContextLoader\"" }
    },
    required: ["module"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const module = escapeRegex(String(input.module ?? ""));
    const pattern = `(from\\s+["'][^"']*${module}[^"']*["']|require\\(\\s*["'][^"']*${module}|import\\s*\\(\\s*["'][^"']*${module}|^\\s*import\\s+["'][^"']*${module})`;
    const matches = await searchWorkspace(ctx.workspace, pattern, {});
    return { status: "success", output: formatMatches(matches) };
  }
};

export const searchTools: Tool[] = [searchCode, searchSymbol, searchImports];
/** Back-compat alias for the original single search tool export. */
export const searchTool: Tool = searchCode;
