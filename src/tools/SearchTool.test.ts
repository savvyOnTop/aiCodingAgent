import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, Workspace } from "@ai-coding-agent/types";
import { createLocalWorkspace } from "../workspace";
import { searchTools, searchWorkspace } from "./SearchTool";

let root: string;
let workspace: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aca-search-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules/fake"), { recursive: true });
  await writeFile(
    path.join(root, "src/alpha.ts"),
    'import { beta } from "./beta";\nexport function findWidget(): string {\n  return "widget";\n}\n'
  );
  await writeFile(path.join(root, "src/beta.ts"), "export const beta = 42; // widget helper\n");
  await writeFile(path.join(root, "node_modules/fake/ignored.ts"), "export const widget = 0;\n");
  workspace = createLocalWorkspace({ id: "ws-search", root });
  ctx = { workspace, sessionId: "s", cwd: ".", redact: (t) => t };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function tool(name: string) {
  return searchTools.find((t) => t.name === name)!;
}

describe("searchWorkspace", () => {
  it("returns structured matches with file, line, and column", async () => {
    const matches = await searchWorkspace(workspace, "widget");
    expect(matches.length).toBeGreaterThan(0);
    const hit = matches.find((m) => m.file === "src/alpha.ts" && m.line === 2)!;
    expect(hit).toBeDefined();
    expect(hit.column).toBeGreaterThan(0);
    expect(hit.text).toContain("findWidget");
    expect(hit.score).toBeGreaterThan(0);
  });

  it("respects ignore rules (node_modules never appears)", async () => {
    const matches = await searchWorkspace(workspace, "widget");
    expect(matches.some((m) => m.file.includes("node_modules"))).toBe(false);
  });

  it("caps results", async () => {
    const matches = await searchWorkspace(workspace, "widget", { maxResults: 1 });
    expect(matches).toHaveLength(1);
  });
});

describe("search tools", () => {
  it("search_code returns ranked file:line:column rows", async () => {
    const res = await tool("search_code").execute({ query: "widget" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toMatch(/src\/alpha\.ts:2:\d+:/);
    expect(res.output).not.toContain("node_modules");
  });

  it("search_symbol finds a declaration by name", async () => {
    const res = await tool("search_symbol").execute({ name: "findWidget" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("src/alpha.ts:2");
  });

  it("search_imports finds the dependents of a module", async () => {
    const res = await tool("search_imports").execute({ module: "./beta" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("src/alpha.ts:1");
    expect(res.output).not.toContain("src/beta.ts:1");
  });

  it("reports no matches cleanly", async () => {
    const res = await tool("search_code").execute({ query: "zzz_nothing_zzz" }, ctx);
    expect(res.output).toBe("(no matches)");
  });
});
