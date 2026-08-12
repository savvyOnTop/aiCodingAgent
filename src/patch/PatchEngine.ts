import type { Workspace } from "@ai-coding-agent/types";
import { applyHunks, createUnifiedDiff, parsePatch, type ParsedPatchFile } from "./ApplyPatch";
import { createAstEditor, type AstEditor } from "./ASTEditor";
import { createConflictResolver, type ConflictResolver } from "./ConflictResolver";

export interface PatchConflict {
  file: string;
  hunkIndex: number;
  line: number;
  expected: string;
  actual: string | null;
}

export interface PatchResult {
  applied: string[];
  conflicts: PatchConflict[];
}

export interface PatchEngineOptions {
  workspace: Workspace;
  astEditor?: AstEditor;
  conflictResolver?: ConflictResolver;
}

export interface PatchEngine {
  /** git diff of the workspace (via workspace.gitDiff). */
  capturePatch(): Promise<string>;
  /** A git-style unified diff between two given contents. */
  createPatch(oldContent: string, newContent: string, pathHint?: string): string;
  /** Dry-run: verify a patch text applies cleanly to the current files. */
  validatePatch(diffText: string): Promise<PatchResult>;
  /** Apply a patch text to the workspace, resolving hunk conflicts. */
  applyPatch(diffText: string): Promise<PatchResult>;
  /** Apply the reverse (swap + and -) of a patch text. */
  revertPatch(diffText: string): Promise<PatchResult>;
  /** Structural line-editor used for model-authored edits. */
  editor: AstEditor;
}

/**
 * PatchEngine as a factory function: applies git-style unified diffs to the
 * workspace's files, verifying context before every write. A mismatched hunk
 * is handed to the ConflictResolver (fuzzy re-apply); unresolvable conflicts
 * are reported per file without disturbing other files.
 */
export function createPatchEngine(options: PatchEngineOptions): PatchEngine {
  const { workspace } = options;
  const editor = options.astEditor ?? createAstEditor();
  const conflictResolver = options.conflictResolver ?? createConflictResolver();

  async function capturePatch(): Promise<string> {
    return workspace.gitDiff();
  }

  function createPatch(oldContent: string, newContent: string, pathHint = "file"): string {
    return createUnifiedDiff(oldContent, newContent, pathHint);
  }

  async function validatePatch(diffText: string): Promise<PatchResult> {
    return applyPatches(diffText, true);
  }

  async function applyPatch(diffText: string): Promise<PatchResult> {
    return applyPatches(diffText, false);
  }

  async function revertPatch(diffText: string): Promise<PatchResult> {
    return applyPatches(reverseDiffText(diffText), false);
  }

  async function applyPatches(diffText: string, dryRun: boolean): Promise<PatchResult> {
    const result: PatchResult = { applied: [], conflicts: [] };
    let parsed: ParsedPatchFile[];
    try {
      parsed = parsePatch(diffText);
    } catch (err) {
      result.conflicts.push({
        file: "patch",
        hunkIndex: 0,
        line: 0,
        expected: "well-formed unified diff",
        actual: err instanceof Error ? err.message : String(err)
      });
      return result;
    }

    for (const file of parsed) {
      const applyWith = (content: string) => applyHunks(content, file.hunks);
      let current: string;
      if (file.isNew) {
        current = "";
      } else {
        try {
          current = await workspace.readFile(file.oldPath);
        } catch {
          result.conflicts.push({
            file: pathLabel(file),
            hunkIndex: 0,
            line: 0,
            expected: file.oldPath,
            actual: "file does not exist"
          });
          continue;
        }
      }

      const applied = applyWith(current);
      if (applied.ok) {
        if (!dryRun) await workspace.writeFile(pathLabel(file), applied.content!);
        result.applied.push(pathLabel(file));
        continue;
      }

      const resolution = conflictResolver.resolve(file, applied.conflict!, current);
      if (resolution.status === "resolved") {
        if (!dryRun) await workspace.writeFile(pathLabel(file), resolution.content!);
        result.applied.push(pathLabel(file));
      } else {
        result.conflicts.push({
          file: pathLabel(file),
          hunkIndex: applied.conflict!.hunkIndex,
          line: applied.conflict!.line,
          expected: applied.conflict!.expected,
          actual: applied.conflict!.actual
        });
      }
    }
    return result;
  }

  return { capturePatch, createPatch, validatePatch, applyPatch, revertPatch, editor };
}

function pathLabel(file: { oldPath: string; newPath: string }): string {
  return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
}

function reverseDiffText(diffText: string): string {
  return diffText
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return `-${line.slice(1)}`;
      if (line.startsWith("-")) return `+${line.slice(1)}`;
      return line;
    })
    .join("\n");
}