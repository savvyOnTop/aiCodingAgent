export type LineEdit =
  | { type: "insert"; afterLine: number; lines: string[] }
  | { type: "delete"; startLine: number; endLine: number }
  | { type: "replace"; startLine: number; endLine: number; lines: string[] };

export interface EditResult {
  ok: boolean;
  content: string | null;
  error: string | null;
}

function lineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

function toLines(content: string): string[] {
  return content === "" ? [] : content.split("\n");
}

function fromLines(lines: string[]): string {
  return lines.join("\n");
}

/** Apply a batch of line edits to content; all offsets are 1-based inclusive. */
export function applyLineEdits(content: string, edits: LineEdit[]): EditResult {
  let lines = toLines(content);
  const count = lineCount(content);
  const sorted = [...edits].sort((a, b) => editKey(a) - editKey(b));

  for (const edit of sorted) {
    if (edit.type === "insert") {
      if (edit.afterLine < 0 || edit.afterLine > lines.length) {
        return { ok: false, content: null, error: `insert after line ${edit.afterLine} out of range (1..${count})` };
      }
      lines = [...lines.slice(0, edit.afterLine), ...edit.lines, ...lines.slice(edit.afterLine)];
      continue;
    }
    if (edit.type === "delete") {
      if (edit.startLine < 1 || edit.endLine > lines.length || edit.startLine > edit.endLine) {
        return { ok: false, content: null, error: `delete ${edit.startLine}..${edit.endLine} out of range (1..${count})` };
      }
      lines = [...lines.slice(0, edit.startLine - 1), ...lines.slice(edit.endLine)];
      continue;
    }
    if (edit.startLine < 1 || edit.endLine > lines.length || edit.startLine > edit.endLine) {
      return { ok: false, content: null, error: `replace ${edit.startLine}..${edit.endLine} out of range (1..${count})` };
    }
    lines = [...lines.slice(0, edit.startLine - 1), ...edit.lines, ...lines.slice(edit.endLine)];
  }

  return { ok: true, content: fromLines(lines), error: null };
}

function editKey(edit: LineEdit): number {
  return edit.type === "insert" ? edit.afterLine * 2 : edit.startLine * 2 - 1;
}

/** Replace the first exact (non-overlapping) occurrence of `find` in content. */
export function replaceTextExact(content: string, find: string, replace: string): EditResult {
  if (find === "") return { ok: false, content: null, error: "empty search text" };
  const index = content.indexOf(find);
  if (index === -1) return { ok: false, content: null, error: `text not found: ${find.slice(0, 60)}` };
  return { ok: true, content: content.slice(0, index) + replace + content.slice(index + find.length), error: null };
}

export interface AstEditor {
  edit(content: string, edits: LineEdit[]): EditResult;
  replace(content: string, find: string, replace: string): EditResult;
}

/**
 * ASTEditor as a factory function: line/block-based structural edits plus
 * exact-text replacement, with bounds checking and deterministic errors.
 * Named for the HLD layer; the edit primitives are text-level, not full
 * parser-based, so they are predictable for model-generated offsets.
 */
export function createAstEditor(): AstEditor {
  return {
    edit: applyLineEdits,
    replace: replaceTextExact
  };
}
