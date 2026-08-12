import { applyHunks, type ApplyConflict, type DiffHunk, type ParsedPatchFile } from "./ApplyPatch";

export interface ResolverOptions {
  /** Drop up to this many leading context lines when retrying a hunk. */
  fuzz: number;
  /** Search window (± lines) around the original hunk position. */
  searchWindow: number;
}

export interface Resolution {
  status: "resolved" | "unresolved";
  content: string | null;
  /** Explanatory message; includes the conflict location when unresolved. */
  detail: string;
}

export interface ConflictResolver {
  /** Retry the hunks of a single file against fresh content with fuzzy context. */
  resolve(patchFile: ParsedPatchFile, conflict: ApplyConflict, content: string): Resolution;
}

/**
 * ConflictResolver as a factory function: when a hunk's context does not
 * match the current file, retry it with (a) a positional search window and
 * (b) up to `fuzz` leading context lines dropped, so small edits or inserted
 * lines near the change do not fail the whole patch. A local match keeps the
 * patch alive; otherwise the conflict is reported with its location.
 */
export function createConflictResolver(options: ResolverOptions = { fuzz: 2, searchWindow: 6 }): ConflictResolver {
  function resolve(patchFile: ParsedPatchFile, conflict: ApplyConflict, content: string): Resolution {
    if (!patchFile.hunks[conflict.hunkIndex]) {
      return { status: "unresolved", content: null, detail: `unknown hunk ${conflict.hunkIndex}` };
    }

    for (let fuzz = 0; fuzz <= options.fuzz; fuzz++) {
      const candidate = fuzz === 0 ? patchFile.hunks[conflict.hunkIndex]! : stripLeadingContext(patchFile.hunks[conflict.hunkIndex]!, fuzz);
      if (candidate.lines.length === 0) break;
      for (let delta = -options.searchWindow; delta <= options.searchWindow; delta++) {
        const shifted = patchFile.hunks.map((h, hIndex) =>
          hIndex === conflict.hunkIndex
            ? { ...candidate, oldStart: candidate.oldStart + delta, newStart: candidate.newStart + delta }
            : h
        );
        const result = applyHunks(content, shifted);
        if (result.ok) {
          const why =
            delta !== 0 && fuzz === 0
              ? `reapplied hunk ${conflict.hunkIndex + 1} at a shifted position (+${delta})`
              : delta !== 0
                ? `reapplied hunk ${conflict.hunkIndex + 1} ${fuzz} context line(s) dropped, shifted +${delta}`
                : `reapplied hunk ${conflict.hunkIndex + 1} with ${fuzz} leading context line(s) dropped`;
          return { status: "resolved", content: result.content!, detail: why };
        }
      }
    }
    return {
      status: "unresolved",
      content: null,
      detail: `conflict at hunk ${conflict.hunkIndex + 1} near line ${conflict.line}: expected "${conflict.expected}", found "${conflict.actual ?? "<eof>"}"`
    };
  }
  return { resolve };
}

function stripLeadingContext(hunk: DiffHunk, fuzz: number): DiffHunk {
  let index = 0;
  let dropped = 0;
  while (index < hunk.lines.length && dropped < fuzz) {
    if (hunk.lines[index]!.kind === "ctx") {
      dropped++;
      index++;
    } else {
      break;
    }
  }
  const remaining = hunk.lines.slice(index);
  return {
    oldStart: hunk.oldStart + index,
    oldCount: remaining.filter((l) => l.kind !== "add").length,
    newStart: hunk.newStart + index,
    newCount: remaining.filter((l) => l.kind !== "del").length,
    lines: remaining
  };
}
