import { describe, expect, it } from "vitest";
import type { Tool } from "@ai-coding-agent/types";
import { createToolRegistry } from "./ToolRegistry";

const sampleTool: Tool = {
  name: "write_file",
  description: "write",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"]
  },
  async execute(input) {
    return { status: "success", output: `wrote ${String(input.path)}` };
  }
};

const ctx = {
  workspace: {} as never,
  sessionId: "s",
  cwd: ".",
  redact: (t: string) => t
};

describe("ToolRegistry", () => {
  it("rejects unknown tools", async () => {
    const reg = createToolRegistry();
    const res = await reg.execute("nope", {}, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toMatch(/not found/i);
  });

  it("validates required fields", async () => {
    const reg = createToolRegistry();
    reg.register(sampleTool);
    const res = await reg.execute("write_file", { path: "a" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toMatch(/content/);
  });

  it("executes valid input", async () => {
    const reg = createToolRegistry();
    reg.register(sampleTool);
    const res = await reg.execute("write_file", { path: "a", content: "x" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("wrote a");
  });

  it("exposes tools as model schemas", () => {
    const reg = createToolRegistry();
    reg.register(sampleTool);
    expect(reg.list()[0]).toEqual({
      name: "write_file",
      description: "write",
      inputSchema: sampleTool.inputSchema
    });
  });
});
