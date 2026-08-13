

/**
 * gitignore-style path matching used by ContextLoader (phase 07).
 *
 * Supported subset of gitignore semantics:
 *   - blank lines and `#` comments are skipped
 *   - `!pattern` negates (last matching rule wins)
 *   - leading `/` anchors the pattern to the workspace root
 *   - trailing `/` restricts the pattern to directories
 *   - `*` matches within a path segment, `**` matches across segments
 *
 * Known simplifications (documented deviations):
 *   - negation does not re-include files under a pruned ignored directory
 *     (the walk never enters an ignored dir)
 *   - a double-star prefix pattern is treated like `.*` (root files match too)
 */

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  anchored: boolean;
  dirOnly: boolean;
  regex: RegExp;
  basenameOnly: boolean;
}

export interface IgnoreMatcher {
  /** True when the path should be excluded from context loading. */
  ignores(relPath: string, isDir?: boolean): boolean;
}

/** Parses .gitignore text (or pre-split lines) into rules; strips comments, blanks, trailing spaces. */
export function parseIgnoreText(text: string | string[]): IgnoreRule[] {
  const lines = Array.isArray(text) ? text : text.split(/\r?\n/);
  return lines
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(compileRule);
}

/** Turns a single ignore line into a compiled rule. */
export function compileRule(line: string): IgnoreRule {
  let pattern = line.trim();
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  if (pattern.length === 0) pattern = ".";

  const hasSlash = pattern.includes("/");
  const basenameOnly = !hasSlash && !anchored;
  return {
    pattern,
    negated,
    anchored,
    dirOnly,
    regex: globToRegex(pattern),
    basenameOnly
  };
}

function segmentToRegex(segment: string): string {
  return segment
    .split("**")
    .map((piece) =>
      piece
        .split("")
        .map((ch) => {
          if (ch === "*") return "[^/]*";
          if (ch === "?") return "[^/]";
          if ("\\^$.|?*+()[]{}".includes(ch)) return `\\${ch}`;
          return ch;
        })
        .join("")
    )
    .join(".*");
}

function globToRegex(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // `**/x` matches x at the root too; trailing `a/**` matches everything under a.
      source += last ? ".*" : "(?:.*/)?";
      return;
    }
    source += segmentToRegex(segment);
    if (!last) source += "/";
  });
  return new RegExp(`^${source}$`);
}

export function createIgnoreMatcher(rules: IgnoreRule[]): IgnoreMatcher {
  function ignores(relPath: string, isDir = false): boolean {
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      const target = rule.basenameOnly
        ? basenameSegment(relPath)
        : relPath.replace(/^\/+/, "");
      if (rule.regex.test(target)) ignored = !rule.negated;
    }
    return ignored;
  }
  return { ignores };
}

function basenameSegment(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  return parts.at(-1) ?? relPath;
}