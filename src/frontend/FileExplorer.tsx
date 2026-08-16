import { useCallback, useEffect, useState } from "react";
import { listFiles, searchFiles, type FileEntryDto, type SearchMatchDto } from "./api";

interface TreeNode {
  entry: FileEntryDto;
  children?: TreeNode[];
  open: boolean;
  depth: number;
}

export function FileExplorer({ sessionId }: { sessionId: string }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchMatchDto[] | null>(null);

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    try {
      const { matches } = await searchFiles(sessionId, q);
      setResults(matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const load = useCallback(
    async (path: string) => {
      try {
        const { entries } = await listFiles(sessionId, path);
        return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return [];
      }
    },
    [sessionId]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await load("");
      if (!cancelled) {
        setTree(entries.map((entry) => ({ entry, open: false, depth: 0 })));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function toggle(node: TreeNode, index: number) {
    if (node.entry.type !== "dir") return;
    const next = [...tree];
    if (!node.children) {
      const children = await load(node.entry.path);
      next[index] = { ...node, children: children.map((entry) => ({ entry, open: false, depth: node.depth + 1 })), open: true };
    } else {
      next[index] = { ...node, open: !node.open };
    }
    setTree(next);
  }

  async function toggleChild(parent: TreeNode, childIndex: number) {
    const child = parent.children?.[childIndex];
    if (!child || child.entry.type !== "dir") return;
    if (!child.children) {
      const children = await load(child.entry.path);
      child.children = children.map((entry) => ({ entry, open: false, depth: child.depth + 1 }));
    }
    child.open = !child.open;
    setTree([...tree]);
  }

  return (
    <aside className="files">
      <h3>Files</h3>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search code…"
        />
      </form>
      {error && <p className="error">{error}</p>}
      {results !== null && (
        <div className="search-results">
          <div className="search-results-head">
            <span>{results.length} results</span>
            <button
              type="button"
              onClick={() => {
                setResults(null);
                setQuery("");
              }}
            >
              ✕
            </button>
          </div>
          {results.map((m, i) => (
            <div key={`${m.file}:${m.line}:${i}`} className="search-hit" title={m.text}>
              <span className="search-hit-loc">
                {m.file}:{m.line}
              </span>
              <span className="search-hit-text">{m.text.trim()}</span>
            </div>
          ))}
        </div>
      )}
      {results === null && tree.map((node, i) => (
        <TreeRow key={node.entry.path} node={node} onToggle={() => void toggle(node, i)} />
      ))}
      {results === null && tree.map(
        (node) =>
          node.open &&
          node.children?.map((child, ci) => (
            <div key={child.entry.path}>
              <TreeRow node={child} onToggle={() => void toggleChild(node, ci)} />
              {child.open &&
                child.children?.map((grand, gi) => (
                  <TreeRow key={grand.entry.path} node={grand} onToggle={() => void toggleChild(child, gi)} />
                ))}
            </div>
          ))
      )}
    </aside>
  );
}

function TreeRow({ node, onToggle }: { node: TreeNode; onToggle: () => void }) {
  const pad = { paddingLeft: `${node.depth * 14 + 6}px` };
  if (node.entry.type === "dir") {
    return (
      <button className="tree-dir" style={pad} onClick={onToggle}>
        {node.open ? "▼ " : "▶ "} {node.entry.name}/
      </button>
    );
  }
  return (
    <div className="tree-file" style={pad}>
      {node.entry.name}
    </div>
  );
}
