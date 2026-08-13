import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorkspace } from "../workspace";
import { createContextLoader } from "./ContextLoader";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function makeFixture(files: Record<string, string>): Promise<ReturnType<typeof createLocalWorkspace>> {
  root = await mkdtemp(path.join(os.tmpdir(), "aca-ctx-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return createLocalWorkspace({ id: "ws-test", root });
}

const FS = {
  "package.json": JSON.stringify({ name: "fixture", scripts: { test: "jest" } }),
  "README.md": "Fixture repo.",
  "src/main.ts": 'import { config } from "./config";\nexport const main = () => config;',
  "src/config.ts": "export const config = { theme: \"dark\" };\n// config handling",
  "src/other.ts": "export const other = 42;",
  "node_modules/faker/ignored.ts": "export {}",
  "dist/bundle.js": "console.log(1)",
  "secrets.env": "KEY=value",
  "notes.log": "debug"
};

describe("ContextLoader (phase 07)", () => {
  it("respects workspace .gitignore layered over built-ins", async () => {
    const ws = await makeFixture({ ...FS, ".gitignore": "secrets.env\n*.log" });
    const loader = createContextLoader({ maxTreeDepth: 3, maxTreeEntries: 500 });

    const ctx = await loader.load(ws, { task: "config" });

    expect(ctx.fileTree).not.toContain("node_modules");
    expect(ctx.fileTree).not.toContain("dist");
    expect(ctx.fileTree).not.toContain("secrets.env");
    expect(ctx.fileTree).not.toContain("notes.log");
    expect(ctx.fileTree).toContain("config.ts");
    expect(ctx.keyFiles).not.toContain("secrets.env");
    expect(ctx.keyFiles).not.toContain("node_modules");
  });

  it("honors ## Ignore sections in AGENTS.md", async () => {
    const ws = await makeFixture({
      ...FS,
      "AGENTS.md": "## Ignore\nprivate/",
      "private/secret.ts": "export const secret = 1"
    });
    const loader = createContextLoader({ maxTreeDepth: 3, maxTreeEntries: 500 });

    const ctx = await loader.load(ws, { task: "config" });
    expect(ctx.fileTree).not.toContain("secret.ts");
    expect(ctx.keyFiles).not.toContain("secret.ts");
  });

  it("ranks task-relevant files above unrelated files", async () => {
    const ws = await makeFixture(FS);
    const loader = createContextLoader({ maxTreeDepth: 3, maxTreeEntries: 500 });

    const ctx = await loader.load(ws, { task: "config" });

    const ranked = Object.entries(ctx.index).sort((a, b) => a[1]!.rank - b[1]!.rank);
    const rankedPaths = ranked.map(([file]) => file);
    expect(rankedPaths.indexOf("src/config.ts")).toBeLessThan(rankedPaths.indexOf("src/other.ts"));
    expect(ctx.keyFiles.indexOf("src/config.ts")).toBeLessThan(ctx.keyFiles.indexOf("src/other.ts"));
    expect(ctx.index["src/config.ts"]!.score).toBeGreaterThan(0);
  });

  it("promotes files imported by task-relevant entrypoints", async () => {
    const ws = await makeFixture({
      "package.json": "{}",
      "src/entry.ts": 'import { helper } from "./helper";\nimport "./unrelated.ts"',
      "src/helper.ts": "export const helper = () => \"impl detail\";",
      "src/unrelated.ts": "export const unrelated = 1;"
    });
    const loader = createContextLoader({ maxTreeDepth: 3, maxTreeEntries: 500 });

    const ctx = await loader.load(ws, { task: "entry" });

    const paths = Object.keys(ctx.index);
    expect(paths).toContain("src/entry.ts");
    expect(ctx.index["src/helper.ts"]!.score).toBeGreaterThan(0);
    const ranked = Object.entries(ctx.index).sort((a, b) => a[1]!.rank - b[1]!.rank);
    expect(ranked.map(([p]) => p).indexOf("src/helper.ts")).toBeLessThan(
      ranked.map(([p]) => p).indexOf("src/unrelated.ts")
    );
  });

  it("caps total context to the budget and flags truncation", async () => {
    const ws = await makeFixture({
      "big.ts": "// " + "x".repeat(2000),
      "bigger.ts": "// " + "y".repeat(2000),
      "tiny.ts": "// small"
    });
    const loader = createContextLoader({ maxTreeDepth: 3, maxTreeEntries: 500, maxContextChars: 500, maxFileChars: 400 });

    const ctx = await loader.load(ws, {});

    expect(ctx.keyFiles.length).toBeLessThanOrEqual(600); // header lines included
    expect(ctx.truncatedFileCount).toBeGreaterThan(0);
    expect(ctx.skippedFiles).toBeGreaterThan(0);
    expect(ctx.maxContextChars).toBe(500);
  });

  it("flags per-file truncation in the index", async () => {
    const ws = await makeFixture({ "config.ts": "// " + "c".repeat(1000) });
    const loader = createContextLoader({ maxFileChars: 200 });

    const ctx = await loader.load(ws, { task: "config" });

    expect(ctx.index["config.ts"]!.truncated).toBe(true);
    expect(ctx.index["config.ts"]!.chars).toBeGreaterThan(0);
    expect(ctx.index["config.ts"]!.chars).toBeLessThan(1000);
  });

  it("marks manifests as part of the index", async () => {
    const ws = await makeFixture(FS);
    const loader = createContextLoader();

    const ctx = await loader.load(ws, {});
    expect(ctx.index["package.json"]).toBeDefined();
    expect(ctx.keyFiles).toContain("package.json");
  });

  it("load() without a task still returns a ranked context", async () => {
    const ws = await makeFixture(FS);
    const loader = createContextLoader();

    const ctx = await loader.load(ws);
    expect(Object.keys(ctx.index).length).toBeGreaterThan(0);
    expect(ctx.fileTree).toContain("src");
  });
});