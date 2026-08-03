import { useCallback, useEffect, useState } from "react";
import { listFiles, type FileEntryDto } from "./api";

interface TreeNode {
  entry: FileEntryDto;
  children?: TreeNode[];
  open: boolean;
  depth: number;
}

export function FileExplorer({ sessionId }: { sessionId: string }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState("");

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
      {error && <p className="error">{error}</p>}
      {tree.map((node, i) => (
        <TreeRow key={node.entry.path} node={node} onToggle={() => void toggle(node, i)} />
      ))}
      {tree.map(
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
