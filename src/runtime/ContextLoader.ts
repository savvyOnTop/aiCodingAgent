import type { Workspace } from "@ai-coding-agent/types";
import { createIgnoreMatcher, parseIgnoreText, type IgnoreMatcher, type IgnoreRule } from "./IgnoreMatcher";
import { findTransitiveImports, extractImports, resolveModuleCandidates } from "./ImportGraph";

export interface ContextIndexEntry {
  /** 0 = highest relevance. */
  rank: number;
  /** Raw lexical relevance score. */
  score: number;
  /** Characters contributed to the rendered context (after per-file cap). */
  chars: number;
  /** True when the file was cut at the per-file cap. */
  truncated: boolean;
}

export interface LoadedContext {
  fileTree: string;
  keyFiles: string;
  /** File path → ranking metadata; present in the phase 07 loader. */
  index: Record<string, ContextIndexEntry>;
  /** Files excluded by budget (beyond the char cap) or unreadable. */
  skippedFiles: number;
  /** The content budget enforced by this load. */
  maxContextChars: number;
  /** Number of files cut at the per-file cap. */
  truncatedFileCount: number;
}

export interface ContextLoaderOptions {
  maxTreeDepth?: number;
  maxTreeEntries?: number;
  maxFileChars?: number;
  /**
   * Total budget for ranked file content (default 40_000). The shallow file
   * tree does not count against it.
   */
  maxContextChars?: number;
  /**
   * Optional semantic ranker (Phase 06 embeddings). Returned scores are added
   * to the lexical score; without it lexical ranking is used.
   */
  semanticRanker?: { score(query: string, relPath: string, content: string): number };
}

export interface ContextLoadOptions {
  /** The task being planned; drives scope-aware relevance ranking. */
  task?: string;
}

export interface ContextLoader {
  load(workspace: Workspace, options?: ContextLoadOptions): Promise<LoadedContext>;
}

const MAX_TREE_DEPTH = 2;
const MAX_TREE_ENTRIES = 200;
const MAX_FILE_CHARS = 8000;
const MAX_CONTEXT_CHARS = 40_000;

const BUILTIN_IGNORES = [
  "node_modules/",
  ".git/",
  "dist/",
  "coverage/",
  "build/",
  "target/",
  ".next/",
  ".turbo/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".idea/",
  ".DS_Store",
  "*.log"
];

const MANIFEST_FILES = [
  "package.json",
  "README.md",
  "tsconfig.json",
  "AGENTS.md",
  "CLAUDE.md",
  ".env.example",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod"
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "will", "should",
  "make", "using", "fix", "bug", "add", "new", "want", "please", "about", "have",
  "then", "there", "each", "would"
]);

/** Headings that start an ignore-pattern section in AGENTS.md / CLAUDE.md. */
const IGNORE_SECTION_RE = /^##\s+ignore/i;

interface Candidate {
  relPath: string;
  score: number;
  content?: string;
}

/** Extracts ignore sections from AGENTS.md/CLAUDE.md convention files. */
function ignoreLinesFromConvention(text: string | undefined): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (IGNORE_SECTION_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s/.test(line)) break;
    if (inSection && line.trim()) lines.push(line.trim());
  }
  return lines;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t)
  );
}

/**
 * Scope-aware repo comprehension (phase 07). Replaces the shallow tree +
 * manifests loader with a budgeted, task-ranked index that respects built-in
 * and workspace ignore rules (`.gitignore`, recover `## Ignore` sections in
 * AGENTS.md/CLAUDE.md) and promotes files reachable from relevant entrypoints
 * via the import graph.
 */
