import { describe, expect, it } from "vitest";
import { extractImports, findTransitiveImports, resolveModuleCandidates } from "./ImportGraph";

describe("extractImports", () => {
  it("finds named, default, side-effect, dynamic, and require imports", () => {
    const source = `
import { a } from "./a";
import def from "../lib/b";
import "./polyfill";
import type { T } from "@types/x";
const c = require("./c");
const d = import("./d");
`;
    expect(extractImports(source).sort()).toEqual([
      "../lib/b",
      "./a",
      "./c",
      "./d",
      "./polyfill",
      "@types/x"
    ]);
  });

  it("skips node: builtins", () => {
    expect(extractImports('import fs from "node:fs"')).toEqual([]);
  });
});

describe("resolveModuleCandidates", () => {
  it("probes extensions and index files for relative specifiers", () => {
    const candidates = resolveModuleCandidates("src/main.ts", "./util");
    expect(candidates).toContain("src/util.ts");
    expect(candidates).toContain("src/util/index.ts");
  });

  it("returns nothing for bare specifiers", () => {
    expect(resolveModuleCandidates("src/main.ts", "react")).toEqual([]);
  });
});

describe("findTransitiveImports", () => {
  it("walks transitive, cycle-safe imports in BFS order", () => {
    const files = new Map<string, string>([
      ["src/a.ts", 'import { b } from "./b";\nimport { c } from "./c";'],
      ["src/b.ts", 'import { c } from "./c";'],
      ["src/c.ts", 'import { b } from "./b"; // cycle'],
      ["src/unused.ts", "export const x = 1"]
    ]);

    expect(findTransitiveImports(files, "src/a.ts")).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("respects the depth cap", () => {
    const files = new Map<string, string>([
      ["a.ts", 'import "./b"'],
      ["b.ts", 'import "./c"'],
      ["c.ts", 'import "./d"'],
      ["d.ts", 'import "./e"'],
      ["e.ts", ""]
    ]);
    const order = findTransitiveImports(files, "a.ts", 2);
    expect(order).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(order).not.toContain("e.ts");
  });

  it("ignores bare specifiers and missing files", () => {
    const files = new Map<string, string>([
      ["a.ts", 'import "react";\nimport { x } from "./missing";']
    ]);
    expect(findTransitiveImports(files, "a.ts")).toEqual([]);
  });
});