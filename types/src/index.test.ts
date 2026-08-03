import { describe, expect, it } from "vitest";
import type { SseEvent, Workspace, Tool } from "./index";

describe("shared contracts", () => {
  it("discriminates SSE events by type", () => {
    const events: SseEvent[] = [
      { type: "agent.text_delta", delta: "hello" },
      { type: "agent.tool_start", callId: "c1", tool: "read_file", input: { path: "a.ts" } },
      { type: "agent.done", summary: "done", usage: null }
    ];
    for (const e of events) {
      expect(typeof e.type).toBe("string");
      expect(e.type.startsWith("agent.")).toBe(true);
    }
  });

  it("defines a complete Workspace contract", () => {
    const ws: Workspace = {
      id: "ws-1",
      kind: "local",
      async readFile() {
        return "";
      },
      async writeFile() {},
      async listDir() {
        return [];
      },
      async runCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async gitStatus() {
        return { branch: "main", modified: [], untracked: [] };
      },
      async gitDiff() {
        return "";
      },
      async destroy() {}
    };
    expect(ws.kind).toBe("local");
    expect(ws.runCommand).toBeTypeOf("function");
  });

  it("defines the Tool contract", () => {
    const tool: Tool = {
      name: "read_file",
      description: "Read a file",
      requiresConfirmation: false,
      inputSchema: {},
      async execute() {
        return { status: "success", output: "" };
      }
    };
    expect(tool.requiresConfirmation).toBe(false);
  });
});
