import type { Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

export type FailureKind =
  | "compile"
  | "test"
  | "lint"
  | "runtime"
  | "network"
  | "timeout"
  | "unknown";

export interface FailureDiagnosis {
  kind: FailureKind;
  /** First actionable message extracted from the output. */
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

/** Ordered taxonomy: the first matching classifier wins. */
const CLASSIFIERS: Array<{ kind: FailureKind; pattern: RegExp }> = [
  { kind: "timeout", pattern: /\b(timed?\s?out|ETIMEDOUT|timeout of \d+)/i },
  {
    kind: "network",
    pattern: /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo|socket hang up)\b/i
  },
  {
    kind: "compile",
    pattern: /error TS\d+|SyntaxError|error\[E\d+\]|: error:|cannot find (module|name)|Compilation failed/i
  },
  { kind: "lint", pattern: /\beslint\b|\d+ problems? \(\d+ errors?|prefer-const|no-unused-vars/i },
  {
    kind: "test",
    pattern: /\bFAIL\b|AssertionError|\d+ (failed|failing)\b|Tests? failed|expect\(.*\)\.to/i
  },
  {
    kind: "runtime",
    pattern: /\bpanic\b|Unhandled|Traceback \(most recent call last\)|Segmentation fault|core dumped/i
  }
];

const LOCATION_RE = /([A-Za-z0-9_@][A-Za-z0-9_@./\\-]*\.[a-z]{1,6})[:(](\d+)(?:[:,](\d+))?/;
/** Python traceback style: File "app.py", line 3 */
const PY_LOCATION_RE = /File "([^"]+)", line (\d+)/;

function extractLocation(output: string): { file?: string; line?: number; column?: number } {
  const location = LOCATION_RE.exec(output);
  if (location) {
    return {
      file: location[1],
      line: Number(location[2]),
      column: location[3] ? Number(location[3]) : undefined
    };
  }
  const py = PY_LOCATION_RE.exec(output);
  if (py) return { file: py[1], line: Number(py[2]) };
  return {};
}

/**
 * Classifies a failed command's output into the RepairLoop error taxonomy and
 * extracts the first actionable message + file:line:column (phase 09).
 */
export function classifyFailure(output: string): FailureDiagnosis {
  const lines = output.split("\n");
  for (const { kind, pattern } of CLASSIFIERS) {
    if (!pattern.test(output)) continue;
    const messageLine = lines.find((l) => pattern.test(l)) ?? lines.find((l) => l.trim()) ?? "";
    return { kind, message: messageLine.trim(), ...extractLocation(output) };
  }
  const firstLine = lines.find((l) => l.trim())?.trim() ?? "";
  return { kind: "unknown", message: firstLine, ...extractLocation(output) };
}

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

const classifyFailureTool: Tool = {
  name: "classify_failure",
  description:
    "Classify a failed command's output (compile error, test failure, lint violation, runtime crash, network, timeout) and extract the first actionable message with its file:line.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      output: { type: "string", description: "The failing command's combined stdout/stderr" }
    },
    required: ["output"]
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const diagnosis = classifyFailure(String(input.output ?? ""));
    const rows = [`kind: ${diagnosis.kind}`, `message: ${diagnosis.message || "(none)"}`];
    if (diagnosis.file) {
      rows.push(
        `location: ${diagnosis.file}:${diagnosis.line ?? "?"}${diagnosis.column !== undefined ? `:${diagnosis.column}` : ""}`
      );
    }
    return { status: "success", output: rows.join("\n") };
  }
};

const attachSnippet: Tool = {
  name: "attach_snippet",
  description:
    "Extract a source slice around file:line (± context lines, default 5). The target line is marked with '>' and an optional column caret.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Path relative to workspace root" },
      line: { type: "number", description: "1-based target line" },
      column: { type: "number", description: "Optional 1-based column for the caret" },
      context: { type: "number", description: "Lines of context around the target (default 5)" }
    },
    required: ["file", "line"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const file = String(input.file ?? "");
    const line = Number(input.line ?? 0);
    const column = input.column !== undefined ? Number(input.column) : undefined;
    const context = input.context !== undefined ? Number(input.context) : 5;
    const content = await ctx.workspace.readFile(file);
    const lines = content.split("\n");
    if (line < 1 || line > lines.length) {
      return { status: "error", output: `Line ${line} is out of range (file has ${lines.length} lines)` };
    }
    const from = Math.max(1, line - context);
    const to = Math.min(lines.length, line + context);
    const width = String(to).length;
    const rows: string[] = [];
    for (let n = from; n <= to; n++) {
      const marker = n === line ? ">" : " ";
      rows.push(`${marker} ${String(n).padStart(width)} | ${lines[n - 1]}`);
      if (n === line && column !== undefined && column >= 1) {
        rows.push(`  ${" ".repeat(width)} | ${" ".repeat(column - 1)}^`);
      }
    }
    return { status: "success", output: `${file}:${line}\n${rows.join("\n")}` };
  }
};

export const diagnosticsTools: Tool[] = [inspectEnvironment, classifyFailureTool, attachSnippet];
/** Back-compat alias for the original single diagnostics export. */
export const diagnosticsTool: Tool = inspectEnvironment;
