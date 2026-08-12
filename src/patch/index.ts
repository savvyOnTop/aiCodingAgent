export {
  parsePatch,
  applyHunks,
  createUnifiedDiff,
  type DiffLine,
  type DiffLineKind,
  type DiffHunk,
  type ParsedPatchFile,
  type ApplyConflict,
  type ApplyResult
} from "./ApplyPatch";
export {
  createAstEditor,
  applyLineEdits,
  replaceTextExact,
  type AstEditor,
  type LineEdit,
  type EditResult
} from "./ASTEditor";
export {
  createConflictResolver,
  type ConflictResolver,
  type Resolution,
  type ResolverOptions
} from "./ConflictResolver";
export {
  createPatchEngine,
  type PatchEngine,
  type PatchEngineOptions,
  type PatchResult,
  type PatchConflict
} from "./PatchEngine";
