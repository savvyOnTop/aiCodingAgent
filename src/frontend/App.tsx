import { useEffect, useState } from "react";
import { createSession, forkSession, listBranches, switchBranch, type BranchNodeDto } from "./api";
import { ChatPanel } from "./ChatPanel";
import { FileExplorer } from "./FileExplorer";
import { TerminalPanel } from "./Terminal";
import "./styles.css";

interface BranchOption {
  sessionId: string;
  branchId: string;
}

function flattenBranches(node: BranchNodeDto, out: BranchOption[] = []): BranchOption[] {
  out.push({ sessionId: node.conversation.id, branchId: node.conversation.branchId });
  for (const child of node.children) flattenBranches(child, out);
  return out;
}

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string>("main");
  const [branchOptions, setBranchOptions] = useState<BranchOption[]>([]);
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);

  async function newSession() {
    setBusy(true);
    try {
      const { sessionId, branchId } = await createSession(root.trim() || undefined);
      setSessionId(sessionId);
      setBranchId(branchId ?? "main");
      setRoot("");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshBranches(id: string) {
    try {
      const { tree } = await listBranches(id);
      setBranchOptions(flattenBranches(tree));
    } catch {
      setBranchOptions([]);
    }
  }

  async function forkBranch() {
    if (!sessionId) return;
    setBusy(true);
    try {
      const fork = await forkSession(sessionId);
      setSessionId(fork.sessionId);
      setBranchId(fork.branchId);
      await refreshBranches(fork.sessionId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectBranch(nextBranchId: string) {
    if (!sessionId || nextBranchId === branchId) return;
    setBusy(true);
    try {
      const target = await switchBranch(sessionId, nextBranchId);
      setSessionId(target.sessionId);
      setBranchId(target.branchId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!sessionId) void newSession();
  }, []);

  useEffect(() => {
    if (sessionId) void refreshBranches(sessionId);
  }, [sessionId]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>AI Coding Agent</h1>
        <form
          className="session-form"
          onSubmit={(e) => {
            e.preventDefault();
            void newSession();
          }}
        >
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="Workspace path (default: temp scratch dir)"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            New session
          </button>
        </form>
        {sessionId && (
          <span className="branch-controls">
            <span className="branch-badge" title="Current branch">
              ⎇ {branchId}
            </span>
            {branchOptions.length > 1 && (
              <select
                value={branchId}
                onChange={(e) => void selectBranch(e.target.value)}
                disabled={busy}
              >
                {branchOptions.map((b) => (
                  <option key={b.sessionId} value={b.branchId}>
                    {b.branchId}
                  </option>
                ))}
              </select>
            )}
            <button type="button" onClick={() => void forkBranch()} disabled={busy}>
              Fork
            </button>
          </span>
        )}
        {sessionId && <span className="session-id">session {sessionId.slice(0, 8)}</span>}
      </header>
      {sessionId ? (
        <>
          <main className="app-body">
            <FileExplorer sessionId={sessionId} />
            <ChatPanel sessionId={sessionId} />
          </main>
          <TerminalPanel sessionId={sessionId} />
        </>
      ) : (
        <p className="hint">Creating session…</p>
      )}
    </div>
  );
}
