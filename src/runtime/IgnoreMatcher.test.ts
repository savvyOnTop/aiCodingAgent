import { describe, expect, it } from "vitest";
import { createIgnoreMatcher, parseIgnoreText } from "./IgnoreMatcher";

function matcher(lines: string[]) {
  return createIgnoreMatcher(parseIgnoreText(lines));
}

describe("parseIgnoreText", () => {
  it("strips comments, blanks, and trailing spaces", () => {
    const rules = parseIgnoreText(["# comment", "", "  dist/  ", "node_modules/"]);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.pattern).toBe("dist");
    expect(rules[0]!.dirOnly).toBe(true);
    expect(rules[1]!.dirOnly).toBe(true);
  });

  it("parses negation and anchoring flags", () => {
    const rules = parseIgnoreText(["!keep.log", "/root-only.txt"]);
    expect(rules[0]!.negated).toBe(true);
    expect(rules[1]!.anchored).toBe(true);
  });
});

describe("createIgnoreMatcher", () => {
  it("ignores built-in style directory patterns at any depth", () => {
    const m = matcher(["node_modules/"]);
    expect(m.ignores("node_modules", true)).toBe(true);
    expect(m.ignores("a/b/node_modules", true)).toBe(true);
    expect(m.ignores("src/index.ts", false)).toBe(false);
  });

  it("ignores unanchored file patterns by basename at any depth", () => {
    const m = matcher(["*.log", "secrets.env"]);
    expect(m.ignores("notes.log", false)).toBe(true);
    expect(m.ignores("deep/nested/notes.log", false)).toBe(true);
    expect(m.ignores("secrets.env", false)).toBe(true);
    expect(m.ignores("deep/secrets.env", false)).toBe(true);
  });

  it("anchored patterns only match at the root", () => {
    const m = matcher(["/docs/"]);
    expect(m.ignores("docs", true)).toBe(true);
    expect(m.ignores("src/docs", true)).toBe(false);
  });

  it("matches slashed patterns against the full relative path", () => {
    const m = matcher(["generated/schema.ts"]);
    expect(m.ignores("generated/schema.ts", false)).toBe(true);
    expect(m.ignores("src/generated/schema.ts", false)).toBe(false);
  });

  it("supports ** across segments", () => {
    const m = matcher(["**/fixtures/"]);
    expect(m.ignores("fixtures", true)).toBe(true);
    expect(m.ignores("a/b/fixtures", true)).toBe(true);
  });

  it("last matching rule wins and negation un-ignores", () => {
    const m = matcher(["*.log", "!keep.log"]);
    expect(m.ignores("debug.log", false)).toBe(true);
    expect(m.ignores("keep.log", false)).toBe(false);
  });

  it("directory-only patterns do not ignore plain files", () => {
    const m = matcher(["build/"]);
    expect(m.ignores("build", true)).toBe(true);
    expect(m.ignores("build", false)).toBe(false);
  });
});