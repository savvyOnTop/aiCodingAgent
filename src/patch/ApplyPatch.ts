export type DiffLineKind = "ctx" | "del" | "add";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedPatchFile {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeletion: boolean;
  hunks: DiffHunk[];
}

export interface ApplyConflict {
  file: string;
  hunkIndex: number;
  /** 1-based line in the file where the mismatch was detected. */
  line: number;
  /** What the hunk expected at that position. */
  expected: string;
  /** What the file actually contains (may be absent at EOF). */
  actual: string | null;
}

export interface ApplyResult {
  ok: boolean;
  content: string | null;
  conflict: ApplyConflict | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse git-style unified diff text into per-file structures. Handles
 * multiple files, new-file (/dev/null) and deletion hunks. Throws on
 * malformed input so callers can surface a clean error.
 */
export function parsePatch(diffText: string): ParsedPatchFile[] {
  const lines = diffText.split("\n");
  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | null = null;
  let inHunk = false;

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = raw.slice(11).match(/^a\/(.*) b\/(.*)$/);
      current = {
        oldPath: match?.[1] ?? "",
        newPath: match?.[2] ?? "",
        isNew: false,
        isDeletion: false,
        hunks: []
      };
      inHunk = false;
      continue;
    }
    if (raw.startsWith("--- ") && current && !current.hunks.length) {
      current.isNew = raw.slice(4) === "/dev/null";
      continue;
    }
    if (raw.startsWith("+++ ") && current && !current.hunks.length) {
      current.isDeletion = raw.slice(4) === "/dev/null";
      continue;
    }
    const hunkMatch = raw.match(HUNK_RE);
    if (hunkMatch && current) {
      current.hunks.push({
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? 1),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? 1),
        lines: []
      });
      inHunk = true;
      continue;
    }
    if (inHunk && current) {
      const hunk = current.hunks[current.hunks.length - 1]!;
      if (raw === "") {
        continue; // record separator, not a file line (blank lines are " ")
      }
      if (raw.startsWith(" ")) {
        hunk.lines.push({ kind: "ctx", text: raw.slice(1) });
      } else if (raw.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: raw.slice(1) });
      } else if (raw.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: raw.slice(1) });
      } else {
        inHunk = false;
      }
    }
  }
  if (current) files.push(current);

  for (const file of files) {
    let ctx = 0;
    let del = 0;
    let add = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "ctx") ctx++;
        else if (line.kind === "del") del++;
        else add++;
      }
      if (hunk.oldCount !== hunk.lines.filter((l) => l.kind !== "add").length) {
        throw new Error(`Malformed hunk counts in ${file.oldPath}`);
      }
      if (hunk.newCount !== hunk.lines.filter((l) => l.kind !== "del").length) {
        throw new Error(`Malformed hunk counts in ${file.oldPath}`);
      }
    }
    if (del !== file.hunks.reduce((n, h) => n + h.oldCount, 0) - ctx) {
      throw new Error(`Malformed hunk counts in ${file.oldPath}`);
    }
    if (add !== file.hunks.reduce((n, h) => n + h.newCount, 0) - ctx) {
      throw new Error(`Malformed hunk counts in ${file.oldPath}`);
    }
  }
  return files;
}

/**
 * Apply hunks to file content (lines array without trailing newline).
 * Returns the new content on success, or an ApplyConflict describing the
 * first mismatch (position, expected vs actual) on failure.
 */
export function applyHunks(content: string, hunks: DiffHunk[]): ApplyResult {
  let lines = content === "" ? [] : content.split("\n");
  let offset = 0;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex]!;
    let position = hunk.oldStart - 1 + offset;
    if (position < 0) position = 0;

    const output: string[] = [];
    let cursor = position;

    for (const line of hunk.lines) {
      if (line.kind === "ctx" || line.kind === "del") {
        if (lines[cursor] !== line.text) {
          return {
            ok: false,
            content: null,
            conflict: {
              file: "",
              hunkIndex,
              line: cursor + 1,
              expected: line.text,
              actual: lines[cursor] ?? null
            }
          };
        }
        if (line.kind === "del") {
          cursor++;
        } else {
          output.push(lines[cursor]!);
          cursor++;
        }
      } else {
        output.push(line.text);
      }
    }
    lines = [...lines.slice(0, position), ...output, ...lines.slice(cursor)];
    offset += output.length - (cursor - position);
  }

  return { ok: true, content: lines.join("\n"), conflict: null };
}