export function createContextLoader(options: ContextLoaderOptions = {}): ContextLoader {
  const maxTreeDepth = options.maxTreeDepth ?? MAX_TREE_DEPTH;
  const maxTreeEntries = options.maxTreeEntries ?? MAX_TREE_ENTRIES;
  const maxFileChars = options.maxFileChars ?? MAX_FILE_CHARS;
  const maxContextChars = options.maxContextChars ?? MAX_CONTEXT_CHARS;
  const semanticRanker = options.semanticRanker;

  async function buildMatcher(workspace: Workspace): Promise<IgnoreMatcher> {
    const extra: string[] = [];
    for (const file of [".gitignore", "AGENTS.md", "CLAUDE.md"]) {
      try {
        const text = await workspace.readFile(file);
        if (file === ".gitignore") extra.push(...text.split(/\r?\n/));
        else extra.push(...ignoreLinesFromConvention(text));
      } catch {
        // missing file is fine
      }
    }
    return createIgnoreMatcher(parseIgnoreText([...BUILTIN_IGNORES, ...extra]));
  }

  async function load(workspace: Workspace, loadOptions: ContextLoadOptions = {}): Promise<LoadedContext> {
    const taskTokens = new Set(tokenize(loadOptions.task ?? ""));
    const matcher = await buildMatcher(workspace);
    const candidates: Candidate[] = [];
    const treeLines: string[] = [];
    let skippedFiles = 0;

    const walk = async (rel: string, depth: number): Promise<void> => {
      if (treeLines.length >= maxTreeEntries) return;
      let entries;
      try {
        entries = await workspace.listDir(rel);
      } catch {
        return;
      }
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
      );
      for (const entry of entries) {
        if (treeLines.length >= maxTreeEntries) return;
        const relPath = entry.path;
        if (matcher.ignores(relPath, entry.type === "dir")) {
          skippedFiles++;
          continue;
        }
        if (entry.type === "dir") {
          treeLines.push("  ".repeat(depth) + entry.name + "/");
          if (depth < maxTreeDepth) await walk(relPath, depth + 1);
        } else {
          treeLines.push("  ".repeat(depth) + entry.name);
          // Ignore-source files stay in the tree but never in the content
          // budget (their bodies would leak the very patterns being ignored).
          if (entry.name !== ".gitignore") candidates.push({ relPath, score: 0 });
        }
      }
    };

    await walk("", 0);

    // --- ranking -----------------------------------------------------------
    for (const candidate of candidates) {
      const parts = candidate.relPath.split("/");
      const base = parts.at(-1) ?? candidate.relPath;
      let score = 0;
      if (MANIFEST_FILES.includes(base)) score += 6;
      for (const token of base.split(/[^a-z0-9]+/i)) {
        if (token.length >= 3 && taskTokens.has(token.toLowerCase())) score += 10;
      }
      for (const part of parts) {
        const norm = part.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (norm.length >= 3 && taskTokens.has(norm)) score += 2;
      }
      const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
      if (ext && ext.length >= 2 && taskTokens.has(ext)) score += 4;
      candidate.score = score;
    }
    candidates.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

    // --- import-graph promotion --------------------------------------------
    const promoteFromImports = async (): Promise<void> => {
      const seeds = candidates.filter((c) => c.score > 0).slice(0, 12);
      if (seeds.length === 0) return;
      const byPath = new Map(candidates.map((c) => [c.relPath, c]));
      const contents = new Map<string, string>();
      const visited = new Set<string>();
      let frontier: string[] = [];
      for (const seed of seeds) {
        try {
          const content = await workspace.readFile(seed.relPath);
          contents.set(seed.relPath, content);
          if (semanticRanker && loadOptions.task) {
            seed.score += semanticRanker.score(loadOptions.task, seed.relPath, content) * 10;
          }
          visited.add(seed.relPath);
          frontier.push(seed.relPath);
        } catch {
          // unreadable; leave out of the graph
        }
      }
      // BFS over relative imports, reading dependencies lazily from the
      // workspace; only files that survived the ignore walk are followed.
      for (let depth = 0; depth <= 2 && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const fromPath of frontier) {
          const source = contents.get(fromPath);
          if (source === undefined) continue;
          for (const specifier of extractImports(source)) {
            for (const dep of resolveModuleCandidates(fromPath, specifier)) {
              if (visited.has(dep) || !byPath.has(dep)) continue;
              visited.add(dep);
              let content: string;
              try {
                content = await workspace.readFile(dep);
              } catch {
                continue;
              }
              contents.set(dep, content);
              const depCandidate = byPath.get(dep)!;
              if (depCandidate.score <= 0) depCandidate.score = 1;
              next.push(dep);
            }
          }
        }
        frontier = next;
      }
      candidates.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
    };
    await promoteFromImports();

    // --- budgeted content selection ----------------------------------------
    const index: Record<string, ContextIndexEntry> = {};
    const keyFiles: string[] = [];
    let budget = maxContextChars;
    let truncatedFileCount = 0;
    let rank = 0;

    for (const candidate of candidates) {
      if (budget <= 0) {
        skippedFiles++;
        continue;
      }
      let content: string;
      try {
        content = await workspace.readFile(candidate.relPath);
      } catch {
        skippedFiles++;
        continue;
      }
      const raw = content.length;
      const truncated = raw > maxFileChars;
      if (truncated) truncatedFileCount++;
      const used = Math.min(raw, maxFileChars, budget);
      if (used <= 0) {
        skippedFiles++;
        continue;
      }
      const header = `--- ${candidate.relPath} (rank ${rank}${truncated ? `, truncated ${raw - used} chars over` : ""}) ---\n`;
      const body = content.slice(0, used).replace(/\s+$/, "");
      const rendered = header + body + "\n\n";
      keyFiles.push(rendered);
      budget -= rendered.length;
      index[candidate.relPath] = { rank, score: candidate.score, chars: rendered.length, truncated };
      rank++;
    }

    return {
      fileTree: treeLines.join("\n"),
      keyFiles: keyFiles.join(""),
      index,
      skippedFiles,
      maxContextChars,
      truncatedFileCount
    };
  }

  return { load };
}

// Re-exported for callers that want to inspect the graph directly.
export { extractImports, findTransitiveImports, resolveModuleCandidates };
export type { IgnoreRule, IgnoreMatcher };
export { parseIgnoreText, createIgnoreMatcher } from "./IgnoreMatcher";