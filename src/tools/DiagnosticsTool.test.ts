import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@ai-coding-agent/types";
import { createLocalWorkspace } from "../workspace";
import { classifyFailure, diagnosticsTools } from "./DiagnosticsTool";

describe("classifyFailure", () => {
  it("classifies TypeScript compile errors with file:line:column", () => {
    const d = classifyFailure(
      "src/runtime/ContextLoader.ts(150,48): error TS2345: Argument of type 'string[]' is not assignable."
    );
    expect(d.kind).toBe("compile");
    expect(d.message).toContain("TS2345");
    expect(d.file).toBe("src/runtime/ContextLoader.ts");
    expect(d.line).toBe(150);
    expect(d.column).toBe(48);
  });

  it("classifies test failures", () => {
    const d = classifyFailure(
      " FAIL  src/x.test.ts > adds numbers\nAssertionError: expected 2 to be 3\n Tests  1 failed | 4 passed"
    );
    expect(d.kind).toBe("test");
    expect(d.message).toContain("FAIL");
  });

  it("classifies lint violations", () => {
    const d = classifyFailure(
      "/repo/src/a.ts\n  45:7  error  'x' is never reassigned. Use 'const' instead  prefer-const\n✖ 2 problems (2 errors, 0 warnings)"
    );
    expect(d.kind).toBe("lint");
  });

  it("classifies network errors", () => {
    const d = classifyFailure("Error: connect ECONNREFUSED 127.0.0.1:5432");
    expect(d.kind).toBe("network");
    expect(d.message).toContain("ECONNREFUSED");
  });

  it("classifies timeouts ahead of network errors", () => {
    const d = classifyFailure("Error: connect ETIMEDOUT 10.0.0.1:443");
    expect(d.kind).toBe("timeout");
  });

  it("classifies runtime crashes", () => {
    const d = classifyFailure("Traceback (most recent call last):\n  File \"app.py\", line 3\nZeroDivisionError");
    expect(d.kind).toBe("runtime");
    expect(d.file).toBe("app.py");
  });

  it("falls back to unknown with the first line as message", () => {
    const d = classifyFailure("\nsomething odd happened\n");
    expect(d.kind).toBe("unknown");
    expect(d.message).toBe("something odd happened");
  });
});

describe("attach_snippet", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("extracts a marked slice around file:line with a column caret", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "aca-diag-"));
    await writeFile(
      path.join(root, "main.ts"),
      Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    );
    const ctx: ToolContext = {
      workspace: createLocalWorkspace({ id: "ws-diag", root }),
      sessionId: "s",
      cwd: ".",
      redact: (t) => t
    };
    const tool = diagnosticsTools.find((t) => t.name === "attach_snippet")!;

    const res = await tool.execute({ file: "main.ts", line: 10, column: 3, context: 2 }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("> 10 | line 10");
    expect(res.output).toContain("line 8");
    expect(res.output).toContain("line 12");
    expect(res.output).not.toContain("line 7\n");
    expect(res.output).toMatch(/\|\s {2}\^/);

    const oob = await tool.execute({ file: "main.ts", line: 99 }, ctx);
    expect(oob.status).toBe("error");
  });
});
