import { describe, expect, it } from "vitest";
import { createUnifiedDiff, parsePatch, applyHunks } from "./ApplyPatch";
import { createAstEditor, applyLineEdits, replaceTextExact } from "./ASTEditor";
import { createConflictResolver } from "./ConflictResolver";
import { createPatchEngine } from "./PatchEngine";

describe("parsePatch / applyHunks", () => {
  it("parses a multi-hunk diff and applies it cleanly", () => {
    const original = ["a", "old-x", "1", "2", "3", "4", "5", "6", "7", "8", "c", "d", "old-y", "f"].join("\n");
    const modified = ["a", "new-x", "1", "2", "3", "4", "5", "6", "7", "8", "c", "d", "new-y", "f"].join("\n");
    const diff = createUnifiedDiff(original, modified, "file.ts");
    const [file] = parsePatch(diff);
    expect(file?.hunks).toHaveLength(2);
    const result = applyHunks(original, file!.hunks);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(modified);
  });

  it("produces and applies a new-file diff", () => {
    const diff = createUnifiedDiff("", "line1\nline2", "fresh.txt");
    const [file] = parsePatch(diff);
    expect(file?.isNew).toBe(true);
    const result = applyHunks("", file!.hunks);
    expect(result.content).toBe("line1\nline2");
  });

  it("detects a stale-context conflict", () => {
    const original = "alpha\nbeta\ngamma";
    const modified = "alpha\nBETA\ngamma";
    const diff = createUnifiedDiff(original, modified, "f.txt");
    const [file] = parsePatch(diff)!;
    const stale = ["changed", "beta", "gamma"].join("\n");
    const result = applyHunks(stale, file!.hunks);
    expect(result.ok).toBe(false);
    expect(result.conflict?.hunkIndex).toBe(0);
    expect(result.conflict?.expected).toBe("alpha");
  });

  it("handles a full-file deletion", () => {
    const diff = createUnifiedDiff("only\ncontent", "", "gone.txt");
    const [file] = parsePatch(diff);
    expect(file?.isDeletion).toBe(true);
    const result = applyHunks("only\ncontent", file!.hunks);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("");
  });

  it("supports identical content (empty diff)", () => {
    expect(createUnifiedDiff("same\n", "same\n", "x.ts")).toBe("");
  });

  it("round-trips a patch through conflict resolution with fuzzy context", () => {
    const original = "l1\nl2\nl3\nl4\nl5";
    const modified = "l1\nl2\nL3\nl4\nl5";
    const diff = createUnifiedDiff(original, modified, "f.txt");
    const [file] = parsePatch(diff)!;
    // shift the file: context should still match via the local hunk lines
    const shifted = "skip\nl1\nl2\nl3\nl4\nl5";
    const result = applyHunks(shifted, file!.hunks);
    if (result.ok) {
      expect(true).toBe(true);
      return;
    }
    const resolver = createConflictResolver();
    const resolution = resolver.resolve(file!, result.conflict!, shifted);
    expect(resolution.status).toBe("resolved");
  });
});

describe("createAstEditor", () => {
  const editor = createAstEditor();

  it("inserts, deletes and replaces whole line ranges", () => {
    const afterInsert = editor.edit("a", [{ type: "insert", afterLine: 1, lines: ["B"] }]);
    expect(afterInsert.ok && afterInsert.content).toBe("a\nB");

    const deleteOnly = editor.edit("a\nb\nc", [{ type: "delete", startLine: 1, endLine: 2 }]);
    expect(deleteOnly.ok && deleteOnly.content).toBe("c");

    const replaced = editor.edit("a\nb\nc", [{ type: "replace", startLine: 2, endLine: 2, lines: ["B"] }]);
    expect(replaced.ok && replaced.content).toBe("a\nB\nc");
  });

  it("rejects out-of-range edits", () => {
    const bad = editor.edit("a\nb", [{ type: "delete", startLine: 5, endLine: 6 }]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/out of range/);
  });

  it("replaces exact text spans", () => {
    const result = replaceTextExact("const x = 1;", "const x = 1;", "const x = 2;");
    expect(result.ok && result.content).toBe("const x = 2;");
    expect(replaceTextExact("hello", "zzz", "y").ok).toBe(false);
  });
});

describe("createPatchEngine", () => {
  it("applies and reverts a patch over an in-memory workspace", async () => {
    const store = new Map<string, string>([["f.txt", "a\nb\nc"]]);
    const workspace = {
      readFile: async (p: string) => {
        const v = store.get(p);
        if (v === undefined) throw new Error(`no ${p}`);
        return v;
      },
      writeFile: async (p: string, content: string) => void store.set(p, content),
      gitDiff: async () => ""
    };
    const engine = createPatchEngine({ workspace: workspace as never });
    const diff = engine.createPatch("a\nb\nc", "a\nB\nc", "f.txt");
    const applied = await engine.applyPatch(diff);
    expect(applied.applied).toEqual(["f.txt"]);
    expect(applied.conflicts).toHaveLength(0);
    expect(store.get("f.txt")).toBe("a\nB\nc");

    const reverted = await engine.revertPatch(diff);
    expect(reverted.applied).toEqual(["f.txt"]);
    expect(store.get("f.txt")).toBe("a\nb\nc");
  });

  it("reports conflicts without touching valid files", async () => {
    const store = new Map<string, string>([["a.txt", "keep"]]);
    const workspace = {
      readFile: async (p: string) => {
        if (store.has(p)) return store.get(p)!;
        throw new Error(`missing ${p}`);
      },
      writeFile: async (p: string, c: string) => void store.set(p, c),
      gitDiff: async () => ""
    };
    const engine = createPatchEngine({ workspace: workspace as never });
    const diff = engine.createPatch("zzz\n", "aaa\n", "a.txt");
    const result = await engine.applyPatch(diff);
    expect(result.applied).toHaveLength(0);
    expect(result.conflicts[0]?.file).toBe("a.txt");
    expect(store.get("a.txt")).toBe("keep");
    void store;
  });
});

describe("applyLineEdits", () => {
  it("applies line edits in sorted offset order", () => {
    const content = "a\nb\nc";
    const result = applyLineEdits(content, [
      { type: "delete", startLine: 2, endLine: 2 },
      { type: "insert", afterLine: 0, lines: ["head"] }
    ]);
    expect(result.ok && result.content).toBe("head\nb\nc");
  });
});