/**
 * Generate a git-style unified diff between two file contents. Used by the
 * patch engine to capture and to produce patches without shelling to git.
 */
export function createUnifiedDiff(oldContent: string, newContent: string, pathHint = "file"): string {
  const isNew = oldContent === "";
  const isDel = newContent === "";
  if (!isNew && !isDel) {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    if (oldLines.length === newLines.length && oldLines.every((l, i) => l === newLines[i])) return "";
  } else if (isNew && isDel) {
    return "";
  }

  const header = [
    `diff --git a/${pathHint} b/${pathHint}`,
    isNew ? "--- /dev/null" : `--- a/${pathHint}`,
    isDel ? "+++ /dev/null" : `+++ b/${pathHint}`
  ];

  if (isNew) {
    const lines = newContent.split("\n").map((l) => `+${l}`);
    return [...header, `@@ -0,0 +1,${lines.length} @@`, ...lines, ""].join("\n");
  }
  if (isDel) {
    const lines = oldContent.split("\n").map((l) => `-${l}`);
    return [...header, `@@ -1,${lines.length} +0,0 @@`, ...lines, ""].join("\n");
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const hunks: string[] = [];
  const context = 3;
  let i = 0;

  const changed: Array<{ oldIndex: number; newIndex: number; oldLines: string[]; newLines: string[] }> = [];
  while (i < Math.max(oldLines.length, newLines.length)) {
    if (oldLines[i] === newLines[i]) {
      i++;
      continue;
    }
    const blockOld: string[] = [];
    const blockNew: string[] = [];
    while (oldLines[i] !== newLines[i]) {
      if (i < oldLines.length && oldLines[i] !== newLines[i]) blockOld.push(oldLines[i]!);
      if (i < newLines.length && newLines[i] !== oldLines[i]) blockNew.push(newLines[i]!);
      i++;
      if (i >= oldLines.length && i >= newLines.length) break;
    }
    changed.push({
      oldIndex: i - blockOld.length,
      newIndex: i - blockNew.length,
      oldLines: blockOld,
      newLines: blockNew
    });
  }

  // Merge blocks whose context windows would overlap (git-style coalescing),
  // otherwise later hunks would reference already-changed context lines.
  // Each merged block carries ordered entries; unchanged gap lines become ctx.
  type Entry = { kind: "ctx" | "del" | "add"; text: string };
  const merged: Array<{ oldIndex: number; newIndex: number; oldEnd: number; entries: Entry[] }> = [];
  for (const block of changed) {
    const last = merged[merged.length - 1];
    if (last && block.oldIndex - context < last.oldEnd) {
      const gapOld = oldLines.slice(last.oldEnd, block.oldIndex);
      for (const text of gapOld) last.entries.push({ kind: "ctx", text });
      for (const text of block.oldLines) last.entries.push({ kind: "del", text });
      for (const text of block.newLines) last.entries.push({ kind: "add", text });
      last.oldEnd = block.oldIndex + block.oldLines.length;
    } else {
      merged.push({
        oldIndex: block.oldIndex,
        newIndex: block.newIndex,
        oldEnd: block.oldIndex + block.oldLines.length,
        entries: [
          ...block.oldLines.map((t) => ({ kind: "del" as const, text: t })),
          ...block.newLines.map((t) => ({ kind: "add" as const, text: t }))
        ]
      });
    }
  }

  const prefix: Record<Entry["kind"], string> = { ctx: " ", del: "-", add: "+" };
  for (const block of merged) {
    const start = Math.max(0, block.oldIndex - context);
    const before = oldLines.slice(start, block.oldIndex);
    const trailing = oldLines.slice(block.oldEnd, block.oldEnd + context);

    const lines = [
      ...before.map((l) => ` ${l}`),
      ...block.entries.map((e) => `${prefix[e.kind]}${e.text}`),
      ...trailing.map((l) => ` ${l}`)
    ];
    const oldCount = lines.filter((l) => l[0] !== "+").length;
    const newCount = lines.filter((l) => l[0] !== "-").length;
    hunks.push(`@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`, ...lines);
  }

  return [...header, ...hunks, ""].join("\n");
}
