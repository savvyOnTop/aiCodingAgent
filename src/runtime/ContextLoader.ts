import type { Workspace } from "@ai-coding-agent/types";

export interface LoadedContext {
  fileTree: string;
  keyFiles: string;
}

export interface ContextLoaderOptions {
  maxTreeDepth?: number;
  maxTreeEntries?: number;
  maxFileChars?: number;
}

export interface ContextLoader {
  load(workspace: Workspace): Promise<LoadedContext>;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".venv", "venv"]);
const KEY_FILES = [
  "package.json",
  "README.md",
  "tsconfig.json",
  "AGENTS.md",
  "CLAUDE.md",
  ".env.example",
  "Cargo.toml",
  "pyproject.toml"
];
const MAX_FILE_CHARS = 8000;

/**
 * Collects a shallow file tree and the most relevant manifest/docs files
 * from the workspace so the model sees repository structure without loading
 * the whole codebase (deep context loading is a later milestone).
 */
export function createContextLoader(options: ContextLoaderOptions = {}): ContextLoader {
  const maxTreeDepth = options.maxTreeDepth ?? 2;
  const maxTreeEntries = options.maxTreeEntries ?? 200;

  async function load(workspace: Workspace): Promise<LoadedContext> {
    const treeLines: string[] = [];
    const keyFiles: string[] = [];
    let totalChars = 0;

    const walk = async (rel: string, depth: number): Promise<void> => {
      if (treeLines.length >= maxTreeEntries) return;
      let entries;
      try {
        entries = await workspace.listDir(rel);
      } catch {
        return;
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      for (const e of entries) {
        if (treeLines.length >= maxTreeEntries) return;
        if (e.type === "dir") {
          if (IGNORED_DIRS.has(e.name)) continue;
          treeLines.push("  ".repeat(depth) + e.name + "/");
          if (depth < maxTreeDepth) await walk(e.path, depth + 1);
        } else {
          treeLines.push("  ".repeat(depth) + e.name);
          if (depth === 0 && KEY_FILES.includes(e.name) && totalChars < maxTreeEntries * 1200) {
            try {
              const content = await workspace.readFile(e.path);
              const capped = content.slice(0, MAX_FILE_CHARS);
              keyFiles.push(`--- ${e.path} ---\n${capped}`);
              totalChars += capped.length;
            } catch {
              // unreadable file, skip
            }
          }
        }
      }
    };

    await walk("", 0);
    return { fileTree: treeLines.join("\n"), keyFiles: keyFiles.join("\n\n") };
  }

  return { load };
}
