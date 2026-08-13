import path from "path";

/**
 * Static import/require graph over workspace sources (phase 07). Used by
 * ContextLoader to promote files that the task-relevant entrypoints depend on.
 */

const IMPORT_FROM_RE = /from\s+["']([^"']+)["']/g;
const IMPORT_SIDE_EFFECT_RE = /\bimport\s+["']([^"']+)["']/g;
const IMPORT_DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

const DEFAULT_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Extracts every module specifier referenced by `source`. */
export function extractImports(source: string): string[] {
  const seen = new Set<string>();
  const add = (specifier: string) => {
    if (specifier.length > 0 && !specifier.startsWith("node:")) seen.add(specifier);
  };
  for (const re of [IMPORT_FROM_RE, IMPORT_SIDE_EFFECT_RE, IMPORT_DYNAMIC_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) add(match[1]!);
  }
  return [...seen];
}

/** Resolves a relative specifier to a normalized workspace path (or undefined for bare specs). */
export function resolveModulePath(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const fromDir = path.posix.dirname(fromPath);
  return path.posix.normalize(path.posix.join(fromDir, specifier));
}

/** Candidate paths a specifier could resolve to (extension probing happens here). */
export function resolveModuleCandidates(fromPath: string, specifier: string): string[] {
  const resolved = resolveModulePath(fromPath, specifier);
  if (!resolved) return [];
  const out: string[] = [];
  for (const ext of DEFAULT_EXTS) {
    out.push(resolved + ext);
    out.push(path.posix.join(resolved, `index${ext}`));
  }
  out.push(resolved);
  return out;
}

/**
 * Breadth-first walk over the provided file map starting from `seed`, following
 * only relative imports that resolve to known files. Cycle-safe; bare
 * specifiers (node_modules, built-ins) are ignored. `maxDepth` is the inclusive
 * import distance from the seed, where 0 = the seed's direct imports.
 */
export function findTransitiveImports(
  files: Map<string, string>,
  seed: string,
  maxDepth = 8
): string[] {
  const visited = new Set<string>([seed]);
  const order: string[] = [];
  let frontier = [seed];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const fromPath of frontier) {
      const source = files.get(fromPath);
      if (source === undefined) continue;
      for (const specifier of extractImports(source)) {
        for (const candidate of resolveModuleCandidates(fromPath, specifier)) {
          if (!visited.has(candidate) && files.has(candidate)) {
            visited.add(candidate);
            order.push(candidate);
            next.push(candidate);
          }
        }
      }
    }
    frontier = next;
  }
  return order;
}